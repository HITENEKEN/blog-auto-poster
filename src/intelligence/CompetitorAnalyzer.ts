import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import { createHttpClient } from '@core/http';
import { CompetitorAnalyzer, CompetitorPost, CompetitorAnalysisOptions } from '@core/interfaces';
import * as cheerio from 'cheerio';

const logger = getLogger('competitor-analyzer');

type NaverBlogSearchItem = {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  bloggerlink: string;
  postdate: string;
};

type YouTubeSearchItem = {
  id: { videoId?: string };
  snippet: {
    title: string;
    description: string;
    channelTitle: string;
    channelId: string;
    publishedAt: string;
  };
};

type YouTubeVideoItem = {
  id: string;
  statistics?: { viewCount?: string; likeCount?: string };
  contentDetails?: { duration?: string };
};

type YouTubeVideoStats = { views: number; likes: number; duration?: string };

export class NaverBlogAnalyzer implements CompetitorAnalyzer {
  readonly name = 'naver-blog';
  private client = createHttpClient({
    baseURL: 'https://openapi.naver.com/v1/search',
    timeout: 30000,
    maxRetries: 3,
  });
  private cache = getCache<CompetitorPost[]>('naver-blog-analysis');
  private clientId: string;
  private clientSecret: string;

  constructor(config: { clientId: string; clientSecret: string }) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.client.defaults.headers.common['X-Naver-Client-Id'] = this.clientId;
    this.client.defaults.headers.common['X-Naver-Client-Secret'] = this.clientSecret;
  }

  async analyze(
    keyword: string,
    platforms: string[] = ['naver-blog'],
    limit: number = 10,
  ): Promise<CompetitorPost[]> {
    if (!platforms.includes('naver-blog')) return [];

    const cacheKey = `analyze:${keyword}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get('/blog', {
        params: {
          query: keyword,
          display: Math.min(limit, 100),
          sort: 'sim', // similarity
        },
      });

      const posts: CompetitorPost[] =
        response.data.items?.map((item: NaverBlogSearchItem, index: number) => ({
          platform: 'naver-blog',
          url: item.link,
          title: this.stripHtml(item.title),
          description: this.stripHtml(item.description),
          blogName: item.bloggername,
          blogUrl: item.bloggerlink,
          publishDate: item.postdate,
          views: 0, // Not provided by API
          likes: 0,
          structure: [],
          affiliateLinks: [],
          ctaPatterns: [],
          score: this.calculateScore(index, limit),
        })) || [];

      // Fetch content for top posts to extract structure
      for (const post of posts.slice(0, 5)) {
        await this.enrichPost(post);
      }

      this.cache.set(cacheKey, posts, 3600); // 1h cache
      return posts;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'Naver blog analysis failed');
      return [];
    }
  }

  private async enrichPost(post: CompetitorPost): Promise<void> {
    try {
      const response = await this.client.get(post.url, {
        validateStatus: () => true,
      });

      const $ = cheerio.load(response.data);

      // Extract headings structure
      const headings = $('h1, h2, h3, h4')
        .map((_, el) => {
          const tagName = 'tagName' in el ? el.tagName : '';
          return {
            level: parseInt(tagName.charAt(1)) || 1,
            text: $(el).text().trim(),
          };
        })
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
      logger.warn({ url: post.url, error: String(error) }, 'Failed to enrich post');
    }
  }

  private calculateScore(index: number, total: number): number {
    // Higher rank = higher score
    return 1 - (index / total) * 0.5;
  }

  private stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/g, '');
  }
}

export class TistoryAnalyzer implements CompetitorAnalyzer {
  readonly name = 'tistory';
  private client = createHttpClient({
    baseURL: 'https://www.tistory.com/apis',
    timeout: 30000,
    maxRetries: 3,
  });
  private cache = getCache<CompetitorPost[]>('tistory-analysis');

  async analyze(
    keyword: string,
    platforms: string[] = ['tistory'],
    limit: number = 10,
  ): Promise<CompetitorPost[]> {
    if (!platforms.includes('tistory')) return [];

    const cacheKey = `analyze:${keyword}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      // Tistory search via RSS or web scraping
      const searchUrl = `https://www.tistory.com/search/${encodeURIComponent(keyword)}`;
      const response = await this.client.get(searchUrl, {
        validateStatus: () => true,
      });

      const $ = cheerio.load(response.data);
      const posts: CompetitorPost[] = [];

      $('.search_list .item, .post_item').each((index, element) => {
        if (index >= limit) return false;

        const $el = $(element);
        const link = $el.find('a.link_post, .tit_post a').first().attr('href');
        const title = $el.find('.tit_post, .link_post').first().text().trim();
        const blogName = $el.find('.info_post .txt_info').first().text().trim();
        const date = $el.find('.info_post .date').first().text().trim();

        if (link && title) {
          posts.push({
            platform: 'tistory',
            url: link.startsWith('http') ? link : `https://www.tistory.com${link}`,
            title,
            blogName,
            publishedAt: date,
            views: 0,
            likes: 0,
            structure: [],
            affiliateLinks: [],
            ctaPatterns: [],
            score: this.calculateScore(index, limit),
          });
        }
        return true;
      });

      // Enrich top posts
      for (const post of posts.slice(0, 5)) {
        await this.enrichPost(post);
      }

      this.cache.set(cacheKey, posts, 3600);
      return posts;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'Tistory analysis failed');
      return [];
    }
  }

  private async enrichPost(post: CompetitorPost): Promise<void> {
    try {
      const response = await this.client.get(post.url, { validateStatus: () => true });
      const $ = cheerio.load(response.data);

      // Extract from article area
      const headings = $(
        '#content .article h1, #content .article h2, #content .article h3, .entry-content h1, .entry-content h2, .entry-content h3',
      )
        .map((_, el) => {
          const tagName = 'tagName' in el ? el.tagName : '';
          return {
            level: parseInt(tagName.charAt(1)) || 1,
            text: $(el).text().trim(),
          };
        })
        .get();

      post.structure = headings;
      post.metadata = {
        ...post.metadata,
        imageCount: $('.entry-content img, #content .article img').length,
      };

      const affiliateLinks = $('a[href*="coupang"], a[href*="partners"]')
        .map((_, el) => $(el).attr('href'))
        .get();
      post.affiliateLinks = affiliateLinks.filter(Boolean) as string[];

      const ctaTexts = $('a, button')
        .map((_, el) => $(el).text().trim())
        .get();
      post.ctaPatterns = ctaTexts
        .filter((t) => /구매|확인|자세히|더보기|최저가|할인/.test(t))
        .slice(0, 5);
    } catch (error) {
      logger.warn({ url: post.url, error: String(error) }, 'Failed to enrich Tistory post');
    }
  }

  private calculateScore(index: number, total: number): number {
    return 1 - (index / total) * 0.5;
  }
}

