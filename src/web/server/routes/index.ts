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
import { createTemplateEngine } from '@content/TemplateEngine';
import {
  resolveImageGenerator,
  resolveGeminiImageConfig,
  generateImagesSafely,
  interleaveImageSpecs,
} from '@content/ImageGenerator';
import { buildProductImagePrompts, buildSectionImageSpecs } from '@content/imagePrompts';
import { createPostAssembler } from '@content/PostAssembler';
import { expandCoupangWidgets } from '@content/CoupangWidgets';
import { fetchLinkPreviewCards, stylePublishHtml } from '@content/CoupangPreview';
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
 */
function toPlatformContent(meta: PostFileMeta, content: string): Record<string, unknown> {
  const source = (meta.platformContent || {}) as Record<string, Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    result[key] = {
      ...source[key],
      content: key === 'wordpress' ? `<!-- wp:html -->\n${content}\n<!-- /wp:html -->` : content,
    };
  }
  return result;
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
      limit = '50',
      offset = '0',
      fromDate,
      toDate,
    } = request.query as {
      status?: string;
      platform?: string;
      limit?: string;
      offset?: string;
      fromDate?: string;
      toDate?: string;
    };

    const posts = jobQueue.getPublishedPosts({
      status,
      platform,
      fromDate,
      toDate,
      limit: parseInt(limit),
    });

    const total = jobQueue.getPublishedPosts({ status, platform, fromDate, toDate }).length;

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
    // R5: gemini 설정 시에만 상품+섹션 이미지 생성 (미설정/실패 시 images 없이 발행)
    const images = resolveGeminiImageConfig()
      ? await generateImagesSafely(
          imageGenerator,
          interleaveImageSpecs(
            buildProductImagePrompts({
              productName: product.name,
              categoryName: product.categoryName,
              brand: product.brand,
            }).map((prompt) => ({ prompt })),
            buildSectionImageSpecs({
              productName: product.name,
              categoryName: product.categoryName,
            })
              .slice(0, 3)
              .map((spec) => ({ key: spec.key, prompt: spec.prompt })),
          ),
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
    const { content, title } = request.body as { content?: string; title?: string };
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
    meta.platformContent = toPlatformContent(meta, content);
    meta.updatedAt = new Date().toISOString();

    fs.writeFileSync(`./output/posts/${id}/post.html`, content);
    fs.writeFileSync(`./output/posts/${id}/meta.json`, JSON.stringify(meta, null, 2));

    return { success: true, post: { id, meta, content } };
  });

  app.delete('/api/posts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const files = readPostFiles(id);
    if (!files) {
      return reply.code(404).send({ error: 'Post not found' });
    }
    // 게시된 포스트는 삭제 대상이 아니다 — publish 성공 시 meta.status가 'PUBLISHED'로 기록된다.
    if (files.meta.status !== 'DRAFT') {
      return reply.code(400).send({ error: 'Published posts cannot be deleted' });
    }
    // generating 중이면 백그라운드 생성을 취소 표시한다 — 작업이 완료 시점에 도달해도
    // 저장하지 않으므로 삭제된 디렉터리가 부활하지 않는다.
    if (files.meta.generationStatus === 'generating') {
      cancelledGenerations.add(id);
    }
    if (!deleteDraftFiles(id)) {
      return reply.code(400).send({ error: 'Invalid post id' });
    }
    logger.info({ postId: id, cancelled: cancelledGenerations.has(id) }, 'Draft deleted');
    return { success: true };
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

  app.post('/api/posts/:id/publish', async (request) => {
    const { id } = request.params as { id: string };
    const { platform } = request.body as { platform?: string };

    const postPath = `./output/posts/${id}/meta.json`;
    const fs = await import('fs');

    if (!fs.existsSync(postPath)) {
      return { error: 'Post not found' };
    }

    const postMeta = JSON.parse(fs.readFileSync(postPath, 'utf-8'));
    let content = fs.readFileSync(`./output/posts/${id}/post.html`, 'utf-8');

    // AI 최종 다듬기(이슈 #12) — 기본 ON, body.aiPolish === false로 끈다.
    const { aiPolish: aiPolishOpt } = request.body as { aiPolish?: boolean };
    const aiPolish = aiPolishOpt !== false;
    if (aiPolish) {
      try {
        const generator = new ContentGenerator(resolveLlmConfigFromConfigManager());
        const polished = await generator.polishForPublish(content);
        if (polished && polished !== content) {
          content = polished;
          // 다듬어진 최종본을 저장해 편집화면에서도 동일 버전을 유지한다.
          fs.writeFileSync(`./output/posts/${id}/post.html`, content);
          for (const key of Object.keys(postMeta.platformContent || {})) {
            postMeta.platformContent[key].content = content;
          }
          fs.writeFileSync(postPath, JSON.stringify(postMeta, null, 2));
        }
      } catch (error) {
        // LLM 미설정/실패 시 원본으로 계속 진행한다(발행이 막히지 않게 한다).
        logger.warn({ postId: id, error: String(error) }, 'Publish-time AI polish skipped');
      }
    }

    const targetPlatforms = platform ? [platform] : Object.keys(postMeta.platformContent || {});

    const results: PublishAttempt[] = [];

    for (const platformName of targetPlatforms) {
      const adapter = platformRegistry.getAdapter(platformName);
      if (!adapter) {
        results.push({ platform: platformName, error: 'Platform adapter not found' });
        continue;
      }

      const platformContent = postMeta.platformContent?.[platformName] || {
        title: postMeta.title,
        content,
        tags: postMeta.tags,
        categories: postMeta.categories,
        meta: postMeta.meta,
        visibility: 'public',
        allowComments: true,
      };

      // 1) 링크 미리보기 카드 수집(이슈 #12) — product-link/event-link URL을 읽어
      //    상품 이미지·가격·평점 카드를 만든다. 실패 시 해당 링크만 텍스트 링크로 폴백.
      const coupangAdapter = affiliateRegistry.getAdapter('coupang');
      const previewCards = await fetchLinkPreviewCards(
        platformContent.content,
        coupangAdapter ?? undefined,
      ).catch(() => new Map<number, string>());

      // 2) 위젯 마커 확장 — platform을 전달해 네이버 발행 시 script 위젯을 iframe
      //    위젯으로 변환하고(이슈 #10), 위젯을 중앙 정렬 컨테이너로 감싼다(이슈 #12).
      platformContent.content = expandCoupangWidgets(platformContent.content, {
        platform: platformName,
        previewCards,
      });

      // 3) 발행 시점 전 위젯/이미지 스타일 정리(이슈 #12)
      platformContent.content = stylePublishHtml(platformContent.content);

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
          metadata: { result, draftId: id },
        });
        results.push({ platform: platformName, ...result, success: true });
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

  app.post('/api/templates', async (request) => {
    const { name, content } = request.body as { name?: string; content?: string };
    if (!name || !content) return { error: 'name and content required' };
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (fs.existsSync(filepath)) return { error: 'Template already exists' };
    fs.writeFileSync(filepath, content);
    logger.info({ templateName: safeName }, 'Template created');
    return { success: true, name: safeName };
  });

  app.put('/api/templates/:name', async (request) => {
    const { name } = request.params as { name: string };
    const { content } = request.body as { content?: string };
    if (!content) return { error: 'content required' };
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
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
      // Register helpers
      Handlebars.registerHelper('formatPrice', (p: number) =>
        typeof p === 'number' ? p.toLocaleString('ko-KR') : String(p),
      );
      Handlebars.registerHelper('renderStars', (r: number, max: number = 5) => {
        const full = Math.floor(r);
        let s = '★'.repeat(full);
        if (r - full >= 0.5) s += '☆';
        s += '☆'.repeat(max - full - (r - full >= 0.5 ? 1 : 0));
        return s;
      });
      Handlebars.registerHelper('math', (a: number, op: string, b: number) =>
        op === '+' ? a + b : a,
      );

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
