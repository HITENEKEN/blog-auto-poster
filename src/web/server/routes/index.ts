import { FastifyInstance } from 'fastify';
import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import {
  ConfigManager,
  KeywordData,
  PlatformCredentials,
  PlatformCategory,
  SchedulerConfig,
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
import { createImageGenerator } from '@content/ImageGenerator';
import { createPostAssembler } from '@content/PostAssembler';
import { expandCoupangWidgets } from '@content/CoupangWidgets';
import { generateDraftFromKeyword } from '@content/KeywordPostGenerator';
import { savePostFiles, readPostFiles, listDrafts, type PostFileMeta } from '@content/postStorage';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

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

  // Credential validation hits external APIs; cache results so 30-60s dashboard
  // polling doesn't burn provider quotas on every request.
  type DashboardValidation = {
    affiliates: Record<string, boolean>;
    platforms: Record<string, boolean>;
  };
  type KeywordRow = {
    keyword: string;
    volume: number;
    competition: number;
    related?: string[];
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

      return {
        trending: results,
        totalResults: blogData.total || 0,
        blogs: (blogData.items || []).slice(0, 10).map((item) => ({
          title: item.title?.replace(/<[^>]*>/g, '') || '',
          link: item.link,
          bloggername: item.bloggername,
          postdate: item.postdate,
          description: item.description?.replace(/<[^>]*>/g, '').substring(0, 200),
        })),
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

  // Keywords - Top 20 (query-less feed aggregated from seed keywords via Naver API Hub)
  app.get('/api/keywords/top', async (request) => {
    const { seeds, limit = '20' } = request.query as { seeds?: string; limit?: string };
    const topLimit = parseInt(limit) || 20;

    let seedList: string[] = [];
    if (typeof seeds === 'string' && seeds.trim()) {
      seedList = seeds
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean);
    } else {
      seedList = (configManager.get('keywords.topSeeds', []) as string[]) || [];
    }

    if (seedList.length === 0) {
      return { keywords: [], source: 'naver-api-hub', error: 'No seed keywords configured' };
    }
    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return {
        keywords: [],
        source: 'naver-api-hub',
        error: 'Naver API Hub credentials not configured',
      };
    }

    const { NaverApiHubKeywordProvider } =
      await import('../../../intelligence/NaverApiHubProvider.js');
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const seen = new Set<string>();
      const all: KeywordRow[] = [];

      // Stage 1: research each seed (24h-cached inside the provider).
      // Collect related keywords from blog-search titles — no extra API calls.
      const candidateSet = new Set<string>();
      for (const seed of seedList) {
        const results = await provider.research([seed], { limit: topLimit });
        for (const r of results) {
          if (r.keyword && !seen.has(r.keyword)) {
            seen.add(r.keyword);
            all.push(r);
          }
          for (const rel of r.related || []) {
            if (rel && rel !== seed) candidateSet.add(rel);
          }
        }
      }

      // Stage 2: research related candidates (cap 40) in batches of 5;
      // individual failures are logged and skipped.
      const candidates = [...candidateSet].slice(0, 40);
      for (let i = 0; i < candidates.length; i += 5) {
        const batch = candidates.slice(i, i + 5);
        const rows = await Promise.all(
          batch.map(async (kw) => {
            try {
              const res = await provider.research([kw], { limit: topLimit });
              return res[0] || null;
            } catch (error) {
              logger.error(
                { keyword: kw, error: String(error) },
                'Candidate keyword research failed',
              );
              return null;
            }
          }),
        );
        for (const row of rows) {
          if (row?.keyword && !seen.has(row.keyword)) {
            seen.add(row.keyword);
            all.push(row);
          }
        }
      }

      all.sort((a, b) => b.volume * (1 - b.competition) - a.volume * (1 - a.competition));
      return { keywords: all.slice(0, topLimit), source: 'naver-api-hub', estimated: true };
    } catch (error) {
      logger.error({ error: String(error) }, 'Top keywords aggregation failed');
      return { keywords: [], source: 'naver-api-hub', error: String(error) };
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
      posts: posts.map((p) => ({
        id: p.id,
        jobId: p.job_id,
        platform: p.platform,
        postId: p.post_id,
        url: p.url,
        title: p.title,
        template: p.template,
        productId: p.product_id,
        status: p.status,
        publishedAt: p.published_at,
        metadata: p.metadata ? JSON.parse(p.metadata) : null,
      })),
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

    const imageGenerator = createImageGenerator('placeholder', './output/images');
    const postAssembler = createPostAssembler(templateEngine, imageGenerator);

    const post = await postAssembler.assemble({
      template,
      affiliateData: product,
      platform,
      subId,
    });

    savePostFiles(post);

    return { post };
  });

  app.post('/api/posts/generate-from-keyword', async (request, reply) => {
    const { keyword, template } = request.body as { keyword?: string; template?: string };
    if (!keyword || !template) {
      return reply.code(400).send({ error: 'keyword and template are required' });
    }

    try {
      const post = await generateDraftFromKeyword({ keyword, templateName: template });
      return { post };
    } catch (error) {
      logger.error({ error: String(error) }, 'Keyword draft generation failed');
      return reply.code(500).send({ error: String(error) });
    }
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
    return { post: { id, meta: files.meta, content: files.content } };
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

    const meta = files.meta;
    if (title) meta.title = title;
    meta.platformContent = toPlatformContent(meta, content);
    meta.updatedAt = new Date().toISOString();

    fs.writeFileSync(`./output/posts/${id}/post.html`, content);
    fs.writeFileSync(`./output/posts/${id}/meta.json`, JSON.stringify(meta, null, 2));

    return { success: true, post: { id, meta, content } };
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
    const content = fs.readFileSync(`./output/posts/${id}/post.html`, 'utf-8');

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

      // 쿠팡 위젯 마커를 실제 파트너스 HTML로 확장 (폴백 브랜치 포함 모든 content 대상)
      platformContent.content = expandCoupangWidgets(platformContent.content);

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
          metadata: { result },
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
          metadata: { error: String(error) },
        });
        results.push({ platform: platformName, error: String(error), success: false });
      }
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
