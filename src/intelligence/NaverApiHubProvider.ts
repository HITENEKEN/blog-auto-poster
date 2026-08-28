import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import { createHttpClient } from '@core/http';
import {
  KeywordProvider,
  KeywordData,
  KeywordResearchOptions,
  KeywordProviderConfig,
  CompetitorAnalyzer,
  CompetitorPost,
} from '@core/interfaces';

const logger = getLogger('naver-api-hub');

type NaverApiBlogItem = {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
};

type NaverApiNewsItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
};

type NaverApiSearchResponse<T = NaverApiBlogItem> = {
  lastBuildDate?: string;
  total: number;
  start: number;
  display: number;
  items: T[];
};

// ---------------------------------------------------------------------------
// Related-keyword extraction helpers (deterministic, dependency-free)
// ---------------------------------------------------------------------------

/** URL/protocol debris the sanitizer splits URLs into — never keywords. */
const URL_FRAGMENTS: Record<string, true> = {
  http: true,
  https: true,
  html: true,
  htm: true,
  aspx: true,
  asp: true,
  jsp: true,
  php: true,
  blog: true,
  naver: true,
  mail: true,
  news: true,
};

/** Generic blog/UI navigation words — not plausible search keywords. */
const NAV_WORDS: Record<string, true> = {
  출처: true,
  블로그: true,
  포스트: true,
  포스팅: true,
  댓글: true,
  공유: true,
  스크랩: true,
  구독: true,
  이웃: true,
  이웃추가: true,
  카페: true,
  프로필: true,
  검색: true,
  네이버: true,
  관련: true,
  메인: true,
  홈: true,
  채널: true,
  글쓰기: true,
  이미지: true,
  동영상: true,
  정보: true,
};

/** Grammar/filler words that survive particle stripping (조사/어미 붙은 어구). */
const WORD_STOPWORDS: Record<string, true> = {
  그리고: true,
  하지만: true,
  그러나: true,
  때문에: true,
  위해서: true,
  대해서: true,
  있습니다: true,
  합니다: true,
  입니다: true,
  했습니다: true,
  있는: true,
  이런: true,
  저런: true,
  수가: true,
  것을: true,
  하고: true,
  하는: true,
  했는데: true,
  위해: true,
  위한: true,
  대한: true,
  때문: true,
  같은: true,
  없는: true,
  해서: true,
  해도: true,
  됩니다: true,
  있다: true,
  없다: true,
};

/** Sentence-leading connectives; safe to drop from token starts. Real nouns
 * may begin with particle syllables (이륜차, 이벤트), so 이/가/은 are NOT
 * stripped at word start. */
const LEADING_CONNECTIVES = [
  '그리고나서',
  '그리고',
  '하지만',
  '그러나',
  '그래서',
  '그런데',
  '또한',
  '및',
  '하고',
  '또',
].sort((a, b) => b.length - a.length);

/** Trailing particles (조사), longest first. Stripped iteratively only while
 * the remainder stays ≥2 chars: '청소를' → '청소', but '가을' is kept
 * (remainder '가' would be a 1-char stub). */
const TRAILING_PARTICLES = [
  '으로서',
  '부터',
  '까지',
  '처럼',
  '보다',
  '마다',
  '에서',
  '으로',
  '에게',
  '한테',
  '이나',
  '이라',
  '라는',
  '라고',
  '이고',
  '하고',
  '조차',
  '이며',
  '은',
  '는',
  '을',
  '를',
  '이',
  '가',
  '도',
  '만',
  '의',
  '에',
  '와',
  '과',
  '랑',
  '로',
  '나',
  '며',
  '야',
].sort((a, b) => b.length - a.length);

/**
 * Turn a raw whitespace token from blog titles/descriptions into a plausible
 * search keyword, or null when it is junk.
 */
