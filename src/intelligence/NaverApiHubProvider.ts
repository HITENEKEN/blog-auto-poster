import type { AxiosInstance } from 'axios';
import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import { getConfigManager } from '@core/config';
import { createHttpClient } from '@core/http';
import {
  KeywordProvider,
  KeywordData,
  KeywordResearchOptions,
  KeywordProviderConfig,
  CompetitorAnalyzer,
  CompetitorPost,
} from '@core/interfaces';

import {
  classifyTrend,
  isShoppingKeyword,
  monthRange,
  peakRatio,
  pickShoppingCategory,
  scaleVolume,
  SHOPPING_CATEGORY_POOL_MAX,
  SHOPPING_KEYWORDS_PER_REQUEST,
  TREND_GROUPS_PER_REQUEST,
  DEFAULT_SHOPPING_SIGNALS,
  type ShoppingCategoryObservation,
  type TrendSeries,
} from './TrendAnalysis';

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

// SCH_TRND (검색어트렌드) / SHPP_INST (쇼핑인사이트) request/response shapes
type TrendKeywordGroup = { groupName: string; keywords: string[] };
type TrendApiResponseGroup = { title: string; keywords?: string[]; data: TrendSeries };
type TrendApiResponse = {
  startDate: string;
  endDate: string;
  timeUnit: string;
  results: TrendApiResponseGroup[];
};

/** SCH_TRND/SHPP_INST 조회 옵션 — 미지정/빈 값 필드는 요청 바디에서 생략한다. */
export type TrendQueryOptions = {
  months?: number; // startDate/endDate 미지정 시에만 사용, 기본 12
  startDate?: string; // yyyy-mm-dd, 지정 시 months 무시
  endDate?: string;
  timeUnit?: 'date' | 'week' | 'month'; // 기본 'month' (기존 동작 유지)
  device?: string; // ''/undefined = 미전송
  gender?: string; // ''/undefined = 미전송
  ages?: string[]; // 빈 배열/undefined = 미전송
};

/**
 * SHPP_INST 조회 기준. 공식 엔드포인트로의 실제 경로 매핑은 SHOPPING_ENDPOINTS가
 * 담당한다 — criteria 이름 자체는 라우트/클라이언트 계약으로 불변이다.
 */
export type ShoppingCriteria =
  | 'category'
  | 'keyword'
  | 'gender'
  | 'ages'
  | 'device'
  | 'keywords'
  | 'keywords-keyword'
  | 'keywords-gender'
  | 'keywords-ages'
  | 'keywords-device';

/**
 * criteria → 공식 SHPP_INST 엔드포인트 (NAVER API HUB 문서, 2026-08 기준).
 * 'keyword'/'keywords-keyword'는 공식 plain keyword-level 엔드포인트가 없어
 * 가장 근접한 /category/keywords(1쌍)로 대체한다.
 */
const SHOPPING_ENDPOINTS: Record<ShoppingCriteria, string> = {
  category: '/categories',
  keyword: '/category/keywords',
  gender: '/category/gender',
  ages: '/category/age',
  device: '/category/device',
  keywords: '/category/keywords',
  'keywords-keyword': '/category/keywords',
  'keywords-gender': '/category/keyword/gender',
  'keywords-ages': '/category/keyword/age',
  'keywords-device': '/category/keyword/device',
};

/**
 * 캐시 키 스코프 — 엔드포인트 baseURL의 호스트. e2e/mock 실행과 실서버가
 * 같은 .cache 디스크 캐시를 공유하면서 mock 응답(모든 카테고리에 동일 데이터)이
 * 실API 키로 재사용되던 오염을 키 레벨에서 차단한다.
 */
function cacheScope(baseURL: string): string {
  try {
    return new URL(baseURL).host;
  } catch {
    return 'unknown';
  }
}

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

/**
 * 블로그 검색 결과를 게시일(postdate, YYYYMMDD) 기준 내림차순으로 정렬한다.
 * 게시일이 유효한 항목(YYYYMMDD)이 최신순으로 앞에 오고, 게시일이 없거나
 * 형식이 잘못된 항목은 상대 순서를 유지한 채 목록 맨 뒤로 보낸다.
 */
export function sortByPostdateDesc<T extends { postdate?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aValid = /^\d{8}$/.test(a.postdate ?? '');
    const bValid = /^\d{8}$/.test(b.postdate ?? '');
    if (aValid && bValid) return (b.postdate ?? '').localeCompare(a.postdate ?? '');
    if (aValid) return -1;
    if (bValid) return 1;
    return 0; // 둘 다 무효면 안정 정렬로 원래 순서 유지
  });
}

