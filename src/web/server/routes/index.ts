import { FastifyInstance } from 'fastify';
import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import {
  ConfigManager,
  KeywordData,
  PlatformCredentials,
  PlatformCategory,
  SchedulerConfig,
  PostContent,
  PlatformPostContent,
} from '@core/interfaces';
import type { AffiliateRegistry } from '@affiliates/registry';
import type { CronScheduler } from '@scheduler/CronScheduler';
import type { JobQueueImpl, PublishedPostRow } from '@scheduler/JobQueue';
import type { PlatformRegistry } from '@platforms/registry';
import type { BlogInfo } from '../../shared/types';
import {
  ContentGenerator,
  LLM_PROVIDERS,
  resolveLlmConfigFromConfigManager,
  resolveLlmValidateConfig,
  type ContentGeneratorConfig,
} from '@content/ContentGenerator';
import { fetchLlmModels } from '@content/LlmModels';
import { createTemplateEngine, registerBuiltinTemplateHelpers } from '@content/TemplateEngine';
import {
  resolveImageGenerator,
  resolveGeminiImageConfig,
  generateImagesSafely,
} from '@content/ImageGenerator';
import { buildSectionImageSpecs } from '@content/imagePrompts';
import { createPostAssembler } from '@content/PostAssembler';
import { expandCoupangWidgetsReport } from '@content/CoupangWidgets';
import { buildPublishPreviewHtml, rewriteLocalImageSrcsForWeb } from '@content/PublishPreview';
import {
  fillCtaAffiliateUrl,
  liftWidgetMarkers,
  resolveCtaAffiliateUrl,
} from '@content/WidgetPlacement';
import { COUPANG_WIDGET_KINDS, type CoupangWidgetKind } from '@content/CoupangWidgets';
import {
  collectOfflineAdCards,
  fetchLinkPreviewCards,
  stylePublishHtml,
} from '@content/CoupangPreview';
import { collectWidgetCardsReport } from '@content/PartnersWidget';
import { matchAds } from '@content/AdMatcher';
import { planAdSlots } from '@content/AdPlacement';
import { ensureDisclosure } from '@content/Disclosure';
import {
  checkAdGate,
  checkAdLinks,
  checkPublishStructure,
  collectPlacedAdIds,
  deriveAdSlots,
} from '@content/AdGate';
import { DEFAULT_AD_POLICY, type AdItem, type AdPolicy, type AdSlot } from '@content/AdTypes';
import {
  addInventoryFromPaste,
  getInventoryItem,
  listInventory,
  removeInventory,
  recordInventoryCheck,
} from '@affiliates/AdInventory';
import { findRecentlyPublishedRssItem } from '../../../platforms/naver/NaverRss';
import { generateDraftFromKeyword } from '@content/KeywordPostGenerator';
import {
  savePostFiles,
  readPostFiles,
  listDrafts,
  updatePostMeta,
  deleteDraftFiles,
  failStaleGeneratingDrafts,
  resolvePostImagePaths,
  type PostFileMeta,
} from '@content/postStorage';
import {
  getShoppingCategorySnapshot,
  saveShoppingCategoryTree,
} from '../../../intelligence/ShoppingCategoryStore';
import {
  getCategoryTreeRefreshState,
  refreshDatalabCategoryTree,
  fetchDatalabCategoryKeywordRank,
} from '../../../intelligence/DatalabShoppingRank';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { createHash } from 'crypto';
import { registerAdRoutes, trackingLinkFetcher } from './ads';
import {
  NaverApiHubKeywordProvider,
  sortByPostdateDesc,
} from '../../../intelligence/NaverApiHubProvider';
import { classifyTrend, monthRange } from '../../../intelligence/TrendAnalysis';
import type { ShoppingCriteria } from '../../../intelligence/NaverApiHubProvider';
import shoppingCategoriesJson from '../../shared/shoppingCategories.json';

/** SHPP_INST 조회 기준 — provider의 ShoppingCriteria와 동일한 값 집합. */
const SHOPPING_CRITERIA: readonly ShoppingCriteria[] = [
  'category',
  'keyword',
  'gender',
  'ages',
  'device',
  'keywords',
  'keywords-keyword',
  'keywords-gender',
  'keywords-ages',
  'keywords-device',
];

/**
 * query(검색어)가 필요한 SHPP_INST criteria — /category/keywords·keyword-level
 * breakdown 계열. 분야-level('category'|'gender'|'ages'|'device')은 query 없이
 * category만으로 조회된다.
 */
const KEYWORD_LEVEL_CRITERIA: readonly ShoppingCriteria[] = [
  'keyword',
  'keywords',
  'keywords-keyword',
  'keywords-gender',
  'keywords-ages',
  'keywords-device',
];

/**
 * criteria별 SHPP_INST 요청 바디 — 공식 스펙 기준(NAVER API HUB, 2026-08).
 * 경로 매핑은 provider의 SHOPPING_ENDPOINTS가 담당한다.
 * - 'category' (/categories): category가 [{name, param:[cat_id]}] 배열 — name은
 *   query/categoryName이 없으면 cat_id로 대체 (라우트 계약상 'category'는 query
 *   불필요; categoryName은 시리즈 title 표시용)
 * - 'keywords-gender'/'keywords-ages'/'keywords-device'
 *   (/category/keyword/gender·/age·/device): keyword String
 * - 'keyword'/'keywords'/'keywords-keyword' (/category/keywords): keyword 1쌍 배열
 * - device/gender/ages 필터는 공식 스펙의 optional 필드 — 값이 있을 때만 전송
 */
export function buildShoppingBody(
  criteria: ShoppingCriteria,
  params: {
    query: string;
    category: string;
    categoryName?: string;
    startDate: string;
    endDate: string;
    timeUnit: string;
    device: string;
    gender: string;
    ages: string[];
  },
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    startDate: params.startDate,
    endDate: params.endDate,
    timeUnit: params.timeUnit,
    ...(params.device ? { device: params.device } : {}),
    ...(params.gender ? { gender: params.gender } : {}),
    ...(params.ages.length ? { ages: params.ages } : {}),
  };
  if (criteria === 'category') {
    return {
      ...base,
      category: [
        { name: params.query || params.categoryName || params.category, param: [params.category] },
      ],
    };
  }
  if (criteria === 'gender' || criteria === 'ages' || criteria === 'device') {
    return { ...base, category: params.category };
  }
  if (
    criteria === 'keywords-gender' ||
    criteria === 'keywords-ages' ||
    criteria === 'keywords-device'
  ) {
    return { ...base, category: params.category, keyword: params.query };
  }
  // 'keyword' | 'keywords' | 'keywords-keyword' → /category/keywords (keyword 1쌍 배열)
  return {
    ...base,
    category: params.category,
    keyword: [{ name: params.query, param: [params.query] }],
  };
}

/** GET /api/keywords/shopping-categories 응답 노드 — 클라이언트 ShoppingCategoryNode와 동일 계약(1~3분류 재귀 트리). */
export interface ShoppingCategoryNode {
  catId: string;
  name: string;
  children?: ShoppingCategoryNode[];
}

/**
 * 정적 카테고리 코드표(scripts/scrape-naver-shopping-categories.* 생성물)를
 * 모듈 레벨 1회 로드해 캐시한다 — 매 요청마다 파일/파싱을 반복하지 않는다.
 */
const shoppingCategoriesCache = shoppingCategoriesJson as ShoppingCategoryNode[];

export function loadShoppingCategories(): ShoppingCategoryNode[] {
  return shoppingCategoriesCache;
}

const logger = getLogger('api-routes');

// Recursively mask secret-like string fields (password, secret, token, apiKey, etc.) to '***'.
const SECRET_KEY_RE = /password|secret|token|apikey/i;
function maskSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const v = (value as Record<string, unknown>)[key];
      if (typeof v === 'string' && SECRET_KEY_RE.test(key) && v) {
        out[key] = '***';
      } else if (v && typeof v === 'object') {
        out[key] = maskSecrets(v);
      } else {
        out[key] = v;
      }
    }
    return out;
  }
  return value;
}

/**
 * PUT /api/posts/:id에서 편집된 본문을 meta.platformContent의 각 플랫폼 entry에
 * 재구성한다. tistory/naver는 identity, wordpress는 Gutenberg wp:html 블록 래핑
 * (PostAssembler.convertToWordPressBlocks와 동일 포맷).
 * 제목/태그는 meta 최신값을 따른다 — 로봇이 EDIT 단계에서 PUT한 태그가 발행까지 간다.
 */
function toPlatformContent(meta: PostFileMeta, content: string): Record<string, unknown> {
  const source = (meta.platformContent || {}) as Record<string, Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = {
      ...source[key],
      content: key === 'wordpress' ? `<!-- wp:html -->\n${content}\n<!-- /wp:html -->` : content,
      ...(meta.tags ? { tags: meta.tags } : {}),
    };
  }
  return result;
}

/** 발행 직전 HTML의 sha256 — 사람이 승인한 미리보기와 발행본을 같은 값으로 묶는다. */
function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 같은 초안(draftId)이 24시간 안에 발행된 적이 있는지 (런북 백로그 ①). */
function findRecentDuplicateDraft(
  jobQueue: JobQueueImpl,
  draftId: string,
): PublishedPostRow | null {
  const fromDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const rows = jobQueue.getPublishedPosts({ status: 'published', fromDate, limit: 500 });
  return rows.find((row) => readDraftId(row.metadata) === draftId) ?? null;
}

/**
 * 라이브 제목 중복 검사 (런북 백로그 ③) — RSS는 로그인 없이 최근 글 제목을 준다.
 * 같은 제목이 180일 안에 있으면 그 제목을 돌려준다. RSS를 못 가져오면 null을 돌려주고
 * 경고만 남긴다(네트워크 장애로 발행 자체가 막히면 안 된다).
 */
async function findLiveTitleDuplicate(
  configManager: ConfigManager,
  title: string,
): Promise<string | null> {
  const blogId = String(configManager.get<{ blogId?: string }>('platforms.naver')?.blogId ?? '');
  if (!blogId || !title) return null;
  try {
    const response = await fetch(`https://rss.blog.naver.com/${encodeURIComponent(blogId)}.xml`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return null;
    const xml = await response.text();
    const hit = findRecentlyPublishedRssItem(xml, title, new Date(), 180 * 24 * 60 * 60 * 1000);
    return hit ? hit.title : null;
  } catch (error) {
    logger.warn(
      { error: String(error) },
      'Publish: live title duplicate check skipped (RSS unavailable)',
    );
    return null;
  }
}

/** 발행 흐름이 기록한 metadata(JSON 문자열)에서 draftId를 꺼낸다. */
function readDraftId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { draftId?: unknown };
    return typeof parsed?.draftId === 'string' ? parsed.draftId : null;
  } catch {
    return null;
  }
}