function normalizeKeywordToken(raw: string): string | null {
  let word = raw.trim();
  if (word.length < 2 || word.length > 15) return null;

  const lower = word.toLowerCase();
  if (
    Object.hasOwn(URL_FRAGMENTS, lower) ||
    Object.hasOwn(NAV_WORDS, word) ||
    Object.hasOwn(WORD_STOPWORDS, word)
  ) {
    return null;
  }
  if (/^\d+$/.test(word)) return null; // pure numbers

  for (const particle of LEADING_CONNECTIVES) {
    if (word.startsWith(particle) && word.length - particle.length >= 2) {
      word = word.slice(particle.length);
      break;
    }
  }

  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const particle of TRAILING_PARTICLES) {
      if (word.endsWith(particle) && word.length - particle.length >= 2) {
        word = word.slice(0, -particle.length);
        stripped = true;
        break;
      }
    }
  }

  if (word.length < 2) return null;
  const finalLower = word.toLowerCase();
  if (
    Object.hasOwn(URL_FRAGMENTS, finalLower) ||
    Object.hasOwn(NAV_WORDS, word) ||
    Object.hasOwn(WORD_STOPWORDS, word)
  ) {
    return null;
  }

  // Pure-Latin debris: keep only brand/model-like tokens ('SSD', 'Galaxy',
  // 'samsung'); lowercase fragments shorter than 4 chars ('com', 'www') die.
  if (/^[a-zA-Z]+$/.test(word) && !/[A-Z]/.test(word) && word.length < 4) {
    return null;
  }

  return word;
}

// ============================================================================
// Naver API Hub - Keyword Provider (신규)
// 기존 NaverKeywordProvider(DataLab 방식)는 유지하고 별도로 구현
// ============================================================================

export class NaverApiHubKeywordProvider implements KeywordProvider {
  readonly name = 'naver-api-hub';
  private client: ReturnType<typeof createHttpClient>;
  private cache = getCache<KeywordData[]>('naver-api-hub-keywords');
  private searchCache = getCache<NaverApiSearchResponse>('naver-api-hub-search');
  private newsCache = getCache<NaverApiSearchResponse<NaverApiNewsItem>>('naver-api-hub-news');
  private apiKeyId: string;
  private apiKey: string;

  constructor(config: KeywordProviderConfig) {
    this.apiKeyId = config.apiKey || '';
    this.apiKey = config.apiSecret || '';

    this.client = createHttpClient({
      baseURL: config.baseUrl || 'https://naverapihub.apigw.ntruss.com/search/v1',
      timeout: 30000,
      maxRetries: 3,
      defaultHeaders: {
        'X-NCP-APIGW-API-KEY-ID': this.apiKeyId,
        'X-NCP-APIGW-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]> {
    if (!this.apiKeyId || !this.apiKey) {
      logger.warn('Naver API Hub credentials not configured');
      return [];
    }

    const results: KeywordData[] = [];

    for (const keyword of keywords) {
      const cacheKey = `hub-research:${keyword}:${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey) as KeywordData[] | null;
      if (cached) {
        results.push(...cached);
        continue;
      }

      try {
        // 1. Blog search to estimate competition
        const blogResults = await this.searchBlog(keyword, options?.limit || 20);

        // 2. Get related keywords from blog search results
        const related = this.extractRelatedKeywords(blogResults, keyword);

        const keywordData: KeywordData = {
          keyword,
          volume: this.estimateVolumeFromResults(blogResults),
          competition: this.calculateCompetition(blogResults),
          trend: this.calculateTrend(blogResults),
          related,
          source: 'naver-api-hub',
          metadata: {
            totalResults: blogResults.total,
            displayCount: blogResults.items?.length || 0,
            topBlogs: blogResults.items?.slice(0, 5).map((item) => item.bloggername) || [],
          },
        };

        results.push(keywordData);
        this.cache.set(cacheKey, [keywordData], 86400); // 24h cache
      } catch (error) {
        logger.error({ keyword, error: String(error) }, 'Naver API Hub keyword research failed');
      }
    }

    return results;
  }

  /**
   * Search Naver blogs via API Hub
   */
  async searchBlog(
    keyword: string,
    limit: number = 20,
    sort: string = 'sim',
  ): Promise<NaverApiSearchResponse> {
    const cacheKey = `blog:${keyword}:${limit}:${sort}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<NaverApiSearchResponse>('/blog', {
        params: {
          query: keyword,
          display: Math.min(limit, 100),
          start: 1,
          sort: sort, // sim(유사도), date(최신)
        },
      });

      this.searchCache.set(cacheKey, response.data, 3600); // 1h cache
      return response.data;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'API Hub blog search failed');
      throw error;
    }
  }

  /**
   * Search Naver news via API Hub (optional, for trend detection)
   */
  async searchNews(
    keyword: string,
    limit: number = 10,
  ): Promise<NaverApiSearchResponse<NaverApiNewsItem>> {
    const cacheKey = `news:${keyword}:${limit}`;
    const cached = this.newsCache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get<NaverApiSearchResponse<NaverApiNewsItem>>('/news', {
        params: {
          query: keyword,
          display: Math.min(limit, 100),
          start: 1,
          sort: 'date',
        },
      });

      this.newsCache.set(cacheKey, response.data, 1800); // 30min cache
      return response.data;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'API Hub news search failed');
      throw error;
    }
  }

