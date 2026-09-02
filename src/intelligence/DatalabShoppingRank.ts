import { getLogger } from '@core/logger';
import { getCache } from '@core/cache';
import { getConfigManager } from '@core/config';
import { createHttpClient } from '@core/http';
import * as path from 'path';

const logger = getLogger('datalab-shopping-rank');

/**
 * 네이버 데이터랩 쇼핑인사이트 데이터 모듈.
 *
 * 1. 분야 인기검색어 랭킹 — 내부 XHR API(`getCategoryKeywordRank.naver`) 직조회
 *    (이슈 #14). 공식 쇼핑인사이트 API에는 랭킹 엔드포인트가 없어(8개 전부 트렌드
 *    추이 조회) 웹 UI가 사용하는 내부 엔드포인트를 사용한다. 로그인/쿠키 불필요,
 *    Referer + `x-requested-with` 헤더만 필요(실측 검증 완료).
 * 2. 분야 코드표 수집 — 카테고리 트리는 내부 API가 없어 웹 UI 크롤링(1회성/월간).
 */

const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'browser-profiles', 'naver');

let browserChain: Promise<unknown> = Promise.resolve();

// ============================================================================
// 분야 인기검색어 랭킹 — 내부 XHR API 직조회 (이슈 #14)
// ============================================================================

export interface DatalabRankRow {
  rank: number;
  keyword: string;
  linkId?: string;
}

export interface DatalabRankQuery {
  catId: string;
  startDate: string;
  endDate: string;
  timeUnit: 'date' | 'week' | 'month';
  device?: string;
  gender?: string;
  ages?: string[];
  /** 조회 개수(1~20) — 내부 API가 페이지당 20개씩 페이지네이션한다(검증된 상한). */
  count?: number;
}

const RANK_CACHE_TTL_SECONDS = 24 * 60 * 60;
const DATALAB_RANK_MAX_COUNT = 20;

const rankCache = getCache<DatalabRankRow[]>('datalab-rank', {
  ttlSeconds: RANK_CACHE_TTL_SECONDS,
});

/** 랭킹 조회 form 파라미터 빌드(순수 함수 — 유닛 테스트 대상). 내부 API 스펙(이슈
 *  #14 실측): age는 다중 값 콤마 조인(`age=20,30`), 미지정 필드는 빈 문자열. */
export function buildRankFormParams(query: DatalabRankQuery): URLSearchParams {
  const count = Math.min(
    Math.max(query.count ?? DATALAB_RANK_MAX_COUNT, 1),
    DATALAB_RANK_MAX_COUNT,
  );
  const params = new URLSearchParams({
    cid: query.catId,
    timeUnit: query.timeUnit,
    startDate: query.startDate,
    endDate: query.endDate,
    age: (query.ages ?? []).join(','),
    gender: query.gender ?? '',
    device: query.device ?? '',
    page: '1',
    count: String(count),
  });
  return params;
}

/** 랭킹 응답 파서(순수 함수 — 유닛 테스트 대상). `{statusCode, ranks:[{rank,
 *  keyword, linkId}]}` 셰이프만 채택 — 개편/접속 제한으로 HTML이 오면 throw 대신
 *  호출부가 에러를 판단할 수 있게 예외를 던진다. 빈 ranks(무효 분야)는 빈 배열. */
export function parseDatalabRankPayload(payload: unknown): DatalabRankRow[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('datalab rank: unexpected response (non-object payload)');
  }
  const body = payload as { statusCode?: unknown; ranks?: unknown };
  if (body.statusCode !== 200) {
    throw new Error(`datalab rank: statusCode ${String(body.statusCode)}`);
  }
  if (!Array.isArray(body.ranks)) {
    throw new Error('datalab rank: ranks is not an array');
  }
  const rows: DatalabRankRow[] = [];
  for (const raw of body.ranks) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as { rank?: unknown; keyword?: unknown; linkId?: unknown };
    if (typeof item.keyword !== 'string' || item.keyword.trim() === '') continue;
    rows.push({
      rank: typeof item.rank === 'number' ? item.rank : rows.length + 1,
      keyword: item.keyword.trim(),
      ...(typeof item.linkId === 'string' ? { linkId: item.linkId } : {}),
    });
  }
  return rows;
}

