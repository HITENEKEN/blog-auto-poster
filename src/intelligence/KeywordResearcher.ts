import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import { createHttpClient } from '@core/http';
import {
  KeywordProvider,
  KeywordData,
  KeywordResearchOptions,
  KeywordProviderConfig,
} from '@core/interfaces';

const logger = getLogger('keyword-researcher');

type SerpApiTrendsData = {
  interest_over_time?: {
    timeline_data?: Array<{ values: Array<{ value?: number }> }>;
  };
  related_queries?: {
    top?: Array<{ query: string }>;
  };
};

export class NaverKeywordProvider implements KeywordProvider {
  readonly name = 'naver';
  private client: ReturnType<typeof createHttpClient>;
  private cache = getCache<KeywordData[]>('naver-keywords');
  private relatedCache = getCache<string[]>('naver-related-keywords');
  private clientId: string;
  private clientSecret: string;

  constructor(config: KeywordProviderConfig) {
    this.clientId = config.apiKey || '';
    this.clientSecret = config.apiSecret || '';

    this.client = createHttpClient({
      baseURL: 'https://openapi.naver.com/v1/datalab',
      timeout: 30000,
      maxRetries: 3,
      defaultHeaders: {
        'X-Naver-Client-Id': this.clientId,
        'X-Naver-Client-Secret': this.clientSecret,
        'Content-Type': 'application/json',
      },
    });
  }