  /**
   * Extract related keywords from blog search results (titles + descriptions)
   */
  private extractRelatedKeywords(
    blogResults: NaverApiSearchResponse,
    seedKeyword: string,
  ): string[] {
    const seedLower = seedKeyword.toLowerCase();
    const counts = new Map<string, { count: number; word: string }>();

    for (const item of blogResults.items || []) {
      const text = `${item.title || ''} ${item.description || ''}`
        .replace(/<[^>]*>/g, '')
        .replace(/[^\uAC00-\uD7A3a-zA-Z0-9\s]/g, ' ');

      for (const raw of text.split(/\s+/)) {
        const word = normalizeKeywordToken(raw);
        if (!word) continue;
        const key = word.toLowerCase();
        if (key === seedLower) continue;
        const entry = counts.get(key);
        if (entry) entry.count += 1;
        else counts.set(key, { count: 1, word });
      }
    }

    return Array.from(counts.entries())
      .filter(([, entry]) => entry.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 15)
      .map(([, entry]) => entry.word);
  }

  /**
   * Estimate search volume based on total result count
   * More total results = higher interest/competition
   */
  private estimateVolumeFromResults(blogResults: NaverApiSearchResponse): number {
    const total = blogResults.total || 0;
    // Normalize: log scale to prevent extreme values
    if (total === 0) return 0;
    const estimated = Math.round(Math.log10(total + 1) * 3000);
    return Math.min(estimated, 100000);
  }

  /**
   * Calculate competition score (0-1) based on recent post density
   */
  private calculateCompetition(blogResults: NaverApiSearchResponse): number {
    const items = blogResults.items || [];
    if (items.length === 0) return 1;

    // Count posts within last 6 months as proxy for competition
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    const cutoff = sixMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '');

    let recentPosts = 0;
    let validDates = 0;

    for (const item of items) {
      const date = item.postdate || '';
      if (/^\d{8}$/.test(date)) {
        validDates++;
        if (date >= cutoff) recentPosts++;
      }
    }

    if (validDates === 0) return 0.5;
    // More recent posts = higher competition
    return Math.min(recentPosts / validDates + 0.2, 1);
  }

  /**
   * Calculate trend based on post recency distribution
   */
  private calculateTrend(blogResults: NaverApiSearchResponse): 'rising' | 'falling' | 'stable' {
    const items = blogResults.items || [];
    if (items.length < 4) return 'stable';

    const now = new Date();
    const threeMonthsAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const nineMonthsAgo = new Date(now.getTime() - 270 * 24 * 60 * 60 * 1000);

    let recent = 0; // last 3 months
    let older = 0; // 3-9 months ago

    for (const item of items) {
      const dateStr = item.postdate || '';
      if (!/^\d{8}$/.test(dateStr)) continue;
      const d = new Date(
        parseInt(dateStr.substring(0, 4)),
        parseInt(dateStr.substring(4, 6)) - 1,
        parseInt(dateStr.substring(6, 8)),
      );
      if (d >= threeMonthsAgo) recent++;
      else if (d >= nineMonthsAgo && d < threeMonthsAgo) older++;
    }

    const change = older > 0 ? (recent - older) / older : recent > 0 ? 1 : 0;
    if (change > 0.2) return 'rising';
    if (change < -0.2) return 'falling';
    return 'stable';
  }

  async validateConfig(): Promise<boolean> {
    if (!this.apiKeyId || !this.apiKey) return false;

    try {
      const result = await this.searchBlog('테스트', 1);
      return !!result;
    } catch {
      return false;
    }
  }
}