const DATALAB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 데이터랩 내부 API 클라이언트 — 재시도/타임아웃은 공용 http 클라이언트를 쓴다.
 *  헤더(UA/Referer/x-requested-with)가 없으면 404 HTML을 반환하므로(실측) 요청마다
 *  부착한다. baseUrl은 설정으로 교체 가능(e2e mock). */
const datalabClient = createHttpClient({ timeout: 15_000, maxRetries: 2 });

/**
 * 분야 인기검색어 랭킹(1~count위)을 조회한다. 24h 디스크 캐시(키에 기간·필터 전체
 * 포함 — 같은 분야라도 조건별 결과가 다르다). 실패 시 throw — 호출부가 빈 목록으로
 * 처리한다.
 */
export async function fetchDatalabCategoryKeywordRank(
  query: DatalabRankQuery,
): Promise<DatalabRankRow[]> {
  const params = buildRankFormParams(query);
  const cacheKey = params.toString();
  const cached = rankCache.get(cacheKey);
  if (cached) return cached;

  const baseUrl = String(
    getConfigManager().get('keywords.datalabApi.baseUrl', 'https://datalab.naver.com'),
  );
  const response = await datalabClient.post(
    `${baseUrl}/shoppingInsight/getCategoryKeywordRank.naver`,
    params.toString(),
    {
      headers: {
        'User-Agent': DATALAB_UA,
        Referer: `${baseUrl}/shoppingInsight/sCategory.naver`,
        'x-requested-with': 'XMLHttpRequest',
        // 인스턴스 기본값(application/json)을 덮는다 — 내부 API는 form-urlencoded만 받는다.
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    },
  );
  const rows = parseDatalabRankPayload(response.data);
  rankCache.set(cacheKey, rows, RANK_CACHE_TTL_SECONDS);
  logger.info({ catId: query.catId, count: rows.length }, 'Datalab category rank fetched');
  return rows;
}

// ============================================================================
// 카테고리 코드표 재귀 수집(1~4분류) + 갱신 오케스트레이션
// ============================================================================

export interface DatalabCategoryTreeNode {
  catId: string;
  name: string;
  children?: DatalabCategoryTreeNode[];
}

export interface DatalabCategoryTreeOptions {
  /** 수집할 최대 깊이. 4 = 1분류~4분류. */
  maxDepth?: number;
  /** 진행 상황 콜백(로깅/상태 표시용). */
  onProgress?: (message: string) => void;
}

/**
 * 데이터랩 쇼핑인사이트 분야별 페이지를 1분류→4분류까지 재귀 클릭하며
 * 카테고리 트리 전체를 수집한다(브라우저 약 30~60분). 숨은 옵션은 DOM click으로
 * 이벤트를 발화한다. 갱신 작업과 브라우저 직렬화 락을 공유한다.
 */
export async function fetchDatalabCategoryTree(
  opts: DatalabCategoryTreeOptions = {},
): Promise<DatalabCategoryTreeNode[]> {
  const { chromium } = await import('playwright');
  const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 4, 6));
  const onProgress = opts.onProgress ?? (() => {});
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page
      .goto('https://datalab.naver.com/shoppingInsight/sCategory.naver', {
        waitUntil: 'networkidle',
        timeout: 60_000,
      })
      .catch(() => {});
    await page.waitForTimeout(5_000);

    // 서버 tsconfig에 DOM lib가 없으므로 브라우저 셰이프를 named shim으로 선언한다.
    interface DomCatOption {
      click(): void;
      getAttribute(name: string): string | null;
      textContent?: string | null;
    }
    interface DomCatSelect {
      querySelectorAll(selectors: string): ArrayLike<DomCatOption>;
      querySelector(selectors: string): DomCatOption | null;
    }

    const readCidSelects = () =>
      page
        .evaluate(() => {
          const doc = (
            globalThis as unknown as {
              document: { querySelectorAll(selectors: string): ArrayLike<DomCatSelect> };
            }
          ).document;
          return Array.from(doc.querySelectorAll('div.select')).map((d) => ({
            options: Array.from(d.querySelectorAll('a.option[data-cid]')).map((a) => ({
              cid: a.getAttribute('data-cid') ?? '',
              name: (a.textContent ?? '').trim(),
            })),
          }));
        })
        .then((selects) => selects.map((s) => s.options).filter((o) => o.length > 0))
        .catch(() => [] as Array<Array<{ cid: string; name: string }>>);

    const domClickOption = (cid: string, level: number) =>
      page
        .evaluate(
          ({ cid, level }) => {
            const doc = (
              globalThis as unknown as {
                document: { querySelectorAll(selectors: string): ArrayLike<DomCatSelect> };
              }
            ).document;
            const holders = Array.from(doc.querySelectorAll('div.select')).filter((d) =>
              d.querySelector(`a.option[data-cid="${cid}"]`),
            );
            const holder = holders[level] ?? holders[holders.length - 1];
            const a = holder?.querySelector(`a.option[data-cid="${cid}"]`);
            if (a) {
              a.click();
              return true;
            }
            return false;
          },
          { cid, level },
        )
        .catch(() => false);

    const walkLevel = async (level: number): Promise<DatalabCategoryTreeNode[]> => {
      const options = (await readCidSelects())[level] ?? [];
      if (level >= maxDepth - 1) {
        return options.map((o) => ({ catId: o.cid, name: o.name }));
      }
      const out: DatalabCategoryTreeNode[] = [];
      for (const option of options) {
        await domClickOption(option.cid, level);
        await page.waitForTimeout(level === 0 ? 1_300 : level === 1 ? 900 : 700);
        const children = await walkLevel(level + 1);
        const node: DatalabCategoryTreeNode = { catId: option.cid, name: option.name };
        if (children.length > 0) node.children = children;
        out.push(node);
        onProgress(`${'  '.repeat(level)}${option.name}: 하위 ${children.length}개`);
      }
      return out;
    };

    return await walkLevel(0);
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ---- 갱신 오케스트레이션 ----