  async research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]> {
    if (!this.clientId || !this.clientSecret) {
      logger.warn('Naver API credentials not configured');
      return [];
    }

    const results: KeywordData[] = [];

    for (const keyword of keywords) {
      const cacheKey = `research:${keyword}:${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey) as KeywordData[] | null;
      if (cached) {
        results.push(...cached);
        continue;
      }

      try {
        // Naver DataLab search trend API
        const requestBody = {
          startDate: this.getStartDate(options?.period || 'month'),
          endDate: this.getEndDate(),
          timeUnit: options?.period === 'day' ? 'date' : 'week',
          keywordGroups: [{ groupName: keyword, keywords: [keyword] }],
        };

        const response = await this.client.post('/search', requestBody);

        if (response.data.results && response.data.results.length > 0) {
          const data = response.data.results[0];
          const keywordData: KeywordData = {
            keyword,
            volume: this.estimateVolume(data.data),
            competition: 0.5, // Naver doesn't provide direct competition
            trend: this.calculateTrend(data.data),
            related: await this.getRelatedKeywords(keyword),
            source: 'naver',
            metadata: { rawData: data.data },
          };

          results.push(keywordData);
          this.cache.set(cacheKey, [keywordData], 86400); // 24h cache
        }
      } catch (error) {
        logger.error({ keyword, error: String(error) }, 'Naver keyword research failed');
      }
    }

    return results;
  }

  async getRelatedKeywords(keyword: string): Promise<string[]> {
    const cacheKey = `related:${keyword}`;
    const cached = this.relatedCache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.client.get('/shopping/categories', {
        params: { query: keyword, display: 20 },
      });

      const related: string[] =
        response.data.categories?.map((c: { name: string }) => c.name) || [];
      this.relatedCache.set(cacheKey, related, 86400);
      return related;
    } catch {
      return [];
    }
  }

  private estimateVolume(dataPoints: Array<{ period: string; ratio: number }>): number {
    if (!dataPoints || dataPoints.length === 0) return 0;
    const avgRatio = dataPoints.reduce((sum, d) => sum + d.ratio, 0) / dataPoints.length;
    return Math.round(avgRatio * 10000); // Rough estimate
  }

  private calculateTrend(
    dataPoints: Array<{ period: string; ratio: number }>,
  ): 'rising' | 'falling' | 'stable' {
    if (!dataPoints || dataPoints.length < 2) return 'stable';
    const recent = dataPoints.slice(-4).reduce((sum, d) => sum + d.ratio, 0) / 4;
    const older = dataPoints.slice(0, 4).reduce((sum, d) => sum + d.ratio, 0) / 4;
    const change = (recent - older) / (older || 1);
    if (change > 0.1) return 'rising';
    if (change < -0.1) return 'falling';
    return 'stable';
  }

  private getStartDate(period: string): string {
    const date = new Date();
    switch (period) {
      case 'day':
        date.setDate(date.getDate() - 7);
        break;
      case 'week':
        date.setDate(date.getDate() - 28);
        break;
      case 'month':
        date.setMonth(date.getMonth() - 1);
        break;
      case 'year':
        date.setFullYear(date.getFullYear() - 1);
        break;
    }
    return date.toISOString().split('T')[0];
  }

  private getEndDate(): string {
    return new Date().toISOString().split('T')[0];
  }

  async validateConfig(): Promise<boolean> {
    return !!(this.clientId && this.clientSecret);
  }
}

export class GoogleTrendsProvider implements KeywordProvider {
  readonly name = 'google-trends';
  private client: ReturnType<typeof createHttpClient>;
  private cache = getCache<KeywordData[]>('google-trends-keywords');
  private useSerpApi: boolean;
  private serpApiKey: string;

  constructor(config: KeywordProviderConfig) {
    this.useSerpApi = config.useSerpApi || false;
    this.serpApiKey = config.apiKey || '';

    if (this.useSerpApi && this.serpApiKey) {
      this.client = createHttpClient({
        baseURL: 'https://serpapi.com',
        timeout: 30000,
        maxRetries: 3,
      });
    } else {
      // Unofficial Google Trends approach
      this.client = createHttpClient({
        baseURL: 'https://trends.google.com/trends/api',
        timeout: 30000,
        maxRetries: 3,
      });
    }
  }

  async research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]> {
    if (this.useSerpApi && this.serpApiKey) {
      return this.researchWithSerpApi(keywords, options);
    }
    return this.researchUnofficial(keywords, options);
  }

  private async researchWithSerpApi(
    keywords: string[],
    options?: KeywordResearchOptions,
  ): Promise<KeywordData[]> {
    const results: KeywordData[] = [];

    for (const keyword of keywords) {
      const cacheKey = `serp:${keyword}:${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results.push(...cached);
        continue;
      }

      try {
        const response = await this.client.get('/search', {
          params: {
            api_key: this.serpApiKey,
            engine: 'google_trends',
            q: keyword,
            data_type: 'TIMESERIES',
            date:
              options?.period === 'day'
                ? 'now 7-d'
                : options?.period === 'week'
                  ? 'now 30-d'
                  : 'today 12-m',
          },
        });

        const keywordData: KeywordData = {
          keyword,
          volume: this.estimateVolumeFromSerpApi(response.data),
          competition: 0.5,
          trend: this.calculateTrendFromSerpApi(response.data),
          related: response.data.related_queries?.top?.map((q: { query: string }) => q.query) || [],
          source: 'google-trends',
        };

        results.push(keywordData);
        this.cache.set(cacheKey, [keywordData], 3600); // 1h cache for trends
      } catch (error) {
        logger.error({ keyword, error: String(error) }, 'SerpAPI Google Trends failed');
      }
    }

    return results;
  }

  private async researchUnofficial(
    keywords: string[],
    _options?: KeywordResearchOptions,
  ): Promise<KeywordData[]> {
    // Unofficial Google Trends - limited functionality
    const results: KeywordData[] = [];

    for (const keyword of keywords) {
      results.push({
        keyword,
        volume: 0,
        competition: 0,
        trend: 'stable',
        related: [],
        source: 'google-trends',
      });
    }

    return results;
  }

  private estimateVolumeFromSerpApi(data: SerpApiTrendsData): number {
    if (!data.interest_over_time?.timeline_data) return 0;
    const values = data.interest_over_time.timeline_data.map((d) => d.values[0]?.value || 0);
    const avg = values.reduce((a: number, b: number) => a + b, 0) / values.length;
    return Math.round(avg * 100);
  }

  private calculateTrendFromSerpApi(data: SerpApiTrendsData): 'rising' | 'falling' | 'stable' {
    if (!data.interest_over_time?.timeline_data) return 'stable';
    const values = data.interest_over_time.timeline_data.map((d) => d.values[0]?.value || 0);
    if (values.length < 2) return 'stable';
    const recent = values.slice(-4).reduce((a: number, b: number) => a + b, 0) / 4;
    const older = values.slice(0, 4).reduce((a: number, b: number) => a + b, 0) / 4;
    const change = (recent - older) / (older || 1);
    if (change > 0.1) return 'rising';
    if (change < -0.1) return 'falling';
    return 'stable';
  }

  async validateConfig(): Promise<boolean> {
    return this.useSerpApi ? !!this.serpApiKey : true;
  }
}

export class CoupangKeywordProvider implements KeywordProvider {
  readonly name = 'coupang';
  private client: ReturnType<typeof createHttpClient>;
  private cache = getCache<KeywordData[]>('coupang-keywords');

  constructor() {
    this.client = createHttpClient({
      baseURL: 'https://api-gateway.coupang.com',
      timeout: 30000,
      maxRetries: 3,
    });
  }

