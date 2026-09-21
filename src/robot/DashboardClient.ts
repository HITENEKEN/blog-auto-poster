import { getLogger } from '@core/logger';
import { HttpError, TransientError } from './errors';

const logger = getLogger('robot');

/**
 * 대시보드 REST 클라이언트(설계 §5-5).
 *
 * - 인증: env `BLOG_POSTER_WEB_ADMIN_USERNAME/PASSWORD`로 `POST /api/auth/login`.
 *   토큰은 **메모리에만** 두고, 로그·증거물에 쓰지 않는다. 401이면 1회 재로그인한다.
 * - 기본 주소: env `BLOG_POSTER_ROBOT_API_BASE`(기본 `http://127.0.0.1:3002`).
 *   스킬과 같이 dev 서버(3005)는 쓰지 않는다.
 * - 재시도: GET·멱등 엔드포인트(place-ads/gate/ads-requests)는 30초·2분·5분 백오프 3회.
 *   `generate-from-keyword`·`PUT posts`는 자동 재시도 없음(단계 재시도가 판단).
 *   `publish`는 **재시도 없음**, 10분 타임아웃.
 *
 * 상태 변경은 전부 이 클라이언트를 지난다 — 로봇은 파일·DB를 직접 건드리지 않는다(설계 §1).
 */

export const DEFAULT_API_BASE = 'http://127.0.0.1:3002';
export const RETRY_BACKOFF_MS = [30_000, 120_000, 300_000];
export const IDEMPOTENT_RETRIES = 3;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const PUBLISH_TIMEOUT_MS = 10 * 60 * 1000;

export interface AdInventoryItem {
  id: string;
  source: string;
  productName: string;
  url: string;
  imageUrl?: string;
  keywords: string[];
  categoryId?: string;
  status: string;
  usedCount?: number;
}

export interface HealthResponse {
  status: string;
  services?: {
    platforms?: Record<string, boolean>;
    scheduler?: string;
    naverSession?: { expiresAt: string | null; daysLeft: number | null };
    [key: string]: unknown;
  };
}

export interface PlaceAdsResult {
  html: string;
  slots: unknown[];
  ads: unknown[];
  disclosure: boolean;
  notes?: unknown;
}

export interface GateResult {
  ok: boolean;
  violations: Array<{ code: string; message: string; detail?: unknown }>;
  previewSha256: string;
  previewHtmlPath?: string;
  [key: string]: unknown;
}

export interface PublishResult {
  results?: Array<{
    platform: string;
    postId?: string;
    url?: string;
    success: boolean;
    warnings?: string[];
    widgetWarnings?: string[];
    error?: string;
  }>;
  [key: string]: unknown;
}