export class YouTubeAnalyzer implements CompetitorAnalyzer {
  readonly name = 'youtube';
  private client = createHttpClient({
    baseURL: 'https://www.googleapis.com/youtube/v3',
    timeout: 30000,
    maxRetries: 3,
  });
  private cache = getCache<CompetitorPost[]>('youtube-analysis');
  private apiKey: string;

  constructor(config: { apiKey: string }) {
    this.apiKey = config.apiKey;
  }

  async analyze(
    keyword: string,
    platforms: string[] = ['youtube'],
    limit: number = 10,
  ): Promise<CompetitorPost[]> {
    if (!platforms.includes('youtube') && !platforms.includes('youtube-shorts')) return [];

    const cacheKey = `analyze:${keyword}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get('/search', {
        params: {
          key: this.apiKey,
          part: 'snippet',
          q: keyword,
          type: 'video',
          videoDuration: 'short', // Shorts filter
          maxResults: Math.min(limit, 50),
          order: 'relevance',
        },
      });

      const posts: CompetitorPost[] =
        response.data.items?.map((item: YouTubeSearchItem, index: number) => ({
          platform: 'youtube',
          url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
          title: item.snippet.title,
          description: item.snippet.description,
          channelName: item.snippet.channelTitle,
          channelId: item.snippet.channelId,
          publishDate: item.snippet.publishedAt,
          views: 0, // Will be fetched separately
          likes: 0,
          structure: [],
          affiliateLinks: [],
          ctaPatterns: [],
          score: this.calculateScore(index, limit),
        })) || [];

      // Fetch statistics for top videos
      const videoIds = posts
        .slice(0, 10)
        .map((p) => p.url.split('v=')[1])
        .join(',');
      if (videoIds) {
        await this.enrichWithStats(posts, videoIds);
      }

      this.cache.set(cacheKey, posts, 3600);
      return posts;
    } catch (error) {
      logger.error({ keyword, error: String(error) }, 'YouTube analysis failed');
      return [];
    }
  }

  private async enrichWithStats(posts: CompetitorPost[], videoIds: string): Promise<void> {
    try {
      const response = await this.client.get('/videos', {
        params: {
          key: this.apiKey,
          part: 'statistics,contentDetails',
          id: videoIds,
        },
      });

      const statsMap = new Map<string, YouTubeVideoStats>(
        response.data.items?.map((item: YouTubeVideoItem): [string, YouTubeVideoStats] => [
          item.id,
          {
            views: parseInt(item.statistics?.viewCount || '0'),
            likes: parseInt(item.statistics?.likeCount || '0'),
            duration: item.contentDetails?.duration,
          },
        ]) || [],
      );

      for (const post of posts) {
        const videoId = post.url.split('v=')[1];
        const stats = statsMap.get(videoId);
        if (stats) {
          post.views = stats.views;
          post.likes = stats.likes;
          post.metadata = { ...post.metadata, duration: stats.duration };
        }
      }
    } catch (error) {
      logger.warn({ videoIds, error: String(error) }, 'Failed to fetch YouTube stats');
    }
  }

  private calculateScore(index: number, total: number): number {
    return 1 - (index / total) * 0.5;
  }
}

export class CompetitorAnalyzerRegistry {
  private analyzers = new Map<string, CompetitorAnalyzer>();

  register(analyzer: CompetitorAnalyzer): void {
    this.analyzers.set(analyzer.name, analyzer);
  }

  getAnalyzer(name: string): CompetitorAnalyzer | undefined {
    return this.analyzers.get(name);
  }

  async analyze(
    keyword: string,
    options: CompetitorAnalysisOptions = {},
  ): Promise<CompetitorPost[]> {
    const { platforms = ['naver-blog', 'tistory', 'youtube'], limit = 10 } = options;
    const allPosts: CompetitorPost[] = [];

    for (const platform of platforms) {
      const analyzer = this.analyzers.get(platform);
      if (!analyzer) {
        logger.warn({ platform }, 'Analyzer not found');
        continue;
      }

      try {
        const posts = await analyzer.analyze(keyword, platforms, limit);
        allPosts.push(...posts);
      } catch (error) {
        logger.error({ platform, keyword, error: String(error) }, 'Analyzer failed');
      }
    }

    // Sort by score
    allPosts.sort((a, b) => b.score - a.score);
    return allPosts.slice(0, limit);
  }

  getAvailablePlatforms(): string[] {
    return Array.from(this.analyzers.keys());
  }
}

export function createCompetitorAnalyzerRegistry(): CompetitorAnalyzerRegistry {
  return new CompetitorAnalyzerRegistry();
}