/** ad_inventory 행 → 설정 화면의 링크 프리셋 셰이프(이슈 #18 계약 유지). */
function toLegacyPreset(item: AdItem): {
  id: string;
  label: string;
  kind: string;
  props: Record<string, string>;
  createdAt: string;
} {
  const props: Record<string, string> = { url: item.url, text: item.productName };
  if (item.imageUrl) props.imageUrl = item.imageUrl;
  return {
    id: item.id,
    label: item.productName,
    kind: item.kind,
    props,
    createdAt: item.createdAt,
  };
}
// One platform attempt inside the publish response (superset of shared PublishResult:
// early-failure entries carry no `success` field, matching the historical payload).
type PublishAttempt = {
  platform: string;
  postId?: string;
  url?: string;
  error?: string;
  success?: boolean;
  [key: string]: unknown;
};

// Frontmatter fields consumed by the templates API (YAML is user-authored, all optional).
interface TemplateFrontmatter {
  name?: string;
  displayName?: string;
  description?: string;
  platforms?: string[];
  requiredFields?: string[];
  optionalFields?: string[];
  seo?: { titleTemplate?: string; [key: string]: unknown };
}

export interface RouteContext {
  configManager: ConfigManager;
  affiliateRegistry: AffiliateRegistry;
  platformRegistry: PlatformRegistry;
  jobQueue: JobQueueImpl;
  scheduler: CronScheduler;
}