export class NaverApiHubKeywordProvider implements KeywordProvider {
  readonly name = 'naver-api-hub';
  private client: AxiosInstance;
  private trendClient: AxiosInstance;
  private shoppingClient: AxiosInstance;
  private cache = getCache<KeywordData[]>('naver-api-hub-keywords');
  private searchCache = getCache<NaverApiSearchResponse>('naver-api-hub-search');
  private newsCache = getCache<NaverApiSearchResponse<NaverApiNewsItem>>('naver-api-hub-news');
  private trendCache = getCache<TrendApiResponseGroup[]>('naver-api-hub-trend');
  private shoppingCache = getCache<TrendApiResponseGroup[]>('naver-api-hub-shopping');
  private baseUrl: string;
  private trendBaseUrl: string;
  private shoppingBaseUrl: string;
  private apiKeyId: string;
  private apiKey: string;
  private searchTrendEnabled: boolean;
  private shoppingInsightEnabled: boolean;
  /** 캐시 키 스코프 — 엔드포인트 호스트. mock(e2e) 항목이 실API 항목과 충돌하지
   * 않게 한다(공유 .cache 디스크 캐시 오염 방지). */
  private scope: string;
  private trendScope: string;
  private shoppingScope: string;

  constructor(config: KeywordProviderConfig) {
    this.apiKeyId = config.apiKey || '';
    this.apiKey = config.apiSecret || '';
    this.searchTrendEnabled = config.searchTrend === true;
    this.shoppingInsightEnabled = config.shoppingInsight === true;

    const commonOptions = {
      timeout: 30000,
      maxRetries: 3,
      defaultHeaders: {
        'X-NCP-APIGW-API-KEY-ID': this.apiKeyId,
        'X-NCP-APIGW-API-KEY': this.apiKey,
        'Content-Type': 'application/json',
      },
    };

    this.client = createHttpClient({
      ...commonOptions,
      baseURL: (this.baseUrl = config.baseUrl || 'https://naverapihub.apigw.ntruss.com/search/v1'),
    });
    this.trendClient = createHttpClient({
      ...commonOptions,
      baseURL: (this.trendBaseUrl =
        config.searchTrendBaseUrl || 'https://naverapihub.apigw.ntruss.com/search-trend/v1'),
    });
    this.shoppingClient = createHttpClient({
      ...commonOptions,
      baseURL: (this.shoppingBaseUrl =
        config.shoppingBaseUrl || 'https://naverapihub.apigw.ntruss.com/shopping/v1'),
    });
    this.scope = cacheScope(this.baseUrl);
    this.trendScope = cacheScope(this.trendBaseUrl);
    this.shoppingScope = cacheScope(this.shoppingBaseUrl);
  }