// ============================================================================
// Naver API Hub - Blog Analyzer (신규)
// 기존 NaverBlogAnalyzer(openapi.naver.com 방식)는 유지하고 별도로 구현
// ============================================================================

export class NaverApiHubBlogAnalyzer implements CompetitorAnalyzer {
  readonly name = 'naver-blog-hub';
  private client: ReturnType<typeof createHttpClient>;
  private cache = getCache<CompetitorPost[]>('naver-api-hub-blog-analysis');
  private apiKeyId: string;
  private apiKey: string;

  constructor(config: { apiKey: string; apiSecret: string; baseUrl?: string }) {
    this.apiKeyId = config.apiKey;
    this.apiKey = config.apiSecret;

    this.client = createHttpClient({
      baseURL: config.baseUrl || 'https://naverapihub.apigw.ntruss.com/search/v1',
      timeout: 30000,
      maxRetries: 3,
      defaultHeaders: {
        'X-NCP-APIGW-API-KEY-ID': this.apiKeyId,
        'X-NCP-APIGW-API-KEY': this.apiKey,
      },
    });
  }

  async analyze(
    keyword: string,
    platforms: string[] = ['naver-blog-hub'],
    limit: number = 10,
  ): Promise<CompetitorPost[]> {
    if (!platforms.includes('naver-blog-hub')) return [];

    const cacheKey = `analyze:${keyword}:${limit}`;
    const cached = this.cache.get(cacheKey) as CompetitorPost[] | null;
    if (cached) return cached;

    try {
      const response = await this.client.get<NaverApiSearchResponse>('/blog', {
        params: {
          query: keyword,
          display: Math.min(limit, 100),
          start: 1,
          sort: 'sim', // 유사도 순
        },
      });

      const posts: CompetitorPost[] =
        response.data.items?.map((item, index) => ({
          platform: 'naver-blog',
          url: item.link,
          title: this.stripHtml(item.title),
          excerpt: this.stripHtml(item.description || ''),
          views: 0,
          likes: 0,
          publishedAt: item.postdate || '',
          author: item.bloggername || '',
          structure: [],
          affiliateLinks: [],
          ctaPatterns: [],
          score: this.calculateScore(index, limit),
          metadata: {
            bloggerlink: item.bloggerlink || '',
            postdate: item.postdate || '',
          },
        })) || [];

      // Enrich top posts with content analysis
      for (const post of posts.slice(0, 5)) {
        await this.enrichPost(post);
      }

      this.cache.set(cacheKey, posts, 3600); // 1h cache
      return posts;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'Naver API Hub blog analysis failed');
      return [];
    }
  }

  private async enrichPost(post: CompetitorPost): Promise<void> {
    try {
      const response = await this.client.get(post.url, { validateStatus: () => true });
      const cheerio = (await import('cheerio')).default;
      const $ = cheerio.load(response.data);

      // Extract headings structure
      const headings = $('h1, h2, h3, h4')
        .map((_, el) => ({
          level: parseInt(('tagName' in el ? el.tagName : '').charAt(1)) || 1,
          text: $(el).text().trim(),
        }))
        .get();

      post.structure = headings;

      // Count images
      post.metadata = { ...post.metadata, imageCount: $('img').length };

      // Find affiliate links
      const affiliateLinks = $('a[href*="coupang"], a[href*="link.coupang"], a[href*="partners"]')
        .map((_, el) => $(el).attr('href'))
        .get();
      post.affiliateLinks = affiliateLinks.filter(Boolean) as string[];

      // Extract CTA patterns
      const ctaTexts = $('a, button')
        .map((_, el) => $(el).text().trim())
        .get();
      post.ctaPatterns = ctaTexts
        .filter((t) => /구매|확인|자세히|더보기|최저가|할인/.test(t))
        .slice(0, 5);
    } catch (error) {
      logger.warn({ url: post.url, error: String(error) }, 'Failed to enrich post via API Hub');
    }
  }

  private calculateScore(index: number, total: number): number {
    return 1 - (index / Math.max(total, 1)) * 0.5;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '');
  }
}