export async function registerRoutes(app: FastifyInstance, context: RouteContext): Promise<void> {
  const { configManager, affiliateRegistry, platformRegistry, jobQueue, scheduler } = context;
  // 서버 재시작으로 끊긴 백그라운드 생성('generating' 고아 드래프트)을 'failed'로 스윕.
  // 기동 시점엔 진행 중인 in-process 생성이 없으므로 1회만 수행한다.
  const swept = failStaleGeneratingDrafts();
  if (swept > 0) {
    logger.warn({ count: swept }, 'Marked stale generating drafts as failed after restart');
  }

  // 백그라운드 키워드 생성 취소 플래그 — DELETE가 generating 드래프트를 지우면
  // 세트에 id를 넣고, 백그라운드 작업은 저장 직전 이 플래그를 보고 중단한다
  // (완료 후 savePostFiles가 디렉터리를 좀비 부활시키는 것을 방지).
  const cancelledGenerations = new Set<string>();

  // 광고 소재·소재 요청 API (설계 §4-1) — routes/index.ts 비대화를 막기 위해 별도 파일.
  // registerRoutes는 플러그인 스코프가 아니므로(server/index.ts가 직접 호출) 여기서
  // 호출한 라우트도 같은 스코프에 붙어 JWT 보호를 그대로 받는다.
  await registerAdRoutes(app);

  /**
   * 발행 뮤텍스 — 로봇과 사람이 동시에 발행하면 네이버 브라우저 프로필이 겹쳐
   * 잠금 충돌·세션 손상이 난다(설계 §4-2). strict 여부와 무관하게 적용한다.
   */
  let publishInProgress = false;

  // Credential validation hits external APIs; cache results so 30-60s dashboard
  // polling doesn't burn provider quotas on every request.
  type DashboardValidation = {
    affiliates: Record<string, boolean>;
    platforms: Record<string, boolean>;
  };
  const dashboardValidationCache = getCache<DashboardValidation>('dashboard-stats-validation');

  // ---- Settings backend (GET/PUT config) ----
  app.get('/api/config', async () => {
    return { config: maskSecrets(configManager.getAll()) };
  });

  app.put('/api/config', async (request) => {
    const body = (request.body || {}) as Record<string, unknown>;

    // Deep-merge (skipping '***' sentinels so masked secret fields aren't overwritten), then persist.
    configManager.mergeConfig(body);

    try {
      await configManager.save();
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to persist config');
      return { success: false, error: String(error) };
    }

    // Apply platform changes without a restart where possible.
    const platforms = (body.platforms || {}) as Record<string, PlatformCredentials>;
    for (const [name, cfg] of Object.entries(platforms)) {
      if (cfg && cfg.enabled) {
        try {
          await platformRegistry.initialize(name, cfg);
        } catch (error) {
          logger.warn(
            { platform: name, error: String(error) },
            'Failed to initialize platform after config save',
          );
        }
      }
    }

    return { success: true };
  });

  // LLM 연결 테스트: 최소 completion 한 번을 수행한다.
  // 본문이 있으면(저장 전 테스트) 폼에 입력 중인 프로바이더/키/모델을 저장 설정 위에 덧씌우고,
  // 본문이 없으면 기존처럼 저장된 설정으로 검증한다(llm 섹션 우선, 없으면 imageProviders.gemini).
  app.post('/api/llm/validate', async (request) => {
    const raw = request.body as unknown;
    const override =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Partial<ContentGeneratorConfig>)
        : undefined;
    let saved: ContentGeneratorConfig = {};
    try {
      saved = resolveLlmConfigFromConfigManager();
    } catch {
      saved = {};
    }
    const cfg = resolveLlmValidateConfig(saved, override);
    return new ContentGenerator(cfg).validateConnection();
  });

  // LLM 모델 목록 조회: 저장된 apiKey(마스킹 전 원본)로 프로바이더의 /models를 호출한다.
  // 응답에는 모델 id만 담고, 절대 apiKey를 포함하지 않는다. 키 미저장/오류는 200 + error 힌트.
  app.get('/api/llm/models', async (request) => {
    const provider = String((request.query as { provider?: string }).provider || '');
    if (!LLM_PROVIDERS[provider]) {
      return { provider, models: [], error: '지원하지 않는 프로바이더입니다' };
    }
    const apiKey = (configManager.get<string>('llm.apiKey', '') || '').trim();
    if (!apiKey) {
      return {
        provider,
        models: [],
        error: 'API 키가 저장되지 않았습니다. 먼저 저장하세요.',
      };
    }
    try {
      const models = await fetchLlmModels(provider, apiKey);
      return { provider, models };
    } catch (error) {
      // error 메시지는 fetchLlmModels에서 이미 키/URL을 제거한 상태다.
      logger.warn({ provider }, 'Failed to fetch LLM models');
      return { provider, models: [], error: String(error) };
    }
  });

  // Dashboard stats
  app.get('/api/dashboard/stats', async () => {
    const jobStats = jobQueue.getStats();
    const publishedPosts = jobQueue.getPublishedPosts({ limit: 1000 });
    // 60s in-memory cache: polling must not re-validate external credentials.
    const cachedValidation = dashboardValidationCache.get('v1');
    let affiliateStatus: Record<string, boolean>;
    let platformStatus: Record<string, boolean>;
    if (cachedValidation) {
      affiliateStatus = cachedValidation.affiliates;
      platformStatus = cachedValidation.platforms;
    } else {
      affiliateStatus = await affiliateRegistry.validateAll();
      platformStatus = {};
      for (const [name, adapter] of platformRegistry.getInitializedAdapters()) {
        try {
          platformStatus[name] = await adapter.validateCredentials();
        } catch {
          platformStatus[name] = false;
        }
      }
      dashboardValidationCache.set(
        'v1',
        { affiliates: affiliateStatus, platforms: platformStatus },
        60,
      );
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPosts = publishedPosts.filter((p) => new Date(p.published_at) >= today);

    return {
      totalPosts: publishedPosts.length,
      todayPosts: todayPosts.length,
      publishedPosts: publishedPosts.filter((p) => p.status === 'published').length,
      failedPosts: publishedPosts.filter((p) => p.status === 'failed').length,
      successRate:
        publishedPosts.length > 0
          ? publishedPosts.filter((p) => p.status === 'published').length / publishedPosts.length
          : 0,
      jobQueue: jobStats,
      affiliates: affiliateStatus,
      platforms: platformStatus,
      recentPosts: publishedPosts.slice(0, 10).map((p) => ({
        id: p.id,
        title: p.title,
        platform: p.platform,
        status: p.status,
        publishedAt: p.published_at,
      })),
    };
  });

  // Blogs management
  app.get('/api/blogs', async () => {
    const blogs: BlogInfo[] = [];

    // Union of configured platforms and registered adapters so the tab populates
    // as soon as a platform is configured, even before a restart re-initializes it.
    const appConfig = configManager.getAll() as Record<string, Record<string, unknown>>;
    const configured = Object.keys(appConfig.platforms || {});
    const available = platformRegistry.getAvailableAdapters();
    const names = Array.from(new Set([...configured, ...available]));

    for (const name of names) {
      const config = configManager.getPlatformConfig(name);
      let connected = false;
      let categories: PlatformCategory[] = [];
      let lastPost: PublishedPostRow | null = null;

      const adapter = platformRegistry.hasAdapter(name) ? platformRegistry.getAdapter(name) : null;

      try {
        if (adapter && config) {
          connected = await adapter.validateCredentials().catch(() => false);
          categories = await adapter.getCategories().catch(() => []);
        }
        const posts = jobQueue.getPublishedPosts({ platform: name, limit: 1 });
        lastPost = posts[0] || null;
      } catch (error) {
        logger.warn({ platform: name, error: String(error) }, 'Failed to get blog info');
      }

      blogs.push({
        name,
        platform: name,
        connected,
        categories: categories.map((c) => ({ id: c.id, name: c.name })),
        lastPost: lastPost
          ? {
              id: lastPost.post_id,
              title: lastPost.title as string,
              url: lastPost.url,
              publishedAt: lastPost.published_at,
              status: lastPost.status,
            }
          : null,
        config: config ? (maskSecrets(config) as Record<string, unknown>) : null,
      });
    }

    return { blogs };
  });

  app.post('/api/blogs/:name/sync-categories', async (request) => {
    const { name } = request.params as { name: string };

    if (!platformRegistry.hasAdapter(name)) {
      return { error: 'Platform not found' };
    }

    const adapter = platformRegistry.getAdapter(name);

    if (!adapter) {
      return { error: 'Platform not found' };
    }

    try {
      const categories = await adapter.getCategories();
      return { categories };
    } catch (error) {
      logger.error({ platform: name, error: String(error) }, 'Category sync failed');
      return { error: String(error) };
    }
  });

  // Coupang status
  app.get('/api/coupang/status', async () => {
    const adapter = affiliateRegistry.getAdapter('coupang');
    if (!adapter) {
      return { error: 'Coupang adapter not initialized' };
    }

    try {
      // Get recent stats from job queue
      const posts = context.jobQueue.getPublishedPosts({ affiliate: 'coupang', limit: 100 });

      return {
        connected: await adapter.validateCredentials(),
        recentPosts: posts.length,
        // In real implementation, fetch from Coupang API
        earnings: 0,
        clicks: 0,
        conversions: 0,
        approvalRate: 0,
      };
    } catch (error) {
      return { error: String(error) };
    }
  });

  // Keywords - Naver API Hub
  app.get('/api/keywords/trending', async (request) => {
    const { q, limit = '20' } = request.query as { q?: string; limit?: string };

    if (!q || !q.trim()) {
      return {
        trending: [],
        totalResults: 0,
        searchedAt: new Date().toISOString(),
        source: 'naver-api-hub',
        error: 'Query required',
      };
    }

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return {
        trending: [],
        totalResults: 0,
        searchedAt: new Date().toISOString(),
        source: 'naver-api-hub',
        error: 'Naver API Hub credentials not configured',
      };
    }

    const { NaverApiHubKeywordProvider } =
      await import('../../../intelligence/NaverApiHubProvider.js');
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const results = await provider.research([q.trim()], { limit: parseInt(limit) });
      const blogData = await provider.searchBlog(q.trim(), parseInt(limit));

      // 경쟁 블로그 목록을 최근 게시일 기준 내림차순으로 정렬
      const blogs = sortByPostdateDesc(
        (blogData.items || []).slice(0, 10).map((item) => ({
          title: item.title?.replace(/<[^>]*>/g, '') || '',
          link: item.link,
          bloggername: item.bloggername,
          postdate: item.postdate,
          description: item.description?.replace(/<[^>]*>/g, '').substring(0, 200),
        })),
      );

      return {
        trending: results,
        totalResults: blogData.total || 0,
        blogs,
        searchedAt: new Date().toISOString(),
        source: 'naver-api-hub',
      };
    } catch (error) {
      logger.error({ error: String(error), query: q }, 'Trending keywords search failed');
      return {
        trending: [],
        totalResults: 0,
        blogs: [],
        searchedAt: new Date().toISOString(),
        source: 'naver-api-hub',
        error: String(error),
      };
    }
  });

  // Keywords - shopping category tree (정적 코드표 — scripts/scrape-naver-shopping-categories.* 생성물)
  app.get('/api/keywords/shopping-categories', async () => {
    // 1순위: SQLite 저장 트리(DB 비었으면 커밋된 JSON으로 시드) + 갱신 상태.
    const snap = getShoppingCategorySnapshot();
    if (snap) {
      return {
        categories: snap.tree,
        updatedAt: snap.updatedAt,
        nodeCount: snap.nodeCount,
        source: snap.source,
        refresh: getCategoryTreeRefreshState(),
      };
    }
    return { categories: loadShoppingCategories(), refresh: getCategoryTreeRefreshState() };
  });

  // 코드표 갱신 트리거 — 데이터랩을 실조회해 1~4분류 트리를 재수집한다(백그라운드,
  // 30~60분). 상태는 GET /api/keywords/shopping-categories[/refresh] 로 폴링.
  app.post('/api/keywords/shopping-categories/refresh', async (request) => {
    const body = (request.body || {}) as { maxDepth?: number };
    const state = await refreshDatalabCategoryTree({
      maxDepth: typeof body.maxDepth === 'number' ? body.maxDepth : 4,
      onSave: (tree) => saveShoppingCategoryTree(tree, 'datalab'),
    });
    return { started: state.running, state };
  });

  app.get('/api/keywords/shopping-categories/refresh', async () => {
    return { state: getCategoryTreeRefreshState() };
  });

  // Keywords - trend lookup (SCH_TRND / SHPP_INST) with search filters
  app.post('/api/keywords/trend', async (request) => {
    const body = (request.body ?? {}) as {
      source?: string;
      query?: string;
      category?: string;
      categoryName?: string;
      criteria?: ShoppingCriteria;
      startDate?: string;
      endDate?: string;
      timeUnit?: string;
      device?: string;
      gender?: string;
      ages?: string[];
    };
    const {
      source,
      query = '',
      category = '',
      categoryName = '',
      startDate = '',
      endDate = '',
      timeUnit = 'month',
      device = '',
      gender = '',
      ages = [],
    } = body;
    const criteria: ShoppingCriteria =
      body.criteria && SHOPPING_CRITERIA.includes(body.criteria) ? body.criteria : 'keywords';
    const searchedAt = new Date().toISOString();
    const requestEcho = {
      startDate,
      endDate,
      timeUnit,
      device,
      gender,
      ages,
      criteria: source === 'shopping-insight' ? criteria : undefined,
      category: source === 'shopping-insight' ? category : undefined,
      categoryName: source === 'shopping-insight' ? categoryName || undefined : undefined,
    };

    const fail = (error: string) => ({
      source,
      series: [],
      request: requestEcho,
      searchedAt,
      error,
    });

    if (source !== 'search-trend' && source !== 'shopping-insight') {
      return fail("source must be 'search-trend' or 'shopping-insight'");
    }
    // 검색어가 필요한 case: search-trend 전체, shopping 중 keyword-level criteria.
    // 분야-level('category'|'gender'|'ages'|'device')은 query 없이 category만으로 조회.
    const needsQuery = source === 'search-trend' || KEYWORD_LEVEL_CRITERIA.includes(criteria);
    if (needsQuery && !query.trim()) {
      return fail(
        source === 'search-trend' ? 'Query required' : 'Query required for keyword-based criteria',
      );
    }
    if (source === 'shopping-insight' && !category.trim()) {
      return fail('Category required for shopping-insight');
    }
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return fail('startDate/endDate must be yyyy-mm-dd');
    }
    if (startDate > endDate) {
      return fail('startDate must be before or equal to endDate');
    }

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return fail('Naver API Hub credentials not configured');
    }

    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const results =
        source === 'search-trend'
          ? await provider.getSearchTrend([{ groupName: query, keywords: [query] }], {
              startDate,
              endDate,
              timeUnit: timeUnit as 'date' | 'week' | 'month',
              device,
              gender,
              ages,
            })
          : await provider.getShoppingTrend(
              criteria,
              buildShoppingBody(criteria, {
                query: query.trim(),
                category,
                categoryName,
                startDate,
                endDate,
                timeUnit: timeUnit as 'date' | 'week' | 'month',
                device,
                gender,
                ages,
              }),
            );
      const series = results.map((group) => ({ ...group, trend: classifyTrend(group.data ?? []) }));
      // 분야 유효성 — SHPP는 유효하지 않은 cat_id에도 200과 빈 data를 돌려준다
      // (에러 없음). 'category' criteria는 응답 자체의 data 존재가 유효성 신호고,
      // 나머지 criteria는 /categories probe(24h 캐시) 1회로 판정한다. probe 실패는
      // 결과 조회를 깨지 않는다(필드 생략).
      let categoryValid: boolean | undefined;
      if (source === 'shopping-insight') {
        if (criteria === 'category') {
          categoryValid = (results[0]?.data?.length ?? 0) > 0;
        } else {
          try {
            const probe = await provider.getShoppingTrend('category', {
              ...monthRange(12),
              timeUnit: 'month',
              category: [{ name: categoryName || category, param: [category] }],
            });
            categoryValid = (probe[0]?.data?.length ?? 0) > 0;
          } catch (probeError) {
            logger.warn({ category, error: String(probeError) }, 'Category validity probe failed');
          }
        }
      }
      return {
        source,
        series,
        request: requestEcho,
        searchedAt,
        ...(categoryValid === undefined ? {} : { categoryValid }),
      };
    } catch (error) {
      logger.error({ error: String(error), source, query, criteria }, 'Trend lookup failed');
      return fail(String(error));
    }
  });

  // 쇼핑인사이트 카테고리 오버뷰(이슈 #13) — 조회하기 1회 클릭으로 위젯 전체
  // (클릭량 추이 + 기기/성별/연령 비중 + 인기검색어 TOP 20) 데이터를 병렬 조회해
  // 반환한다. 카테고리/기간/조건은 요청 파라미터 그대로 전달(고정값 없음)하며,
  // 스펙 제약(startDate ≥ 2017-08-01, timeUnit, device/gender/ages 값)을 검증한다.
  app.get('/api/keywords/category-overview', async (request) => {
    const q = request.query as Record<string, string | string[]>;
    const category = String(q.category ?? '').trim();
    const categoryName = String(q.categoryName ?? '').trim();
    const startDate = String(q.startDate ?? '');
    const endDate = String(q.endDate ?? '');
    const timeUnit = String(q.timeUnit ?? 'week');
    const device = String(q.device ?? '');
    const gender = String(q.gender ?? '');
    const rawAges = q.ages;
    const ageList = (Array.isArray(rawAges) ? rawAges : rawAges ? String(rawAges).split(',') : [])
      .map((a) => a.trim())
      .filter(Boolean);
    const topLimit = Math.min(Math.max(parseInt(String(q.limit ?? '20'), 10) || 20, 1), 20);

    const fail = (error: string) => ({ error });
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (!category) return fail('category is required');
    if (!DATE_RE.test(startDate) || !DATE_RE.test(endDate)) {
      return fail('startDate/endDate must be yyyy-mm-dd');
    }
    if (startDate < '2017-08-01') return fail('startDate must be on or after 2017-08-01');
    if (startDate > endDate) return fail('startDate must be before or equal to endDate');
    if (!['date', 'week', 'month'].includes(timeUnit)) {
      return fail('timeUnit must be date|week|month');
    }
    if (device && !['pc', 'mo'].includes(device)) return fail('device must be pc|mo');
    if (gender && !['m', 'f'].includes(gender)) return fail('gender must be m|f');
    if (ageList.some((a) => !['10', '20', '30', '40', '50', '60'].includes(a))) {
      return fail('ages must be 10|20|30|40|50|60');
    }

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return fail('Naver API Hub credentials not configured');
    }
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    // 분야 유효성 probe — /categories는 유효 cat_id에만 data를 채운다. 실패는
    // 오버뷰 조회를 깨지 않는다(유효성 미판정).
    let categoryValid: boolean | undefined;
    try {
      const probe = await provider.getShoppingTrend('category', {
        startDate,
        endDate,
        timeUnit,
        category: [{ name: categoryName || category, param: [category] }],
      });
      categoryValid = (probe[0]?.data?.length ?? 0) > 0;
    } catch (probeError) {
      logger.warn({ category, error: String(probeError) }, 'Category validity probe failed');
    }

    // 비중 분해는 각 차원 자신을 제외한 나머지 조건만 적용한다(데이터랩 동작 동일).
    const base = {
      query: '',
      category,
      categoryName,
      startDate,
      endDate,
      timeUnit,
      device,
      gender,
      ages: ageList,
    };

    try {
      const [clickTrend, deviceSeries, genderSeries, agesSeries] = await Promise.all([
        provider.getShoppingTrend('category', buildShoppingBody('category', base)).catch(() => []),
        provider
          .getShoppingTrend('device', buildShoppingBody('device', { ...base, device: '' }))
          .catch(() => []),
        provider
          .getShoppingTrend('gender', buildShoppingBody('gender', { ...base, gender: '' }))
          .catch(() => []),
        provider
          .getShoppingTrend('ages', buildShoppingBody('ages', { ...base, ages: [] }))
          .catch(() => []),
      ]);

      // 인기검색어 TOP 20 — DataLab 분야 인기검색어 랭킹 직조회(이슈 #14 A안).
      // 공식 쇼핑인사이트 API에는 랭킹 엔드포인트가 없어(8개 전부 트렌드 추이 조회)
      // 데이터랩 웹 UI가 사용하는 내부 XHR API를 사용한다 — 로그인 불필요, ~1초
      // 응답, 화면 표시와 100% 동일. 24h 캐시, 실패 시 빈 목록(추정 폴백 없음).
      let keywords: KeywordData[] = [];
      const keywordsSource = 'naver-datalab';
      try {
        const rankRows = await fetchDatalabCategoryKeywordRank({
          catId: category,
          startDate,
          endDate,
          timeUnit: timeUnit as 'date' | 'week' | 'month',
          device: device || undefined,
          gender: gender || undefined,
          ages: ageList.length > 0 ? ageList : undefined,
          count: topLimit,
        });
        keywords = rankRows.map((r) => ({
          keyword: r.keyword,
          volume: Math.max(1, 1000 - (r.rank - 1) * 50),
          competition: 0,
          trend: 'stable' as const,
          related: [] as string[],
          source: 'naver-api-hub' as const,
          metadata: { volumeBasis: 'datalab-measured', rank: r.rank },
        }));
      } catch (rankError) {
        logger.warn(
          { category, error: String(rankError) },
          'Datalab category rank fetch failed; returning empty list',
        );
      }

      return {
        category,
        categoryName: categoryName || undefined,
        categoryValid,
        clickTrend,
        shares: { device: deviceSeries, gender: genderSeries, ages: agesSeries },
        keywords,
        keywordsSource,
      };
    } catch (error) {
      logger.error({ category, error: String(error) }, 'Category overview failed');
      return fail(String(error));
    }
  });

  app.get('/api/keywords/:keyword/blogs', async (request) => {
    const { keyword } = request.params as { keyword: string };
    const { limit = '10', sort = 'sim' } = request.query as { limit?: string; sort?: string };

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return { error: 'Naver API Hub credentials not configured', blogs: [] };
    }

    const { NaverApiHubKeywordProvider } =
      await import('../../../intelligence/NaverApiHubProvider.js');
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const blogData = await provider.searchBlog(keyword, parseInt(limit), sort);
      return {
        blogs: (blogData.items || []).map((item) => ({
          title: item.title?.replace(/<[^>]*>/g, '') || '',
          link: item.link,
          bloggername: item.bloggername,
          postdate: item.postdate,
          description: item.description?.replace(/<[^>]*>/g, '').substring(0, 300),
        })),
        total: blogData.total || 0,
      };
    } catch (error) {
      logger.error({ error: String(error), keyword }, 'Blog competitor search failed');
      return { error: String(error), blogs: [] };
    }
  });

  app.post('/api/keywords/research', async (request) => {
    const {
      keywords,
      providers = ['naver-api-hub'],
      limit = 20,
    } = request.body as {
      keywords?: string[];
      providers?: string[];
      limit?: number;
    };

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return { error: 'Keywords array required' };
    }

    const allResults: KeywordData[] = [];

    // Naver API Hub
    if (providers.includes('naver-api-hub')) {
      const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
      if (hubConfig?.apiKey && hubConfig?.apiSecret) {
        const { NaverApiHubKeywordProvider } =
          await import('../../../intelligence/NaverApiHubProvider.js');
        const provider = new NaverApiHubKeywordProvider(hubConfig);
        const hubResults = await provider.research(keywords, { limit });
        allResults.push(...hubResults);
      }
    }

    // Legacy providers (DataLab, Google Trends, Coupang)
    if (
      providers.includes('naver') ||
      providers.includes('google-trends') ||
      providers.includes('coupang')
    ) {
      const researcher = await import('../../../intelligence/KeywordResearcher.js').then((m) =>
        m.createKeywordResearcher(),
      );
      const { NaverKeywordProvider, GoogleTrendsProvider, CoupangKeywordProvider } =
        await import('../../../intelligence/KeywordResearcher.js');

      const naverConfig = configManager.getKeywordProviderConfig('naver');
      const googleConfig = configManager.getKeywordProviderConfig('google-trends');

      if (naverConfig?.enabled) researcher.registerProvider(new NaverKeywordProvider(naverConfig));
      if (googleConfig?.enabled)
        researcher.registerProvider(new GoogleTrendsProvider(googleConfig));
      researcher.registerProvider(new CoupangKeywordProvider());

      const legacyProviders = providers.filter((p: string) => p !== 'naver-api-hub');
      if (legacyProviders.length > 0) {
        const results = await researcher.research(keywords, { providers: legacyProviders, limit });
        allResults.push(...results);
      }
    }

    // Sort by volume * (1-competition)
    allResults.sort((a, b) => b.volume * (1 - b.competition) - a.volume * (1 - a.competition));

    return { keywords: allResults.slice(0, limit), providers };
  });
  // Posts management
  app.get('/api/posts', async (request) => {
    const {
      status,
      platform,
      title,
      limit = '50',
      offset = '0',
      fromDate,
      toDate,
    } = request.query as {
      status?: string;
      platform?: string;
      title?: string;
      limit?: string;
      offset?: string;
      fromDate?: string;
      toDate?: string;
    };

    // 제목 검색(부분일치) + 실제 offset 전달 (이슈 #24 2-2·2-3).
    // 기존엔 offset이 파싱만 되고 쿼리에 안 붙어 2페이지가 1페이지와 동일했다.
    const commonFilters = { status, platform, title, fromDate, toDate };
    const posts = jobQueue.getPublishedPosts({
      ...commonFilters,
      limit: parseInt(limit),
      offset: parseInt(offset) || 0,
    });

    const total = jobQueue.getPublishedPosts(commonFilters).length;

    return {
      posts: posts.map((p) => {
        const parsedMeta = p.metadata ? JSON.parse(p.metadata) : null;
        return {
          id: p.id,
          jobId: p.job_id,
          platform: p.platform,
          postId: p.post_id,
          // 편집화면 재진입/재발행용 드래프트 id (이슈 #10).
          // 과거 레코드(draftId 미기록)는 실패 건에 한해 post_id가 드래프트 id와 동일하므로 폴백한다.
          draftId: parsedMeta?.draftId ?? (p.status === 'failed' ? p.post_id : null),
          url: p.url,
          title: p.title,
          template: p.template,
          productId: p.product_id,
          status: p.status,
          publishedAt: p.published_at,
          metadata: parsedMeta,
        };
      }),
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    };
  });

  app.post('/api/posts', async (request) => {
    const { template, productId, platform, subId } = request.body as {
      template?: string;
      productId?: string;
      platform?: string;
      subId?: string;
    };

    if (!template || !productId || !platform) {
      return { error: 'template, productId, and platform are required' };
    }

    const coupangAdapter = affiliateRegistry.getAdapter('coupang');
    if (!coupangAdapter) {
      return { error: 'Coupang adapter not initialized' };
    }

    const product = await coupangAdapter.getProductDetails(productId);

    const templateEngine = createTemplateEngine('./templates');
    await templateEngine.loadTemplates();
    await templateEngine.validateTemplate(template);

    const imageGenerator = resolveImageGenerator('./output/images');
    const postAssembler = createPostAssembler(templateEngine, imageGenerator);
    // R5: gemini 설정 시에만 이미지 생성 (미설정/실패 시 images 없이 발행)
    // 이슈 #11: 상품 실물 이미지는 생성하지 않고 본문 관련 섹션 이미지만 생성
    const images = resolveGeminiImageConfig()
      ? await generateImagesSafely(
          imageGenerator,
          buildSectionImageSpecs({
            productName: product.name,
            categoryName: product.categoryName,
          }).map((spec) => ({ key: spec.key, prompt: spec.prompt })),
        )
      : { urls: [], localPaths: [], sectionImages: {} };

    const post = await postAssembler.assemble({
      template,
      affiliateData: product,
      platform,
      subId,
      images,
    });

    savePostFiles(post);

    return { post };
  });

  app.post('/api/posts/generate-from-keyword', async (request, reply) => {
    const { keyword, template } = request.body as { keyword?: string; template?: string };
    if (!keyword || !template) {
      return reply.code(400).send({ error: 'keyword and template are required' });
    }

    // 플레이스홀더 저장 전에 템플릿 존재 여부를 동기 검증해 즉시 400으로 실패시킨다.
    const templateEngine = createTemplateEngine('./templates');
    await templateEngine.loadTemplates();
    if (!templateEngine.getTemplateInfo(template)) {
      return reply.code(400).send({ error: `Template not found: ${template}` });
    }

    const id = `post-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const now = new Date().toISOString();
    // 즉시 반환용 드래프트 플레이스홀더 — 백그라운드 생성이 같은 id로 본문/이미지/제목을 교체한다.
    const placeholder: PostContent = {
      id,
      template,
      productId: `keyword:${keyword}`,
      platform: 'unknown',
      status: 'DRAFT',
      title: `${keyword} (생성 중...)`,
      content: '',
      meta: { description: '', keywords: [keyword] },
      tags: [],
      categories: [],
      platformContent: {},
      affiliateUrl: '',
      images: [],
      createdAt: now,
      updatedAt: now,
    };
    savePostFiles(placeholder);
    updatePostMeta(id, { generationStatus: 'generating' });

    // 실제 생성(LLM→이미지→assemble→저장)은 응답과 무관하게 백그라운드로 계속 진행한다.
    void generateDraftFromKeyword({
      keyword,
      templateName: template,
      postId: id,
      // DELETE로 드래프트가 지워졌으면 저장 직전에 중단한다(좀비 부활 방지).
      isCancelled: () => cancelledGenerations.has(id),
    })
      .then(() => {
        // 취소된 생성은 상태를 기록하지 않는다(디렉터리도 이미 삭제됨).
        if (cancelledGenerations.has(id)) return;
        updatePostMeta(id, {
          generationStatus: 'done',
          generationError: undefined,
          updatedAt: new Date().toISOString(),
        });
        logger.info({ postId: id, keyword, template }, 'Background keyword draft generation done');
      })
      .catch((error) => {
        if (cancelledGenerations.has(id)) {
          logger.info({ postId: id }, 'Background keyword draft generation cancelled');
          return;
        }
        logger.error(
          { postId: id, keyword, template, error: String(error) },
          'Background keyword draft generation failed',
        );
        // 드래프트는 남기고 실패 상태만 기록한다.
        updatePostMeta(id, {
          generationStatus: 'failed',
          generationError: String(error),
          updatedAt: new Date().toISOString(),
        });
      });

    return { post: { id } };
  });

  app.get('/api/posts/drafts', async () => {
    return { drafts: listDrafts() };
  });

  app.get('/api/posts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }
    return {
      post: {
        id,
        meta: files.meta,
        content: files.content,
        generationStatus: files.meta.generationStatus,
        generationError: files.meta.generationError,
      },
    };
  });

  app.put('/api/posts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { content, title, tags } = request.body as {
      content?: string;
      title?: string;
      tags?: string[];
    };
    if (typeof content !== 'string') {
      return reply.code(400).send({ error: 'content is required' });
    }

    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }

    // 백그라운드 생성 중인 드래프트는 저장을 거부한다 — 완료 시 백그라운드
    // savePostFiles가 사용자 편집을 통째로 덮어쓰는 유실을 막는다.
    // placeholder는 POST 응답 전에 'generating'으로 저장되므로 그 사이 창도 커버된다.
    if (files.meta.generationStatus === 'generating') {
      return reply.code(409).send({ error: '포스트 생성이 진행 중입니다. 완료 후 편집하세요.' });
    }

    const meta = files.meta;
    if (title) meta.title = title;
    // 태그는 로봇 EDIT 단계가 채운다(설계 §4-1 PUT 확장) — 발행까지 그대로 간다.
    if (Array.isArray(tags)) {
      meta.tags = tags.map((tag) => String(tag).trim()).filter((tag) => tag !== '');
    }
    meta.platformContent = toPlatformContent(meta, content);
    meta.updatedAt = new Date().toISOString();

    fs.writeFileSync(`./output/posts/${id}/post.html`, content);
    fs.writeFileSync(`./output/posts/${id}/meta.json`, JSON.stringify(meta, null, 2));

    return { success: true, post: { id, meta, content } };
  });

  app.delete('/api/posts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { confirm } = request.query as { confirm?: string };

    // 포스트 기록은 두 곳에 나뉜다 (이슈 #24 2-1):
    //  - 드래프트 파일: output/posts/<id>/
    //  - 발행 기록: data/jobs.sqlite published_posts (행 id = pub-<platform>-<postId>)
    const files = readPostFiles(id);
    const publishedRow = jobQueue.getPublishedPostById(id);
    if (!files && !publishedRow) {
      return reply.code(404).send({ error: 'Post not found' });
    }

    // 발행 완료 포스트는 실수 삭제 방지를 위해 명시적 확인을 요구한다.
    // (실패 레코드는 오류 기록이므로 확인 없이 삭제 허용)
    const isPublished =
      publishedRow?.status === 'published' || (!!files && files.meta.status !== 'DRAFT');
    if (isPublished && confirm !== 'published') {
      return reply.code(400).send({
        error: 'Published posts require ?confirm=published',
        requiresConfirm: true,
        // 네이버 등은 삭제 API가 없어 로컬 기록만 지운다 — 원문 링크를 함께 돌려준다.
        externalUrl: publishedRow?.url ?? null,
      });
    }

    // generating 중이면 백그라운드 생성을 취소 표시한다(디렉터리 부활 방지).
    if (files?.meta.generationStatus === 'generating') {
      cancelledGenerations.add(id);
    }

    // 드래프트 디렉터리: id가 곧 디렉터리이거나(파일 존재), 발행 행의 metadata.draftId.
    let draftDirId: string | null = files ? id : null;
    if (!draftDirId && publishedRow?.metadata) {
      try {
        draftDirId = (JSON.parse(publishedRow.metadata) as { draftId?: string }).draftId ?? null;
      } catch {
        draftDirId = null;
      }
    }

    const removedDraft = draftDirId ? deleteDraftFiles(draftDirId) : false;
    const removedRow = publishedRow ? jobQueue.deletePublishedPost(id) : 0;

    if (!removedDraft && !removedRow) {
      return reply.code(400).send({ error: 'Invalid post id' });
    }
    logger.info(
      {
        postId: id,
        removedDraft,
        removedRow,
        isPublished,
        cancelled: cancelledGenerations.has(id),
      },
      'Post deleted',
    );
    return { success: true, removedDraft, removedRow };
  });

  app.post('/api/posts/:id/ai-edit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const { prompt } = request.body as { prompt?: string };
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return reply.code(400).send({ error: 'prompt is required' });
    }

    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }

    let saved: ContentGeneratorConfig;
    try {
      saved = resolveLlmConfigFromConfigManager();
    } catch {
      saved = {};
    }

    try {
      const content = await new ContentGenerator(saved).editPostHtml(files.content, prompt.trim());
      if (!content) {
        return reply.code(500).send({ error: 'LLM returned empty content' });
      }
      return { content };
    } catch (error) {
      logger.error({ postId: id, error: String(error) }, 'AI edit failed');
      return reply.code(500).send({ error: String(error) });
    }
  });

  // 링크/배너 프리셋(이슈 #18)은 `ad_inventory`로 흡수됐다(설계 §2-1). 설정 화면의
  // 응답 계약(id/label/kind/props)은 그대로 두고 저장소만 바꾼다 — 프리셋은 이제
  // "광고 소재"이고, 발행 시 본문 배치는 주제 매칭(AdMatcher)이 결정한다.
  app.get('/api/link-presets', async () => {
    return { presets: listInventory({ status: 'active' }).map(toLegacyPreset) };
  });

  app.post('/api/link-presets', async (request) => {
    const body = request.body as {
      label?: string;
      kind?: string;
      props?: { url?: string; text?: string; imageUrl?: string; snippet?: string };
    };
    if (!body.kind || !COUPANG_WIDGET_KINDS.includes(body.kind as CoupangWidgetKind)) {
      return { error: `kind must be one of: ${COUPANG_WIDGET_KINDS.join(', ')}` };
    }
    const kind = body.kind as CoupangWidgetKind;
    // 스니펫 임베드(다이나믹·검색·카테고리 위젯)는 더 이상 등록하지 않는다:
    // 방문자 문맥이 없어 주제와 무관한 상품이 나온다(이슈 #21, 계획 §3-1).
    if (kind === 'dynamic-banner' || kind === 'search-widget' || kind === 'category-banner') {
      return {
        error:
          '다이나믹·검색·카테고리 위젯은 주제와 무관한 상품이 나와 더 이상 지원하지 않습니다. "쿠팡 현황 > 광고 소재 관리"에서 파트너스 링크를 등록하세요.',
      };
    }
    const props = body.props ?? {};
    const result = addInventoryFromPaste({
      paste: props.url ?? '',
      keywords: body.label ? [body.label] : [],
      productName: props.text,
      imageUrl: props.imageUrl,
      kind,
    });
    if (result.ok === false) return { error: result.error };
    return { preset: toLegacyPreset(result.value) };
  });

  app.delete('/api/link-presets/:id', async (request) => {
    const { id } = request.params as { id: string };
    if (!getInventoryItem(id)) {
      return { error: 'Preset not found' };
    }
    removeInventory(id);
    return { ok: true };
  });

  // 초안 단계 광고 배치 (설계 §4-1) — 발행 시점이 아니라 여기서 배치를 끝내
  // 사람이 확인한 미리보기와 발행본이 달라지지 않게 한다. 멱등이다.
  app.post('/api/posts/:id/place-ads', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      keyword?: string;
      categoryId?: string;
      policy?: Partial<AdPolicy>;
    };
    const keyword = (body.keyword ?? '').trim();
    if (!keyword) {
      return reply.code(400).send({ error: 'keyword is required', field: 'keyword' });
    }
    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }

    const policy: AdPolicy = { ...DEFAULT_AD_POLICY, ...(body.policy ?? {}) };
    const inventory = listInventory({ status: 'active' });
    const ranked = matchAds({ keyword, categoryId: body.categoryId }, inventory);
    const plan = planAdSlots(files.content, ranked, policy);
    // 고지도 함께 넣는다 — 광고가 있으면 정확히 1회, 없으면 0회(설계 §3-5).
    const html = ensureDisclosure(plan.html, plan.slots.length > 0);

    fs.writeFileSync(`./output/posts/${id}/post.html`, html);
    const meta = files.meta;
    meta.platformContent = toPlatformContent(meta, html);
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(`./output/posts/${id}/meta.json`, JSON.stringify(meta, null, 2));

    logger.info(
      { postId: id, slots: plan.slots.length, ads: ranked.length },
      'place-ads: automatic ad slots placed into draft',
    );
    return {
      html,
      slots: plan.slots,
      ads: ranked.map((entry) => ({ ...entry.ad, score: entry.score, matchedBy: entry.matchedBy })),
      disclosure: plan.slots.length > 0,
      notes: plan.notes,
    };
  });

  // 발행 전 게이트 (설계 §4-1) — 파일을 바꾸지 않는다. 미리보기 sha256을 돌려주고
  // 그 값을 그대로 strict 발행이 검증한다. checkLinks면 광고 링크 생존까지 본다.
  app.post('/api/posts/:id/gate', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      expectedSlots?: AdSlot[];
      checkLinks?: boolean;
      keyword?: string;
      categoryId?: string;
    };
    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }

    const inventory = listInventory({});
    const placedIds = collectPlacedAdIds(files.content);
    const placedAds = placedIds
      .map((adId) => inventory.find((item) => item.id === adId))
      .filter((item): item is AdItem => Boolean(item));

    const violations = [
      ...checkAdGate(files.content, {
        // 로봇이 계획(place-ads 응답)을 그대로 넘기면 그 계획과 대조하고,
        // 아니면 초안 마커에서 블록 구성을 도출해 대조한다.
        slots: body.expectedSlots ?? deriveAdSlots(files.content),
        inventory,
        topic: body.keyword ? { keyword: body.keyword, categoryId: body.categoryId } : undefined,
      }),
    ];

    // 발행 변환 체인을 적용한 HTML에서 구조 검사(런북 백로그 ④)를 돌린다 —
    // 확장되지 않은 마커·script/iframe·⟦IMGn⟧·스텁 문구는 발행 직전에 잡아야 한다.
    const publishHtml = buildPublishPreviewHtml(files.content, 'naver');
    violations.push(...checkPublishStructure(publishHtml));

    if (body.checkLinks && placedAds.length > 0) {
      const checks = await checkAdLinks(placedAds, trackingLinkFetcher);
      for (const check of checks) {
        recordInventoryCheck(check.id, {
          ok: check.ok,
          status: check.status,
          location: check.location,
          checkedAt: new Date().toISOString(),
        });
        if (!check.ok) {
          violations.push({
            code: 'AD_LINK_DEAD',
            message: `광고 링크가 살아있지 않다: ${check.url} (${check.reason ?? 'unknown'})`,
            detail: { adId: check.id, status: check.status, location: check.location },
          });
        }
      }
    }

    const previewSha256 = sha256(publishHtml);
    const previewHtmlPath = `./output/posts/${id}/publish-preview.html`;
    fs.writeFileSync(previewHtmlPath, publishHtml);

    return {
      ok: violations.length === 0,
      violations,
      previewSha256,
      previewHtmlPath,
    };
  });

  // 발행 미리보기(이슈 #17) — 편집 화면이 실제 발행물과 동일한 렌더링을 볼 수 있게
  // 발행 변환 체인(위젯 확장 → 스타일 정리 → naver 인라인/평탄화)을 적용해 반환한다.
  // AI polish와 링크 미리보기 카드(네트워크 의존)는 발행 시점에만 적용된다.
  app.get('/api/posts/:id/publish-preview', async (request) => {
    const { id } = request.params as { id: string };
    const { platform } = request.query as { platform?: string };
    const postPath = `./output/posts/${id}/meta.json`;
    const fs = await import('fs');
    if (!fs.existsSync(postPath)) {
      return { error: 'Post not found' };
    }
    const content = fs.readFileSync(`./output/posts/${id}/post.html`, 'utf-8');
    const targetPlatform = platform || 'naver';
    const html = rewriteLocalImageSrcsForWeb(buildPublishPreviewHtml(content, targetPlatform));
    return { html, platform: targetPlatform };
  });

  app.post('/api/posts/:id/publish', async (request, reply) => {
    const { id } = request.params as { id: string };
    // visibility: 비공개 발행 지원. 발행 파이프라인 변경을 실제 블로그에서 검증할 때
    // 공개 노출 없이 확인하기 위한 옵션이다(미지정 시 기존대로 공개).
    // strict: 로봇 전용 경로 — 사람이 승인한 미리보기 sha를 검증하고, 발행본을 바꾸는
    // 단계(AI 다듬기·프리셋 배치·CTA 채우기)를 전부 건너뛴다(설계 §4-2).
    const body = (request.body ?? {}) as {
      platform?: string;
      visibility?: 'public' | 'private';
      aiPolish?: boolean;
      strict?: boolean;
      expectedPreviewSha256?: string;
      robotRunId?: string;
    };
    const { platform, visibility, strict, expectedPreviewSha256, robotRunId } = body;

    if (strict && body.aiPolish === true) {
      return reply.code(400).send({
        error: 'strict 발행에서는 aiPolish를 쓸 수 없습니다',
        code: 'AI_POLISH_FORBIDDEN',
      });
    }
    if (strict && !expectedPreviewSha256) {
      return reply.code(400).send({
        error: 'strict 발행에는 expectedPreviewSha256이 필요합니다',
        code: 'PREVIEW_SHA_REQUIRED',
      });
    }
    if (publishInProgress) {
      // 같은 브라우저 프로필을 두 요청이 열면 잠금 충돌·세션 손상이 난다(설계 §4-2).
      return reply.code(423).send({
        error: '다른 발행이 진행 중입니다',
        code: 'PUBLISH_IN_PROGRESS',
      });
    }

    publishInProgress = true;
    try {
      const postPath = `./output/posts/${id}/meta.json`;
      if (!fs.existsSync(postPath)) {
        return reply.code(404).send({ error: 'Post not found' });
      }

      const postMeta = JSON.parse(fs.readFileSync(postPath, 'utf-8')) as Omit<
        PostFileMeta,
        'platformContent'
      > & { platformContent?: Record<string, PlatformPostContent> };
      // 발행 파이프라인은 플랫폼별 본문을 직접 고친다(다듬기·CTA 채우기) — 맵을 고정해 둔다.
      const platformContentMap = (postMeta.platformContent ??= {});
      let content = fs.readFileSync(`./output/posts/${id}/post.html`, 'utf-8');

      const targetPlatforms = platform ? [platform] : Object.keys(platformContentMap);
      if (targetPlatforms.length === 0) {
        return reply.code(400).send({ error: '발행할 플랫폼이 없습니다', code: 'NO_PLATFORM' });
      }
      if (strict && targetPlatforms.length !== 1) {
        // 미리보기 sha는 플랫폼별로 다르다 — strict는 한 번에 한 플랫폼만 발행한다.
        return reply.code(400).send({
          error: 'strict 발행은 platform을 하나만 지정해야 합니다',
          code: 'STRICT_MULTI_PLATFORM',
        });
      }

      // strict 1) 미리보기 sha 대조 (설계 §4-2 2). 오프라인 렌더를 쓴다 —
      // 네트워크 조회 결과가 섞이면 같은 초안도 발행 시점에 다른 sha가 나온다.
      let strictHtml = '';
      if (strict) {
        strictHtml = buildPublishPreviewHtml(content, targetPlatforms[0]);
        const actualSha = sha256(strictHtml);
        if (actualSha !== expectedPreviewSha256) {
          return reply.code(409).send({
            error: '미리보기 이후 초안이 바뀌었습니다. 게이트를 다시 실행하세요',
            code: 'PREVIEW_CHANGED',
            previewSha256: actualSha,
          });
        }
      }

      // 중복 검사 (설계 §4-2 3) — 같은 초안 재발행은 strict 여부와 무관하게 막는다.
      const duplicateDraft = findRecentDuplicateDraft(jobQueue, id);
      if (duplicateDraft) {
        return reply.code(409).send({
          error: `최근 24시간 안에 같은 초안이 발행됐습니다(${duplicateDraft.published_at})`,
          code: 'DUPLICATE_DRAFT',
        });
      }
      if (strict) {
        // 라이브 제목 대조(런북 백로그 ③) — RSS를 못 가져오면 경고만 남기고 진행한다.
        const duplicateTitle = await findLiveTitleDuplicate(configManager, postMeta.title);
        if (duplicateTitle) {
          return reply.code(409).send({
            error: `블로그에 같은 제목의 글이 최근 180일 안에 있습니다: ${duplicateTitle}`,
            code: 'DUPLICATE_TITLE',
          });
        }
        // 게이트 재실행 (설계 §4-2 4) — 링크 검사는 제외한다(이미 GATE에서 확인했다).
        const violations = [
          ...checkAdGate(content, { slots: deriveAdSlots(content), inventory: listInventory({}) }),
          ...checkPublishStructure(strictHtml),
        ];
        if (violations.length > 0) {
          return reply.code(422).send({
            error: '발행 전 게이트를 통과하지 못했습니다',
            code: 'GATE_FAILED',
            violations,
          });
        }
      }

      // AI 최종 다듬기(이슈 #12) — 기본 ON, body.aiPolish === false로 끈다.
      // strict는 발행본을 바꾸지 않는다(승인한 미리보기와 달라지면 안 된다).
      const aiPolish = !strict && body.aiPolish !== false;
      if (aiPolish) {
        try {
          const generator = new ContentGenerator(resolveLlmConfigFromConfigManager());
          const polished = await generator.polishForPublish(content);
          if (polished && polished !== content) {
            content = polished;
            // 다듬어진 최종본을 저장해 편집화면에서도 동일 버전을 유지한다.
            fs.writeFileSync(`./output/posts/${id}/post.html`, content);
            for (const key of Object.keys(platformContentMap || {})) {
              platformContentMap[key].content = content;
            }
            fs.writeFileSync(postPath, JSON.stringify(postMeta, null, 2));
          }
        } catch (error) {
          // LLM 미설정/실패 시 원본으로 계속 진행한다(발행이 막히지 않게 한다).
          logger.warn({ postId: id, error: String(error) }, 'Publish-time AI polish skipped');
        }
      }

      // strict는 발행본을 바꾸는 단계(프리셋 배치·CTA 채우기·마커 승격)를 건너뛴다 —
      // 사람이 승인한 미리보기와 발행본이 달라지면 안 된다(설계 §4-2 5).
      if (!strict) {
        const contentBeforeFixups = content;
        // 마커가 <figure>/<p> 안에 갇혀 있으면 SE가 앞 사진의 캡션으로 흡수한다
        // (실측 logNo 224404059950 #17) — 블록 최상위로 끌어올린 뒤 확장한다.
        const lifted = liftWidgetMarkers(content);
        if (lifted !== content) {
          content = lifted;
          logger.info({ postId: id }, 'Publish: widget markers lifted out of inline containers');
        }

        // CTA 제휴 URL 채우기(이슈 #20 원인 C) — 템플릿은 affiliateUrl이 비어 있으면
        // CTA 자체를 렌더하지 않는다. 본문의 첫 유효 product-link 마커(자동 광고 포함)
        // 또는 글 메타에서 URL을 얻어 죽은 CTA 앵커(href ''/'#')에 채운다.
        const ctaUrl = resolveCtaAffiliateUrl(content, postMeta.affiliateUrl);
        if (ctaUrl) {
          const filled = fillCtaAffiliateUrl(content, ctaUrl);
          if (filled !== content) {
            content = filled;
            logger.info({ postId: id }, 'Publish: CTA affiliate url filled');
          }
        }

        if (content !== contentBeforeFixups) {
          fs.writeFileSync(`./output/posts/${id}/post.html`, content);
          for (const key of Object.keys(platformContentMap || {})) {
            platformContentMap[key].content = content;
          }
          fs.writeFileSync(postPath, JSON.stringify(postMeta, null, 2));
        }
      }

      const results: PublishAttempt[] = [];

      for (const platformName of targetPlatforms) {
        const adapter = platformRegistry.getAdapter(platformName);
        if (!adapter) {
          results.push({ platform: platformName, error: 'Platform adapter not found' });
          continue;
        }

        const platformContent = platformContentMap?.[platformName] || {
          title: postMeta.title,
          content,
          tags: postMeta.tags,
          categories: postMeta.categories,
          meta: postMeta.meta,
          visibility: 'public',
          allowComments: true,
        };
        if (visibility) platformContent.visibility = visibility;

        // 프론트엔드에 위젯 유실 경고를 전달한다(이슈 #15).
        const widgetWarnings: string[] = [];

        if (strict) {
          // 검증한 미리보기를 그대로 보낸다 — 자동 광고는 인벤토리 props만으로 만든
          // 오프라인 카드이고, 확장·스타일·평탄화가 이미 끝난 문자열이다(설계 §3-4).
          platformContent.content = strictHtml;
        } else {
          // 1) 링크 미리보기 카드 수집(이슈 #12) — product-link/event-link URL을 읽어
          //    상품 이미지·가격·평점 카드를 만든다. 자동 광고는 네트워크를 조회하지
          //    않고 인벤토리 props만으로 만든 카드를 먼저 깔고, 사용자 위젯용
          //    네트워크 카드를 그 위에 덮는다(설계 §3-4).
          const coupangAdapter = affiliateRegistry.getAdapter('coupang');
          const offlineCards = collectOfflineAdCards(platformContent.content);
          const previewCards = await fetchLinkPreviewCards(
            platformContent.content,
            coupangAdapter ?? undefined,
          ).catch(() => new Map<number, string>());
          const mergedPreviewCards = new Map<number, string>([...offlineCards, ...previewCards]);

          // 1-b) 임베드 위젯 → 실제 상품 카드 수집(이슈 #20 T4). 네이버는 iframe을
          //    100% 제거하므로(원인 B) 파트너스 위젯 자리엔 인라인 상품 카드를 발행한다.
          //    마커별 네트워크 실패는 격리되고, 카드를 못 만든 마커만 drop으로 기록된다.
          const widgetReportCards = await collectWidgetCardsReport(platformContent.content).catch(
            (error: unknown) => {
              logger.warn(
                { postId: id, platform: platformName, error: String(error) },
                'Publish: partners widget card collection failed',
              );
              return { cards: new Map<number, string>(), placements: [] };
            },
          );

          // 2) 위젯 마커 확장 — 사전 수집한 카드(오프라인 광고 #3-4 / 미리보기 #12 /
          //    위젯 상품 카드 #20)로 마커를 치환한다.
          const widgetReport = expandCoupangWidgetsReport(platformContent.content, {
            platform: platformName,
            previewCards: mergedPreviewCards,
            widgetCards: widgetReportCards.cards,
          });
          if (widgetReport.dropped.length > 0) {
            logger.warn(
              { postId: id, platform: platformName, dropped: widgetReport.dropped },
              'Publish: coupang widgets dropped during expansion',
            );
          }

          // 3) 발행 시점 전 위젯/이미지 스타일 정리(이슈 #12)
          platformContent.content = stylePublishHtml(widgetReport.html);

          // 발행 직후 잔존 마커 검증(이슈 #15) — 확장되지 않은 마커가 남으면
          // 에디터→발행물 유실 가능성이 있으므로 명시적으로 기록한다.
          const leftoverMarkers = (platformContent.content.match(/data-coupang-widget/g) ?? [])
            .length;
          if (leftoverMarkers > 0) {
            logger.error(
              { postId: id, platform: platformName, leftoverMarkers },
              'Publish: unexpanded coupang widget markers remain after expansion',
            );
          }
          widgetWarnings.push(...widgetReport.dropped.map((d) => `${d.kind}: ${d.reason}`));
          if (leftoverMarkers > 0) {
            widgetWarnings.push(`unexpanded markers: ${leftoverMarkers}`);
          }
          // 파트너스 위젯은 방문자 문맥 없이 서버에서 조회하면 글 주제와 무관한
          // 베스트셀러를 돌려준다(실측: 청바지 리뷰에 쌀·화장지). 무엇이 실리는지
          // 발행 결과에 그대로 노출해 사용자가 판단할 수 있게 한다.
          for (const placement of widgetReportCards.placements) {
            widgetWarnings.push(
              `[확인] ${placement.kind} 자리 상품: ${placement.names.join(', ')}`,
            );
          }
        }

        // #7: 발행 대상 이미지 로컬 경로 수집 (meta.images → post.html <img> 폴백) —
        // 네이버 등 브라우저 발행 어댑터가 에디터에 업로드한다.
        if (!platformContent.images || platformContent.images.length === 0) {
          const localImagePaths = resolvePostImagePaths(postMeta.images, content);
          if (localImagePaths.length > 0) {
            platformContent.images = localImagePaths.map((p) => ({ localPath: p, altText: '' }));
          }
        }

        try {
          const result = await adapter.createPost(platformContent);
          // 이미지 업로드 실패 등 어댑터 경고를 사용자에게 전달한다(이슈 #19).
          const adapterWarnings = (result.warnings ?? []).map((w) => `image: ${w}`);
          jobQueue.recordPublishedPost({
            platform: platformName,
            postId: result.postId,
            url: result.url,
            title: postMeta.title,
            template: postMeta.template,
            productId: postMeta.productId,
            affiliateUrl: postMeta.affiliateUrl,
            status: 'published',
            // draftId: 편집화면 재진입/재발행용 드래프트 디렉터리 id (이슈 #10)
            metadata: {
              result,
              draftId: id,
              ...(strict ? { previewSha256: expectedPreviewSha256 } : {}),
              ...(robotRunId ? { robotRunId } : {}),
            },
          });
          results.push({
            platform: platformName,
            ...result,
            success: true,
            widgetWarnings,
            warnings: [...widgetWarnings, ...adapterWarnings],
          });
        } catch (error) {
          jobQueue.recordPublishedPost({
            platform: platformName,
            postId: id,
            url: '',
            title: postMeta.title,
            template: postMeta.template,
            productId: postMeta.productId,
            affiliateUrl: postMeta.affiliateUrl,
            status: 'failed',
            // draftId: 실패 포스트도 편집화면에서 재발행할 수 있게 기록한다(이슈 #10)
            metadata: { error: String(error), draftId: id },
          });
          results.push({ platform: platformName, error: String(error), success: false });
        }
      }

      // 게시 성공을 로컬 meta.json에 기록한다 — DELETE /api/posts/:id가 게시된 포스트를
      // 거부하고, 목록의 드래프트/게시 구분이 가능해진다.
      if (results.some((r) => r.success)) {
        updatePostMeta(id, { status: 'PUBLISHED', updatedAt: new Date().toISOString() });
      }

      return { results };
    } finally {
      // 클라이언트(로봇)가 연결을 끊어도 핸들러는 끝까지 실행되고, 락은 여기서 풀린다.
      publishInProgress = false;
    }
  });

  // Scheduler
  app.get('/api/scheduler/jobs', async () => {
    const jobs = scheduler.getScheduledJobs();
    return {
      jobs: jobs.map((j) => ({
        name: j.name,
        type: j.config.type,
        cron: j.config.cron,
        enabled: j.config.enabled,
        priority: j.config.priority,
        config: j.config.config,
      })),
    };
  });

  app.post('/api/scheduler/jobs/:id/trigger', async (request) => {
    const { id } = request.params as { id: string };
    const jobId = await scheduler.triggerJob(id);
    return { jobId };
  });

  app.get('/api/scheduler/config', async () => {
    const config = scheduler.getConfig();
    return {
      success: true,
      enabled: config.enabled,
      running: scheduler.isRunning(),
      config,
    };
  });

  app.put('/api/scheduler/config', async (request) => {
    const updates = request.body as Partial<SchedulerConfig>;
    scheduler.updateConfig(updates);

    // Persist to config
    const currentConfig =
      (configManager.getAll().scheduler as Partial<SchedulerConfig> | undefined) ||
      ({ enabled: false, jobs: [] } as Partial<SchedulerConfig>);
    const newConfig = { ...currentConfig, ...updates };
    configManager.set('scheduler', newConfig);

    return { success: true, config: newConfig };
  });

  // Analytics
  app.get('/api/analytics', async (request) => {
    const { days = '30', platform } = request.query as { days?: string; platform?: string };
    const daysNum = parseInt(days);
    const fromDate = new Date(Date.now() - daysNum * 24 * 60 * 60 * 1000).toISOString();

    const posts = jobQueue.getPublishedPosts({ fromDate, platform, limit: 10000 });

    // Group by day
    const byDay: Record<string, { posts: number; platforms: Record<string, number> }> = {};
    for (const post of posts) {
      const day = post.published_at.split('T')[0];
      if (!byDay[day]) {
        byDay[day] = { posts: 0, platforms: {} };
      }
      byDay[day].posts++;
      byDay[day].platforms[post.platform] = (byDay[day].platforms[post.platform] || 0) + 1;
    }

    // Group by platform
    const byPlatform: Record<string, number> = {};
    for (const post of posts) {
      byPlatform[post.platform] = (byPlatform[post.platform] || 0) + 1;
    }

    // Group by template
    const byTemplate: Record<string, number> = {};
    for (const post of posts) {
      if (post.template) {
        byTemplate[post.template] = (byTemplate[post.template] || 0) + 1;
      }
    }

    return {
      period: { days: daysNum, from: fromDate, to: new Date().toISOString() },
      totalPosts: posts.length,
      byDay: Object.entries(byDay).map(([date, data]) => ({ date, ...data })),
      byPlatform,
      byTemplate,
      successRate:
        posts.length > 0 ? posts.filter((p) => p.status === 'published').length / posts.length : 0,
    };
  });

  // Templates CRUD
  const templatesDir = path.resolve(process.cwd(), 'templates');

  const parseTemplateFile = (content: string, _filename: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;
    try {
      const frontmatter = yaml.load(fmMatch[1]) as TemplateFrontmatter;
      return { frontmatter, body: fmMatch[2], raw: content };
    } catch {
      return null;
    }
  };

  /**
   * 저장 전 템플릿 무결성 검사 (이슈 #23 1-3.5).
   *
   * `POST/PUT /api/templates`가 컴파일 검사 없이 파일에 그대로 쓰던 탓에 깨진
   * 템플릿이 발행 시점에야 터졌다(edb0c32의 Missing helper 사고와 같은 부류).
   * frontmatter가 있으면 YAML이 유효한지, 그리고 본문이 Handlebars.precompile을
   * 통과하는지(블록 미종결 등 파싱 오류가 없는지)를 저장 전에 막는다.
   */
  const validateTemplateContent = async (content: string): Promise<string | null> => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (fmMatch) {
      try {
        yaml.load(fmMatch[1]);
      } catch (e) {
        return `frontmatter YAML 파싱 실패: ${String(e)}`;
      }
    }
    const body = fmMatch ? fmMatch[2] : content;
    try {
      const Handlebars = (await import('handlebars')).default;
      Handlebars.precompile(body);
    } catch (e) {
      return `Handlebars 컴파일 실패: ${e instanceof Error ? e.message : String(e)}`;
    }
    return null;
  };

  app.get('/api/templates', async () => {
    if (!fs.existsSync(templatesDir)) return { templates: [] };
    const files = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.hbs'));
    const templates = files.map((filename) => {
      const content = fs.readFileSync(path.join(templatesDir, filename), 'utf-8');
      const parsed = parseTemplateFile(content, filename);
      if (!parsed) return { filename, name: filename.replace('.hbs', ''), error: 'parse failed' };
      return {
        filename,
        name: parsed.frontmatter.name || filename.replace('.hbs', ''),
        // 화면 표시용 한국어 이름/설명 (이슈 #23 1-2). 없으면 식별자 name으로 폴백.
        displayName: parsed.frontmatter.displayName || '',
        description: parsed.frontmatter.description || '',
        platforms: parsed.frontmatter.platforms || [],
        requiredFields: parsed.frontmatter.requiredFields || [],
        optionalFields: parsed.frontmatter.optionalFields || [],
        seoTitleTemplate: parsed.frontmatter.seo?.titleTemplate || '',
      };
    });
    return { templates };
  });

  app.get('/api/templates/:name', async (request) => {
    const { name } = request.params as { name: string };
    const filepath = path.join(templatesDir, `${name}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = parseTemplateFile(content, `${name}.hbs`);
    return {
      name,
      content: parsed?.body || content,
      raw: content,
      frontmatter: parsed?.frontmatter || {},
    };
  });

  app.post('/api/templates', async (request, reply) => {
    const { name, content } = request.body as { name?: string; content?: string };
    if (!name || !content) return reply.code(400).send({ error: 'name and content required' });
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (fs.existsSync(filepath)) return reply.code(409).send({ error: 'Template already exists' });
    const invalid = await validateTemplateContent(content);
    if (invalid) return reply.code(400).send({ error: invalid });
    fs.writeFileSync(filepath, content);
    logger.info({ templateName: safeName }, 'Template created');
    return { success: true, name: safeName };
  });

  app.put('/api/templates/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { content } = request.body as { content?: string };
    if (!content) return reply.code(400).send({ error: 'content required' });
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (!fs.existsSync(filepath)) return reply.code(404).send({ error: 'Template not found' });
    const invalid = await validateTemplateContent(content);
    if (invalid) return reply.code(400).send({ error: invalid });
    fs.writeFileSync(filepath, content);
    logger.info({ templateName: safeName }, 'Template updated');
    return { success: true, name: safeName };
  });

  app.delete('/api/templates/:name', async (request) => {
    const { name } = request.params as { name: string };
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
    fs.unlinkSync(filepath);
    logger.info({ templateName: safeName }, 'Template deleted');
    return { success: true };
  });

  app.post('/api/templates/:name/preview', async (request) => {
    const { name } = request.params as { name: string };
    const sampleData = (request.body as { sampleData?: Record<string, unknown> })?.sampleData || {};
    const filepath = path.join(templatesDir, `${name}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };

    try {
      const Handlebars = (await import('handlebars')).default;
      const content = fs.readFileSync(filepath, 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      const templateBody = fmMatch ? fmMatch[2] : content;

      const defaults: Record<string, unknown> = {
        productName: '무선 청소기 프리미엄',
        price: 189000,
        originalPrice: 249000,
        discountRate: 24,
        rating: 4.5,
        reviewCount: 1247,
        imageUrl: '',
        brand: '프리미엄 브랜드',
        categoryName: '가전제품',
        description: '강력한 흡입력과 가벼운 무게로 일상 청소를 혁신적으로 바꿔줍니다.',
        affiliateUrl: 'https://link.coupang.com/a/xxxxx',
        oneLineReview:
          '가성비와 성능의 균형이 좋은 무선청소기로, 가벼운 무게 덕분에 청소가 한결 수월해집니다.',
        pros: ['가볍고 조작이 쉬움', '흡입력 강함', '배터리 지속시간 김'],
        cons: ['먼지통 용량이 작음', '가격대가 높음'],
        specs: { 무게: '1.2kg', 흡입력: '150W', 배터리: '60분', 먼지통: '0.3L' },
        targetAudience: ['1~2인 가구', '반려동물 있는 집', '층간소음 걱정되는 분'],
        faqList: [
          { question: '배터리는 교체 가능한가요?', answer: '네, 별도 구매하여 교체 가능합니다.' },
        ],
        comparisonTable: {
          columns: ['제품A', '제품B'],
          rows: [
            { label: '가격', values: ['189,000원', '159,000원'] },
            { label: '무게', values: ['1.2kg', '1.8kg'] },
          ],
        },
        products: [
          {
            name: '제품A',
            price: 189000,
            brand: '브랜드A',
            description: '프리미엄 모델',
            pros: ['성능'],
            cons: ['가격'],
            affiliateUrl: '#',
          },
          {
            name: '제품B',
            price: 159000,
            brand: '브랜드B',
            description: '가성비 모델',
            pros: ['가격'],
            cons: ['무게'],
            affiliateUrl: '#',
          },
        ],
        productCount: 2,
        checklist: [
          { title: '사용 공간 확인', description: '청소할 면적에 맞는 배터리 시간을 선택하세요.' },
        ],
        budgetSteps: [
          {
            range: '20만원',
            productName: '보급형 모델',
            reason: '기본 기능 충족',
            affiliateUrl: '#',
          },
        ],
        topPick: {
          productName: '추천 제품',
          reason: '종합적으로 가장 균형잡힌 선택입니다.',
          affiliateUrl: '#',
        },
        mistakesToAvoid: [
          { title: '저렴한 것만 보지 않기', description: '내구성과 A/S까지 고려하세요.' },
        ],
        // Phase 2: benchmark posts + LLM first-person experience fields so the
        // rewritten template sections render in preview.
        topPosts: [
          {
            title: '직접 써본 무선청소기 솔직 후기',
            bloggername: '생활의발견',
            link: 'https://blog.naver.com/example/1',
            snippet: '한 달 매일 써본 결과 흡입력과 무게 밸런스가 생각보다 훨씬 좋아요.',
          },
          {
            title: '무선청소기 고를 때 꼭 비교해야 할 5가지',
            bloggername: '홈케어',
            link: 'https://blog.naver.com/example/2',
            snippet: '배터리, 무게, 소음, 머리 회전, A/S까지 체크하세요.',
          },
          {
            title: '강아지 있는 집에 딱인 무선청소기',
            bloggername: '댕댕이네',
            link: 'https://blog.naver.com/example/3',
            snippet: '털 빠짐 부위 청소가 한결 편해졌어요.',
          },
        ],
        experienceIntro:
          '저는 평소 청소기를 고를 때 스펙보다는 실사용감을 제일 중요하게 생각하는 편인데요, 이번에 직접 써보니 만족도가 꽤 높았습니다.',
        realUsageStory:
          '제가 직접 써보니 매일 20분씩 청소해도 배터리가 버텨서 좋더라고요. 솔직히 말씀드리면 처음엔 가벼움만 보고 샀는데, 흡입력까지 괜찮아서 깜짝 놀랐습니다.',
        whyIChoseIt:
          '저는 여러 모델을 비교하다가 A/S와 무게 밸런스 때문에 이 제품을 골랐어요. 가격이 조금 더 나가도 매일 쓰는 물건이니 충분히 값어치가 있다고 봅니다.',
        conclusion:
          '청소가 귀찮아서 안 사도 되겠다 생각했는데, 막상 써보니 일상이 한결 가벼워졌어요. 가벼운 무게와 흡입력이 중요한 분께 추천합니다.',
        usageTips: [
          '물걸질 전에 먼저 빨아들이면 패드 오염이 훨씬 줄어듭니다.',
          '트리거는 잠금 모드를 활용해 손목 피로를 줄이세요.',
          '먼지통은 2/3만 채워도 흡입력 저하가 적습니다.',
          '침구 청소는 주 2회, 30분 이내로 끊어주면 배터리가 오래갑니다.',
          '홀스 액세서리를 활용하면 틈새 청소가 쉬워집니다.',
        ],
        buyingChecklist: [
          '사용 공간(면적)에 맞는 배터리 지속시간인지 확인하세요.',
          '본체 무게와 손목 부담을 매장에서 직접 확인하세요.',
          '먼지통 용량과 분리 세척 방식을 비교하세요.',
          '필터 교체 주기와 소모품 가격을 확인하세요.',
          'A/S 기간과 무상 수리 조건을 확인하세요.',
        ],
        currentYear: new Date().getFullYear(),
      };

      const mergedData = { ...defaults, ...sampleData };
      // 헬퍼는 전역 Handlebars 싱글턴에 등록되므로 발행 경로와 같은 정의를 공유한다.
      // (여기서 따로 등록하면 프리뷰 호출 순서에 따라 발행 경로의 헬퍼를 덮어쓴다.)
      registerBuiltinTemplateHelpers();

      const compiled = Handlebars.compile(templateBody);
      const html = compiled(mergedData);
      return { html, name };
    } catch (error) {
      return { error: `Render failed: ${String(error)}` };
    }
  });
  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (socket, request) => {
      logger.info({ ip: request.ip }, 'WebSocket connected');

      socket.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          // Handle incoming messages (ping, subscribe, etc.)
          if (data.type === 'ping') {
            socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } catch {
          // Ignore invalid messages
        }
      });

      socket.on('close', () => {
        logger.info({ ip: request.ip }, 'WebSocket disconnected');
      });

      // Send initial status
      socket.send(
        JSON.stringify({
          type: 'status',
          data: {
            jobQueue: jobQueue.getStats(),
            scheduler: scheduler.isRunning() ? 'running' : 'stopped',
          },
        }),
      );
    });
  });
}
