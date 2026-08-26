// @ts-nocheck
import { FastifyInstance } from 'fastify';
import { getLogger } from '@core/logger';
import { ConfigManager, AffiliateRegistry, PlatformAdapter, JobQueue, CronScheduler } from '@core/interfaces';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('api-routes');

export interface RouteContext {
  configManager: ConfigManager;
  affiliateRegistry: AffiliateRegistry;
  platformRegistry: Map<string, PlatformAdapter>;
  jobQueue: JobQueue;
  scheduler: CronScheduler;
}

export async function registerRoutes(app: FastifyInstance, context: RouteContext): Promise<void> {
  const { configManager, affiliateRegistry, platformRegistry, jobQueue, scheduler } = context;

  // Dashboard stats
  app.get('/api/dashboard/stats', async () => {
    const jobStats = jobQueue.getStats();
    const publishedPosts = jobQueue.getPublishedPosts({ limit: 1000 });
    const affiliateStatus = await affiliateRegistry.validateAll();
    const platformStatus: Record<string, boolean> = {};

    for (const [name, adapter] of platformRegistry) {
      try {
        platformStatus[name] = await adapter.validateCredentials();
      } catch {
        platformStatus[name] = false;
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayPosts = publishedPosts.filter(p => new Date(p.published_at) >= today);

    return {
      totalPosts: publishedPosts.length,
      todayPosts: todayPosts.length,
      publishedPosts: publishedPosts.filter(p => p.status === 'published').length,
      failedPosts: publishedPosts.filter(p => p.status === 'failed').length,
      successRate: publishedPosts.length > 0
        ? publishedPosts.filter(p => p.status === 'published').length / publishedPosts.length
        : 0,
      jobQueue: jobStats,
      affiliates: affiliateStatus,
      platforms: platformStatus,
      recentPosts: publishedPosts.slice(0, 10).map(p => ({
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
    const blogs: any[] = [];

    for (const [name, adapter] of platformRegistry) {
      const config = configManager.getPlatformConfig(name);
      let categories: any[] = [];
      let lastPost: any = null;

      try {
        categories = await adapter.getCategories();
        const posts = jobQueue.getPublishedPosts({ platform: name, limit: 1 });
        lastPost = posts[0] || null;
      } catch (error) {
        logger.warn({ platform: name, error: String(error) }, 'Failed to get blog info');
      }

      const isValid = await adapter.validateCredentials().catch(() => false);

      blogs.push({
        name,
        platform: name,
        connected: isValid,
        categories: categories.map(c => ({ id: c.id, name: c.name })),
        lastPost: lastPost ? {
          id: lastPost.post_id,
          title: lastPost.title,
          url: lastPost.url,
          publishedAt: lastPost.published_at,
          status: lastPost.status,
        } : null,
        config: config ? { ...config, password: '***', appPassword: '***', apiKey: '***' } : null,
      });
    }

    return { blogs };
  });

  app.post('/api/blogs/:name/sync-categories', async (request) => {
    const { name } = request.params as { name: string };
    const adapter = platformRegistry.get(name);

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
    const { q, limit = '20' } = request.query as any;

    if (!q || !q.trim()) {
      return { trending: [], totalResults: 0, searchedAt: new Date().toISOString(), source: 'naver-api-hub', error: 'Query required' };
    }

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return { trending: [], totalResults: 0, searchedAt: new Date().toISOString(), source: 'naver-api-hub', error: 'Naver API Hub credentials not configured' };
    }

    const { NaverApiHubKeywordProvider } = await import('../../../intelligence/NaverApiHubProvider.js');
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const results = await provider.research([q.trim()], { limit: parseInt(limit) });
      const blogData = await provider.searchBlog(q.trim(), parseInt(limit));

      return {
        trending: results,
        totalResults: blogData.total || 0,
        blogs: (blogData.items || []).slice(0, 10).map((item: any) => ({
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
      return { trending: [], totalResults: 0, blogs: [], searchedAt: new Date().toISOString(), source: 'naver-api-hub', error: String(error) };
    }
  });

  app.get('/api/keywords/:keyword/blogs', async (request) => {
    const { keyword } = request.params as any;
    const { limit = '10', sort = 'sim' } = request.query as any;

    const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) {
      return { error: 'Naver API Hub credentials not configured', blogs: [] };
    }

    const { NaverApiHubKeywordProvider } = await import('../../../intelligence/NaverApiHubProvider.js');
    const provider = new NaverApiHubKeywordProvider(hubConfig);

    try {
      const blogData = await provider.searchBlog(keyword, parseInt(limit), sort);
      return {
        blogs: (blogData.items || []).map((item: any) => ({
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
    const { keywords, providers = ['naver-api-hub'], limit = 20 } = request.body as any;

    if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return { error: 'Keywords array required' };
    }

    const allResults: any[] = [];

    // Naver API Hub
    if (providers.includes('naver-api-hub')) {
      const hubConfig = configManager.getKeywordProviderConfig('naver-api-hub');
      if (hubConfig?.apiKey && hubConfig?.apiSecret) {
        const { NaverApiHubKeywordProvider } = await import('../../../intelligence/NaverApiHubProvider.js');
        const provider = new NaverApiHubKeywordProvider(hubConfig);
        const hubResults = await provider.research(keywords, { limit });
        allResults.push(...hubResults);
      }
    }

    // Legacy providers (DataLab, Google Trends, Coupang)
    if (providers.includes('naver') || providers.includes('google-trends') || providers.includes('coupang')) {
      const researcher = await import('../../../intelligence/KeywordResearcher.js').then(m => m.createKeywordResearcher());
      const { NaverKeywordProvider, GoogleTrendsProvider, CoupangKeywordProvider } =
        await import('../../../intelligence/KeywordResearcher.js');

      const naverConfig = configManager.getKeywordProviderConfig('naver');
      const googleConfig = configManager.getKeywordProviderConfig('google-trends');

      if (naverConfig?.enabled) researcher.registerProvider(new NaverKeywordProvider(naverConfig));
      if (googleConfig?.enabled) researcher.registerProvider(new GoogleTrendsProvider(googleConfig));
      researcher.registerProvider(new CoupangKeywordProvider());

      const legacyProviders = providers.filter((p: string) => p !== 'naver-api-hub');
      if (legacyProviders.length > 0) {
        const results = await researcher.research(keywords, { providers: legacyProviders, limit });
        allResults.push(...results);
      }
    }

    // Sort by volume * (1-competition)
    allResults.sort((a, b) => (b.volume * (1 - b.competition)) - (a.volume * (1 - a.competition)));

    return { keywords: allResults.slice(0, limit), providers };
  });
  // Posts management
  app.get('/api/posts', async (request) => {
    const { status, platform, template, limit = '50', offset = '0', fromDate, toDate } = request.query as any;

    const posts = jobQueue.getPublishedPosts({
      status,
      platform,
      fromDate,
      toDate,
      limit: parseInt(limit),
    });

    const total = jobQueue.getPublishedPosts({ status, platform, fromDate, toDate }).length;

    return {
      posts: posts.map(p => ({
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
    const { template, productId, platform, subId } = request.body as any;

    if (!template || !productId || !platform) {
      return { error: 'template, productId, and platform are required' };
    }

    const coupangAdapter = affiliateRegistry.getAdapter('coupang');
    if (!coupangAdapter) {
      return { error: 'Coupang adapter not initialized' };
    }

    const product = await coupangAdapter.getProductDetails(productId);

    const { createTemplateEngine } = await import('@content/TemplateEngine');
    const { createImageGenerator } = await import('@content/ImageGenerator');
    const { createPostAssembler } = await import('@content/PostAssembler');

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

    // Save to output directory
    const outputDir = `./output/posts/${post.id}`;
    const fs = await import('fs');
    const path = await import('path');
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'post.html'), post.content);
    fs.writeFileSync(path.join(outputDir, 'meta.json'), JSON.stringify(post.meta, null, 2));
    fs.writeFileSync(path.join(outputDir, 'platform-content.json'), JSON.stringify(post.platformContent, null, 2));

    return { post };
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

    const results: any[] = [];

    for (const platformName of targetPlatforms) {
      const adapter = platformRegistry.get(platformName);
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
    return { jobs: jobs.map(j => ({
      name: j.name,
      type: j.config.type,
      cron: j.config.cron,
      enabled: j.config.enabled,
      priority: j.config.priority,
      config: j.config.config,
    })) };
  });

  app.post('/api/scheduler/jobs/:id/trigger', async (request) => {
    const { id } = request.params as { id: string };
    const jobId = await scheduler.triggerJob(id);
    return { jobId };
  });

  app.put('/api/scheduler/config', async (request) => {
    const updates = request.body as any;
    scheduler.updateConfig(updates);

    // Persist to config
    const currentConfig = configManager.getAll().scheduler || { enabled: false, jobs: [] };
    const newConfig = { ...currentConfig, ...updates };
    configManager.set('scheduler', newConfig);

    return { success: true, config: newConfig };
  });

  // Analytics
  app.get('/api/analytics', async (request) => {
    const { days = '30', platform } = request.query as any;
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
      successRate: posts.length > 0
        ? posts.filter(p => p.status === 'published').length / posts.length
        : 0,
    };
  });


  // Templates CRUD
  const templatesDir = path.resolve(process.cwd(), 'templates');
  const yaml = require('js-yaml') as typeof import('js-yaml');

  const parseTemplateFile = (content: string, filename: string) => {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) return null;
    try {
      const frontmatter = yaml.load(fmMatch[1]) as any;
      return { frontmatter, body: fmMatch[2], raw: content };
    } catch { return null; }
  };

  app.get('/api/templates', async () => {
    if (!fs.existsSync(templatesDir)) return { templates: [] };
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.hbs'));
    const templates = files.map(filename => {
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
    const { name } = request.params as any;
    const filepath = path.join(templatesDir, `${name}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
    const content = fs.readFileSync(filepath, 'utf-8');
    const parsed = parseTemplateFile(content, `${name}.hbs`);
    return { name, content: parsed?.body || content, raw: content, frontmatter: parsed?.frontmatter || {} };
  });

  app.post('/api/templates', async (request) => {
    const { name, content } = request.body as any;
    if (!name || !content) return { error: 'name and content required' };
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (fs.existsSync(filepath)) return { error: 'Template already exists' };
    fs.writeFileSync(filepath, content);
    logger.info({ templateName: safeName }, 'Template created');
    return { success: true, name: safeName };
  });

  app.put('/api/templates/:name', async (request) => {
    const { name } = request.params as any;
    const { content } = request.body as any;
    if (!content) return { error: 'content required' };
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
    fs.writeFileSync(filepath, content);
    logger.info({ templateName: safeName }, 'Template updated');
    return { success: true, name: safeName };
  });

  app.delete('/api/templates/:name', async (request) => {
    const { name } = request.params as any;
    const safeName = name.replace(/[^a-zA-Z0-9-_]/g, '');
    const filepath = path.join(templatesDir, `${safeName}.hbs`);
    if (!fs.existsSync(filepath)) return { error: 'Template not found' };
    fs.unlinkSync(filepath);
    logger.info({ templateName: safeName }, 'Template deleted');
    return { success: true };
  });

  app.post('/api/templates/:name/preview', async (request) => {
    const { name } = request.params as any;
    const sampleData = (request.body as any)?.sampleData || {};
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
        oneLineReview: '가성비와 성능의 균형이 좋은 무선청소기로, 가벼운 무게 덕분에 청소가 한결 수월해집니다.',
        pros: ['가볍고 조작이 쉬움', '흡입력 강함', '배터리 지속시간 김'],
        cons: ['먼지통 용량이 작음', '가격대가 높음'],
        specs: { '무게': '1.2kg', '흡입력': '150W', '배터리': '60분', '먼지통': '0.3L' },
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
          { name: '제품A', price: 189000, brand: '브랜드A', description: '프리미엄 모델', pros: ['성능'], cons: ['가격'], affiliateUrl: '#' },
          { name: '제품B', price: 159000, brand: '브랜드B', description: '가성비 모델', pros: ['가격'], cons: ['무게'], affiliateUrl: '#' },
        ],
        productCount: 2,
        checklist: [
          { title: '사용 공간 확인', description: '청소할 면적에 맞는 배터리 시간을 선택하세요.' },
        ],
        budgetSteps: [{ range: '20만원', productName: '보급형 모델', reason: '기본 기능 충족', affiliateUrl: '#' }],
        topPick: { productName: '추천 제품', reason: '종합적으로 가장 균형잡힌 선택입니다.', affiliateUrl: '#' },
        mistakesToAvoid: [{ title: '저렴한 것만 보지 않기', description: '내구성과 A/S까지 고려하세요.' }],
        currentYear: new Date().getFullYear(),
      };

      const mergedData = { ...defaults, ...sampleData };
      // Register helpers
      Handlebars.registerHelper('formatPrice', (p: number) => typeof p === 'number' ? p.toLocaleString('ko-KR') : String(p));
      Handlebars.registerHelper('renderStars', (r: number, max: number = 5) => {
        const full = Math.floor(r); let s = '★'.repeat(full);
        if (r - full >= .5) s += '☆';
        s += '☆'.repeat(max - full - ((r - full >= .5) ? 1 : 0));
        return s;
      });
      Handlebars.registerHelper('math', (a: number, op: string, b: number) => op === '+' ? a + b : a);

      const compiled = Handlebars.compile(templateBody);
      const html = compiled(mergedData);
      return { html, name };
    } catch (error) {
      return { error: `Render failed: ${String(error)}` };
    }
  });
  app.register(async (fastify) => {
    fastify.get('/ws', { websocket: true }, (connection, request) => {
      logger.info({ ip: request.ip }, 'WebSocket connected');

      connection.socket.on('message', (message) => {
        try {
          const data = JSON.parse(message.toString());
          // Handle incoming messages (ping, subscribe, etc.)
          if (data.type === 'ping') {
            connection.socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          }
        } catch {
          // Ignore invalid messages
        }
      });

      connection.socket.on('close', () => {
        logger.info({ ip: request.ip }, 'WebSocket disconnected');
      });

      // Send initial status
      connection.socket.send(JSON.stringify({
        type: 'status',
        data: {
          jobQueue: jobQueue.getStats(),
          scheduler: scheduler.isRunning() ? 'running' : 'stopped',
        },
      }));
    });
  });
}