  async research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]> {
    if (!this.apiKeyId || !this.apiKey) {
      logger.warn('Naver API Hub credentials not configured');
      return [];
    }

    const results: KeywordData[] = [];
    const pending: string[] = [];

    for (const keyword of keywords) {
      const cacheKey = `${this.scope}:hub-research-v2:${keyword}:${JSON.stringify(options)}`;
      const cached = this.cache.get(cacheKey) as KeywordData[] | null;
      if (cached) {
        results.push(...cached);
      } else {
        pending.push(keyword);
      }
    }

    if (pending.length > 0) {
      const fresh = await this.researchBatch(pending, options);
      for (const keywordData of fresh) {
        results.push(keywordData);
        const cacheKey = `${this.scope}:hub-research-v2:${keywordData.keyword}:${JSON.stringify(options)}`;
        this.cache.set(cacheKey, [keywordData], 86400); // 24h cache
      }
    }

    return results;
  }

  /**
   * Batch research pipeline:
   *  1. SCH_TRND — anchor-relative volume score + trend classification
   *  2. SHPP_INST — shopping-intent keywords probed against the category pool
   *  3. NAVER_SCH_BLOG — competition + related keywords (blog heuristic fallback
   *     when trend APIs are disabled or fail)
   */
  private async researchBatch(
    keywords: string[],
    options?: KeywordResearchOptions,
  ): Promise<KeywordData[]> {
    // --- Blog search per keyword (competition + related + fallback heuristics)
    const blogData = new Map<
      string,
      { results: NaverApiSearchResponse; competition: number; related: string[] }
    >();
    for (const keyword of keywords) {
      try {
        const blogResults = await this.searchBlog(keyword, options?.limit || 20);
        blogData.set(keyword, {
          results: blogResults,
          competition: this.calculateCompetition(blogResults),
          related: this.extractRelatedKeywords(blogResults, keyword),
        });
      } catch (error) {
        logger.error({ keyword, error: String(error) }, 'API Hub blog search failed');
      }
    }

    // --- SCH_TRND: chunked requests with a shared anchor for cross-chunk comparability
    const trendSeries = new Map<string, TrendSeries>();
    const volumeScores = new Map<string, number>();
    if (this.searchTrendEnabled) {
      try {
        await this.collectSearchTrends(keywords, trendSeries, volumeScores);
      } catch (error) {
        logger.warn({ error: String(error) }, 'SCH_TRND research failed; using blog fallback');
      }
    }

    // --- SHPP_INST: probe shopping-intent keywords against the category pool
    const shoppingPicks = new Map<string, { name: string; category: string; ratio: number }>();
    if (this.shoppingInsightEnabled) {
      await this.collectShoppingInsights(keywords, shoppingPicks);
    }

    const results: KeywordData[] = [];
    for (const keyword of keywords) {
      const blog = blogData.get(keyword);
      if (!blog) continue; // blog search failed — nothing to report

      const series = trendSeries.get(keyword);
      const shopping = shoppingPicks.get(keyword);
      const metadata: Record<string, unknown> = {
        volumeBasis: series ? 'search-trend' : 'blog-estimate',
        totalResults: blog.results.total,
        displayCount: blog.results.items?.length || 0,
        topBlogs: blog.results.items?.slice(0, 5).map((item) => item.bloggername) || [],
      };
      if (series) metadata.trendSeries = series;
      if (shopping) {
        metadata.shoppingCategory = { name: shopping.name, category: shopping.category };
        metadata.shoppingRatio = shopping.ratio;
      }

      results.push({
        keyword,
        volume: series
          ? (volumeScores.get(keyword) ?? 0)
          : this.estimateVolumeFromResults(blog.results),
        competition: blog.competition,
        trend: series ? classifyTrend(series) : this.calculateTrend(blog.results),
        related: blog.related,
        source: 'naver-api-hub',
        metadata,
      });
    }
    return results;
  }

  /**
   * SCH_TRND 조회 — 키워드를 청크(앵커 포함 최대 5그룹)로 나눠 조회하고
   * 앵커 피크 비율 대비 볼륨 스코어를 계산한다.
   */
  private async collectSearchTrends(
    keywords: string[],
    trendSeries: Map<string, TrendSeries>,
    volumeScores: Map<string, number>,
  ): Promise<void> {
    const anchor = String(getConfigManager().get('keywords.trendAnchor', '쇼핑'));
    const perChunk = TREND_GROUPS_PER_REQUEST - 1; // anchor takes one slot
    const chunks: string[][] = [];
    for (let i = 0; i < keywords.length; i += perChunk) {
      chunks.push(keywords.slice(i, i + perChunk));
    }

    // 청크를 병렬 조회한다(이슈 #13 — 순차 호출이 top-20 지연의 주원인).
    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const groups: TrendKeywordGroup[] = [];
        if (!chunk.includes(anchor)) {
          groups.push({ groupName: anchor, keywords: [anchor] });
        }
        for (const keyword of chunk) {
          groups.push({ groupName: keyword, keywords: [keyword] });
        }
        try {
          return { chunk, results: await this.getSearchTrend(groups) };
        } catch (error) {
          logger.warn({ error: String(error) }, 'SCH_TRND chunk failed');
          return { chunk, results: [] as TrendApiResponseGroup[] };
        }
      }),
    );

    for (const { results } of chunkResults) {
      const anchorPeak = peakRatio(results.find((g) => g.title === anchor)?.data ?? []);
      for (const group of results) {
        trendSeries.set(group.title, group.data ?? []);
        volumeScores.set(group.title, scaleVolume(peakRatio(group.data ?? []), anchorPeak));
      }
    }
  }

  /**
   * SHPP_INST 조회 — 쇼핑 관련 키워드만 선별해 후보 카테고리 풀에 probe하고,
   * 클릭 ratio 최대 카테고리를 채택한다. 실패해도 리서치를 깨지 않는다.
   */
  private async collectShoppingInsights(
    keywords: string[],
    shoppingPicks: Map<string, { name: string; category: string; ratio: number }>,
  ): Promise<void> {
    const cm = getConfigManager();
    const signals = cm.get(
      'keywords.shoppingSignals',
      DEFAULT_SHOPPING_SIGNALS as unknown as string[],
    ) as string[];
    const pool = (
      cm.get('keywords.shoppingCategoryPool', []) as Array<{ name: string; category: string }>
    ).slice(0, SHOPPING_CATEGORY_POOL_MAX);
    const targets = keywords.filter((kw) => isShoppingKeyword(kw, signals));
    if (targets.length === 0 || pool.length === 0) return;

    // observations[keyword] = pool 전체 probe 결과
    const observations = new Map<string, ShoppingCategoryObservation[]>();
    for (const cat of pool) {
      for (let i = 0; i < targets.length; i += SHOPPING_KEYWORDS_PER_REQUEST) {
        const slice = targets.slice(i, i + SHOPPING_KEYWORDS_PER_REQUEST);
        try {
          const results = await this.getShoppingTrend('keywords', {
            ...monthRange(12),
            timeUnit: 'month',
            category: cat.category,
            keyword: slice.map((kw) => ({ name: kw, param: [kw] })),
          });
          for (const group of results) {
            const list = observations.get(group.title) ?? [];
            list.push({
              name: cat.name,
              category: cat.category,
              peakRatio: peakRatio(group.data ?? []),
            });
            observations.set(group.title, list);
          }
        } catch (error) {
          logger.warn(
            { category: cat.category, error: String(error) },
            'SHPP_INST probe failed for category',
          );
        }
      }
    }

    for (const [keyword, obs] of observations) {
      const pick = pickShoppingCategory(obs);
      if (pick) {
        shoppingPicks.set(keyword, {
          name: pick.name,
          category: pick.category,
          ratio: pick.shoppingRatio,
        });
      }
    }
  }

  /**
   * SCH_TRND — POST /search (월간 12개월 기본, opts로 기간/단위/필터 지정 가능)
   */
  async getSearchTrend(
    groups: TrendKeywordGroup[],
    opts?: TrendQueryOptions,
  ): Promise<TrendApiResponseGroup[]> {
    const { startDate, endDate } =
      opts?.startDate && opts?.endDate
        ? { startDate: opts.startDate, endDate: opts.endDate }
        : monthRange(opts?.months ?? 12);
    const timeUnit = opts?.timeUnit ?? 'month';
    // ''와 undefined를 같은 미전송 상태로 정규화 — 캐시 키도 동일하게 모인다.
    const device = opts?.device || '';
    const gender = opts?.gender || '';
    const ages = opts?.ages?.length ? opts.ages : [];
    const cacheKey = `${this.trendScope}:trend:${startDate}:${endDate}:${timeUnit}:${device}:${gender}:${ages.join(
      ',',
    )}:${JSON.stringify(groups)}`;
    const cached = this.trendCache.get(cacheKey);
    if (cached) return cached;

    const response = await this.trendClient.post<TrendApiResponse>('/search', {
      startDate,
      endDate,
      timeUnit,
      keywordGroups: groups,
      ...(device ? { device } : {}),
      ...(gender ? { gender } : {}),
      ...(ages.length ? { ages } : {}),
    });
    this.trendCache.set(cacheKey, response.data.results ?? [], 86400); // 24h cache
    return response.data.results ?? [];
  }

  /**
   * SHPP_INST 조회 — criteria를 SHOPPING_ENDPOINTS의 공식 경로로 POST한다.
   * 바디는 호출자가 공식 스펙에 맞춰 구성한다. 캐시 TTL 24h, 키에 criteria 포함.
   */
  async getShoppingTrend(
    criteria: ShoppingCriteria,
    body: Record<string, unknown>,
  ): Promise<TrendApiResponseGroup[]> {
    const cacheKey = `${this.shoppingScope}:shopping:${criteria}:${JSON.stringify(body)}`;
    const cached = this.shoppingCache.get(cacheKey);
    if (cached) return cached;

    const response = await this.shoppingClient.post<TrendApiResponse>(
      SHOPPING_ENDPOINTS[criteria],
      body,
    );
    this.shoppingCache.set(cacheKey, response.data.results ?? [], 86400); // 24h cache
    return response.data.results ?? [];
  }

  /**
   * Search Naver blogs via API Hub
   */
  async searchBlog(
    keyword: string,
    limit: number = 20,
    sort: string = 'sim',
  ): Promise<NaverApiSearchResponse> {
    const cacheKey = `${this.scope}:blog:${keyword}:${limit}:${sort}`;
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
    const cacheKey = `${this.scope}:news:${keyword}:${limit}`;
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
    minCount: number = 2,
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
      .filter(([, entry]) => entry.count >= minCount)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30)
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
  /** 캐시 키 스코프 — 엔드포인트 호스트(mock/실API 캐시 오염 방지). */
  private scope: string;
  private apiKeyId: string;
  private apiKey: string;

  constructor(config: { apiKey: string; apiSecret: string; baseUrl?: string }) {
    this.apiKeyId = config.apiKey;
    this.apiKey = config.apiSecret;
    this.scope = cacheScope(config.baseUrl || 'https://naverapihub.apigw.ntruss.com/search/v1');
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
    const cacheKey = `${this.scope}:analyze:${keyword}:${limit}`;
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