  async research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]> {
    const results: KeywordData[] = [];

    for (const keyword of keywords) {
      const cacheKey = `coupang:${keyword}:${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey);
      if (cached) {
        results.push(...cached);
        continue;
      }

      try {
        // Use Coupang autocomplete/suggestions
        const suggestions = await this.getAutocomplete(keyword);
        const bestSellers = await this.getBestSellers(keyword);

        const related = [...new Set([...suggestions, ...bestSellers])];

        const keywordData: KeywordData = {
          keyword,
          volume: bestSellers.length * 100, // Rough estimate from bestseller count
          competition: Math.min(related.length / 20, 1),
          trend: 'stable',
          related: related.slice(0, 20),
          source: 'coupang',
        };

        results.push(keywordData);
        this.cache.set(cacheKey, [keywordData], 3600); // 1h cache
      } catch (error) {
        logger.error({ keyword, error: String(error) }, 'Coupang keyword research failed');
      }
    }

    return results;
  }

  private async getAutocomplete(keyword: string): Promise<string[]> {
    try {
      const response = await this.client.get('/v2/affiliate/autocomplete', {
        params: { keyword },
      });
      return response.data.data?.map((d: { keyword: string }) => d.keyword) || [];
    } catch {
      return [];
    }
  }

  private async getBestSellers(_category?: string): Promise<string[]> {
    try {
      // This would use the CoupangAdapter's searchProducts
      // For now, return empty
      return [];
    } catch {
      return [];
    }
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }
}

export class KeywordResearcher {
  private providers = new Map<string, KeywordProvider>();
  private cache = getCache<KeywordData[]>('keyword-research-aggregate');

  registerProvider(provider: KeywordProvider): void {
    this.providers.set(provider.name, provider);
  }

  getProvider(name: string): KeywordProvider | undefined {
    return this.providers.get(name);
  }

  async research(
    seedKeywords: string[],
    options: KeywordResearchOptions = {},
  ): Promise<KeywordData[]> {
    const { providers = ['google-trends', 'coupang'], limit = 50 } = options;

    logger.info({ seedKeywords, providers, limit }, 'Starting keyword research');

    const allResults: KeywordData[] = [];

    for (const providerName of providers) {
      const provider = this.providers.get(providerName);
      if (!provider) {
        logger.warn({ provider: providerName }, 'Keyword provider not found');
        continue;
      }

      try {
        const results = await provider.research(seedKeywords, options);
        allResults.push(...results);
      } catch (error) {
        logger.error({ provider: providerName, error: String(error) }, 'Provider research failed');
      }
    }

    // Deduplicate and merge
    const merged = this.mergeResults(allResults);

    // Sort by volume * (1 - competition) * trend multiplier
    merged.sort((a, b) => {
      const scoreA = this.calculateScore(a);
      const scoreB = this.calculateScore(b);
      return scoreB - scoreA;
    });

    return merged.slice(0, limit);
  }

  private mergeResults(results: KeywordData[]): KeywordData[] {
    const map = new Map<string, KeywordData>();

    for (const result of results) {
      const existing = map.get(result.keyword);
      if (!existing) {
        map.set(result.keyword, result);
      } else {
        // Merge data from multiple sources
        existing.volume = Math.max(existing.volume, result.volume);
        existing.competition = Math.min(existing.competition, result.competition);
        existing.trend = this.mergeTrend(existing.trend, result.trend);
        existing.related = [...new Set([...existing.related, ...result.related])];
        existing.metadata = {
          ...existing.metadata,
          ...result.metadata,
          sources: [
            ...(Array.isArray(existing.metadata?.sources) ? existing.metadata.sources : []),
            result.source,
          ],
        };
      }
    }

    return Array.from(map.values());
  }

  private mergeTrend(
    a: 'rising' | 'falling' | 'stable',
    b: 'rising' | 'falling' | 'stable',
  ): 'rising' | 'falling' | 'stable' {
    if (a === 'rising' || b === 'rising') return 'rising';
    if (a === 'falling' || b === 'falling') return 'falling';
    return 'stable';
  }

  private calculateScore(keyword: KeywordData): number {
    const trendMultiplier =
      keyword.trend === 'rising' ? 1.5 : keyword.trend === 'falling' ? 0.7 : 1;
    return keyword.volume * (1 - keyword.competition) * trendMultiplier;
  }

  async validateAllProviders(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, provider] of this.providers) {
      try {
        results[name] = await provider.validateConfig();
      } catch {
        results[name] = false;
      }
    }

    return results;
  }
}

export function createKeywordResearcher(): KeywordResearcher {
  return new KeywordResearcher();
}