export interface CategoryOverviewResult {
  categoryValid?: boolean;
  clickTrend?: Array<{ period: string; ratio: number }>;
  keywords?: Array<{ keyword: string; ratio?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface TrendResult {
  series?: Array<{ title?: string; data: Array<{ period: string; ratio: number }> }>;
  [key: string]: unknown;
}

export interface KeywordBlogsResult {
  total: number;
  posts?: Array<{ title: string; link: string; postDate?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/**
 * 로봇이 쓰는 대시보드 API 표면. RobotRunner는 이 인터페이스에만 의존하므로
 * 테스트는 가짜 구현(호출 횟수 기록)을 끼워 넣는다.
 */
export interface DashboardApi {
  ensureToken(): Promise<void>;
  health(): Promise<HealthResponse>;
  /**
   * `GET /api/blogs` — 플랫폼 어댑터를 깨우는 부수효과가 있다(설계 §4-1). PREFLIGHT가
   * `health().services.platforms`에 `naver`가 없을 때 1회 호출해 재기동 직후의
   * 지연 초기화(§0)를 넘긴다. 응답 형태는 신경 쓰지 않는다 — 깨우기 목적뿐이다.
   */
  blogs(): Promise<{ blogs: Array<Record<string, unknown>> }>;
  adsInventory(params: {
    keyword?: string;
    categoryId?: string;
    status?: string;
  }): Promise<{ items: AdInventoryItem[] }>;
  createAdRequest(input: {
    keyword: string;
    categoryId?: string;
    needed: number;
    criteria: string[];
    dueAt: string;
    robotRunId?: string;
  }): Promise<{ request: Record<string, unknown> }>;
  categoryOverview(params: {
    category: string;
    categoryName?: string;
    startDate: string;
    endDate: string;
    timeUnit: string;
  }): Promise<CategoryOverviewResult>;
  searchTrend(input: {
    source: 'search-trend';
    query: string;
    startDate: string;
    endDate: string;
    timeUnit: string;
  }): Promise<TrendResult>;
  keywordBlogs(
    keyword: string,
    opts?: { limit?: number; sort?: string },
  ): Promise<KeywordBlogsResult>;
  generateFromKeyword(input: {
    keyword: string;
    template?: string;
  }): Promise<{ post: { id: string } }>;
  getPost(id: string): Promise<{ post: Record<string, unknown> }>;
  putPost(id: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** 발행 기록(RECORD)에서 인벤토리 used_count를 올린다 — 로봇은 DB를 직접 쓰지 않는다. */
  markAdUsed(adId: string): Promise<Record<string, unknown>>;
  placeAds(id: string, body: Record<string, unknown>): Promise<PlaceAdsResult>;
  gate(id: string, body: Record<string, unknown>): Promise<GateResult>;
  publish(id: string, body: Record<string, unknown>): Promise<PublishResult>;
}

/** 401 → 1회 재로그인 신호(외부로 새지 않는다). */
class ReauthRequired extends Error {}

export interface DashboardClientOptions {
  apiBase?: string;
  username?: string;
  password?: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

const defaultSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

export function resolveApiBase(): string {
  return process.env.BLOG_POSTER_ROBOT_API_BASE || DEFAULT_API_BASE;
}

export class DashboardClient implements DashboardApi {
  readonly apiBase: string;
  private readonly username: string;
  private readonly password: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private token: string | null = null;

  constructor(options: DashboardClientOptions = {}) {
    this.apiBase = (options.apiBase || resolveApiBase()).replace(/\/+$/, '');
    this.username = options.username ?? process.env.BLOG_POSTER_WEB_ADMIN_USERNAME ?? 'admin';
    this.password = options.password ?? process.env.BLOG_POSTER_WEB_ADMIN_PASSWORD ?? 'changeme';
    this.sleep = options.sleep ?? defaultSleep;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 토큰이 없으면 로그인한다. 실패는 TransientError(로컬 서버 미기동) 또는 HttpError(자격증명). */
  async ensureToken(): Promise<void> {
    if (this.token) return;
    await this.login();
  }

  async login(): Promise<void> {
    const res = await this.rawRequest('POST', '/api/auth/login', {
      username: this.username,
      password: this.password,
    });
    if (res.status === 401 || res.status === 403) {
      throw new HttpError(res.status, '대시보드 로그인 실패 — BLOG_POSTER_WEB_ADMIN_* 확인');
    }
    const body = (await this.parse(res)) as { token?: string };
    if (!body?.token) throw new TransientError('로그인 응답에 토큰이 없습니다');
    this.token = body.token;
    logger.debug({ apiBase: this.apiBase }, 'dashboard login ok');
  }

  private async rawRequest(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransientError(`${method} ${path} 연결 실패: ${String(error)}`, error);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  private async once<T>(
    method: string,
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const res = await this.rawRequest(method, path, body, timeoutMs);
    if (res.status === 401) throw new ReauthRequired(`401 on ${method} ${path}`);
    if (res.status >= 500) {
      throw new TransientError(`${method} ${path} → ${res.status}`);
    }
    const parsed = await this.parse(res);
    if (!res.ok) {
      throw new HttpError(res.status, `${method} ${path} → ${res.status}`, parsed);
    }
    return parsed as T;
  }

  /** 재시도 정책을 적용한 요청. 401은 1회 재로그인 후 그 요청만 다시 시도한다. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { retries?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const retries = opts.retries ?? 0;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let reauthed = false;
    let lastError: unknown;

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        return await this.once<T>(method, path, body, timeoutMs);
      } catch (error) {
        if (error instanceof ReauthRequired && !reauthed) {
          reauthed = true;
          this.token = null;
          await this.login();
          try {
            return await this.once<T>(method, path, body, timeoutMs);
          } catch (retryError) {
            lastError = retryError;
            if (!(retryError instanceof TransientError) || attempt > retries) throw retryError;
          }
        } else {
          lastError = error;
          if (!(error instanceof TransientError) || attempt > retries) throw error;
        }
        const backoff = RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)];
        logger.warn({ method, path, attempt, backoff }, '요청 재시도');
        await this.sleep(backoff);
      }
    }
    throw lastError instanceof Error ? lastError : new TransientError(`${method} ${path} 실패`);
  }

  // ---- 엔드포인트 (설계 §4-1) ---------------------------------------------

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health', undefined, {
      retries: IDEMPOTENT_RETRIES,
    });
  }

  blogs(): Promise<{ blogs: Array<Record<string, unknown>> }> {
    return this.request<{ blogs: Array<Record<string, unknown>> }>('GET', '/api/blogs', undefined, {
      retries: IDEMPOTENT_RETRIES,
    });
  }

  adsInventory(params: { keyword?: string; categoryId?: string; status?: string }) {
    const query = new URLSearchParams();
    if (params.keyword) query.set('keyword', params.keyword);
    if (params.categoryId) query.set('categoryId', params.categoryId);
    if (params.status) query.set('status', params.status);
    const qs = query.toString();
    return this.request<{ items: AdInventoryItem[] }>(
      'GET',
      `/api/ads/inventory${qs ? `?${qs}` : ''}`,
      undefined,
      { retries: IDEMPOTENT_RETRIES },
    );
  }

  createAdRequest(input: {
    keyword: string;
    categoryId?: string;
    needed: number;
    criteria: string[];
    dueAt: string;
    robotRunId?: string;
  }) {
    return this.request<{ request: Record<string, unknown> }>('POST', '/api/ads/requests', input, {
      retries: IDEMPOTENT_RETRIES,
    });
  }

  categoryOverview(params: {
    category: string;
    categoryName?: string;
    startDate: string;
    endDate: string;
    timeUnit: string;
  }) {
    const query = new URLSearchParams();
    query.set('category', params.category);
    if (params.categoryName) query.set('categoryName', params.categoryName);
    query.set('startDate', params.startDate);
    query.set('endDate', params.endDate);
    query.set('timeUnit', params.timeUnit);
    return this.request<CategoryOverviewResult>(
      'GET',
      `/api/keywords/category-overview?${query.toString()}`,
      undefined,
      { retries: IDEMPOTENT_RETRIES },
    );
  }

  searchTrend(input: {
    source: 'search-trend';
    query: string;
    startDate: string;
    endDate: string;
    timeUnit: string;
  }) {
    return this.request<TrendResult>('POST', '/api/keywords/trend', input, {
      retries: IDEMPOTENT_RETRIES,
    });
  }

  keywordBlogs(keyword: string, opts: { limit?: number; sort?: string } = {}) {
    const query = new URLSearchParams({
      limit: String(opts.limit ?? 10),
      sort: opts.sort ?? 'sim',
    });
    return this.request<KeywordBlogsResult>(
      'GET',
      `/api/keywords/${encodeURIComponent(keyword)}/blogs?${query.toString()}`,
      undefined,
      { retries: IDEMPOTENT_RETRIES },
    );
  }

  /** 자동 재시도 없음 — 단계 재시도(§5-1 규칙 3)가 멱등 기준으로 판단한다. */
  generateFromKeyword(input: { keyword: string; template?: string }) {
    return this.request<{ post: { id: string } }>(
      'POST',
      '/api/posts/generate-from-keyword',
      input,
    );
  }

  getPost(id: string) {
    return this.request<{ post: Record<string, unknown> }>(
      'GET',
      `/api/posts/${encodeURIComponent(id)}`,
      undefined,
      { retries: IDEMPOTENT_RETRIES },
    );
  }

  putPost(id: string, body: Record<string, unknown>) {
    return this.request<Record<string, unknown>>(
      'PUT',
      `/api/posts/${encodeURIComponent(id)}`,
      body,
    );
  }

  /**
   * `PATCH /api/ads/inventory/:id {markUsed:true}` — 호출부(RECORD)가 실행·광고별로
   * 멱등 가드를 걸므로 재시도해도 이중 집계되지 않는다.
   */
  markAdUsed(adId: string) {
    return this.request<Record<string, unknown>>(
      'PATCH',
      `/api/ads/inventory/${encodeURIComponent(adId)}`,
      { markUsed: true },
      { retries: IDEMPOTENT_RETRIES },
    );
  }

  placeAds(id: string, body: Record<string, unknown>) {
    return this.request<PlaceAdsResult>(
      'POST',
      `/api/posts/${encodeURIComponent(id)}/place-ads`,
      body,
      {
        retries: IDEMPOTENT_RETRIES,
      },
    );
  }

  gate(id: string, body: Record<string, unknown>) {
    return this.request<GateResult>('POST', `/api/posts/${encodeURIComponent(id)}/gate`, body, {
      retries: IDEMPOTENT_RETRIES,
    });
  }

  /** 재시도 금지 + 10분 타임아웃(§5-5). 결과가 모호하면 RECONCILE이 확정한다. */
  publish(id: string, body: Record<string, unknown>) {
    return this.request<PublishResult>(
      'POST',
      `/api/posts/${encodeURIComponent(id)}/publish`,
      body,
      {
        timeoutMs: PUBLISH_TIMEOUT_MS,
      },
    );
  }
}