export interface CategoryTreeRefreshState {
  running: boolean;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  nodeCount?: number;
}

let refreshState: CategoryTreeRefreshState = { running: false };

/** 카테고리 코드표 갱신 상태 (POST refresh는 백그라운드 실행이므로 상태 폴링용). */
export function getCategoryTreeRefreshState(): CategoryTreeRefreshState {
  return refreshState;
}

function countDatalabTreeNodes(nodes: DatalabCategoryTreeNode[]): number {
  return nodes.reduce(
    (sum, n) => sum + 1 + (n.children ? countDatalabTreeNodes(n.children) : 0),
    0,
  );
}

/**
 * 데이터랩을 실조회해 카테고리 트리를 다시 수집하고 onSave로 저장한다.
 * 저장(SQLite + 커밋용 JSON)은 onSave 콜백(ShoppingCategoryStore)이 담당한다.
 * 실행은 백그라운드로 계속되며 상태는 getCategoryTreeRefreshState로 폴링한다.
 */
export async function refreshDatalabCategoryTree(
  opts: {
    maxDepth?: number;
    onSave?: (tree: DatalabCategoryTreeNode[]) => void;
  } = {},
): Promise<CategoryTreeRefreshState> {
  if (refreshState.running) {
    return { ...refreshState };
  }
  refreshState = { running: true, startedAt: new Date().toISOString() };
  const run = async (): Promise<void> => {
    try {
      const tree = await fetchDatalabCategoryTree({
        maxDepth: opts.maxDepth ?? 4,
        onProgress: (m) => logger.info(m),
      });
      opts.onSave?.(tree);
      refreshState = {
        running: false,
        startedAt: refreshState.startedAt,
        finishedAt: new Date().toISOString(),
        nodeCount: countDatalabTreeNodes(tree),
      };
      logger.info({ nodeCount: refreshState.nodeCount }, 'Datalab category tree refreshed');
    } catch (error) {
      refreshState = {
        running: false,
        finishedAt: new Date().toISOString(),
        error: String(error),
      };
      logger.error({ error: String(error) }, 'Datalab category tree refresh failed');
    }
  };
  // 갱신 작업 간 브라우저 직렬화
  const runSerialized = browserChain.then(run, run);
  browserChain = runSerialized.catch(() => {});
  return refreshState;
}
