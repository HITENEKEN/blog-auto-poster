/**
 * Pure helpers for NAVER API Hub trend analysis (SCH_TRND / SHPP_INST).
 * No @core/* imports — keeps unit tests free of runtime alias resolution.
 *
 * Ratio semantics (NAVER DataLab): every ratio in a single API request is
 * normalized so the maximum data point across ALL keyword groups in that
 * request equals 100. A single-group request therefore always peaks at 100 —
 * meaningless on its own. All volume scoring goes through `scaleVolume()`
 * against a fixed anchor keyword included in every request.
 */

export type TrendDataPoint = { period: string; ratio: number };
export type TrendSeries = TrendDataPoint[];

export type ShoppingCategoryPick = {
  name: string;
  category: string;
  shoppingRatio: number;
};

export type ShoppingCategoryObservation = {
  name: string;
  category: string;
  peakRatio: number;
};

/** Shopping-intent markers for rule-based keyword selection (SHPP_INST probe input). */
export const DEFAULT_SHOPPING_SIGNALS: readonly string[] = [
  '추천',
  '가격',
  '최저가',
  '리뷰',
  '랭킹',
  '비교',
  '순위',
  '가성비',
  '할인',
  '쿠폰',
];

/** Max SHPP_INST keyword pairs per request (API limit). */
export const SHOPPING_KEYWORDS_PER_REQUEST = 5;
/** Max candidate keyword groups per SCH_TRND request (API limit is 5; anchor takes one slot). */
export const TREND_GROUPS_PER_REQUEST = 5;
/** Config ceiling for the probe category pool. */
export const SHOPPING_CATEGORY_POOL_MAX = 10;

/** NAVER DataLab SCH_TRND 연령 코드 — /search-trend/v1/search `ages` 값. */
export const AGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '1', label: '0-12세' },
  { code: '2', label: '13-18세' },
  { code: '3', label: '19-24세' },
  { code: '4', label: '25-29세' },
  { code: '5', label: '30-34세' },
  { code: '6', label: '35-39세' },
  { code: '7', label: '40-44세' },
  { code: '8', label: '45-49세' },
  { code: '9', label: '50-54세' },
  { code: '10', label: '55-59세' },
  { code: '11', label: '60세이상' },
];

/** 프리셋 기간 선택 (키워드 리서치 검색 필터). */
export type DatePreset = 'today' | 'yesterday' | 'last-7d' | 'last-30d';

/**
 * 프리셋을 yyyy-mm-dd 구간으로 변환. 순수 함수 — `now`를 주입해 테스트한다.
 * today: 당일=당일 / yesterday: 전일=전일 / last-7d: 오늘-6 ~ 오늘 / last-30d: 오늘-29 ~ 오늘
 */
export function resolvePresetRange(
  preset: DatePreset,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(
      2,
      '0',
    )}`;
  const start = new Date(now);
  if (preset === 'yesterday') {
    start.setDate(start.getDate() - 1);
    return { startDate: fmt(start), endDate: fmt(start) };
  }
  if (preset === 'last-7d') start.setDate(start.getDate() - 6);
  if (preset === 'last-30d') start.setDate(start.getDate() - 29);
  return { startDate: fmt(start), endDate: fmt(now) };
}

/** yyyy-mm-dd 분해 결과 — 년/월/일 숫자 부분. */
export type DateParts = { y: number; m: number; d: number };

/** 해당 월의 말일 (윤년 2월 포함). `m`은 1-12. */
export function daysInMonth(y: number, m: number): number {
  if (m === 2) {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 31;
}

/**
 * yyyy-mm-dd 문자열을 부분으로 분해. 형식(4-2-2 자리, 선행 0) 또는 달력상
 * 존재하지 않는 날짜(예: 2/30, 13월)면 null.
 */
export function parseDateParts(s: string): DateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

/** 부분을 yyyy-mm-dd로 재조립 (0-padding 보장). */
export function toDateString({ y, m, d }: DateParts): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * 시작 ≤ 종료이고 둘 다 유효한 yyyy-mm-dd일 때 true — 클라이언트 기간 검증의
 * 순수 함수 버전 (서버 라우트 검증의 이중 방어).
 */
export function validateDateRange(a: string, b: string): boolean {
  const pa = parseDateParts(a);
  const pb = parseDateParts(b);
  if (!pa || !pb) return false;
  return toDateString(pa) <= toDateString(pb);
}

/** yyyy-mm-dd date window for the last N months (SCH_TRND/SHPP_INST 요청 바디). */
export function monthRange(
  months: number,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const end = now;
  const start = new Date(now);
  start.setMonth(start.getMonth() - months);
  return {
    startDate: toDateString({
      y: start.getFullYear(),
      m: start.getMonth() + 1,
      d: start.getDate(),
    }),
    endDate: toDateString({ y: end.getFullYear(), m: end.getMonth() + 1, d: end.getDate() }),
  };
}

/**
 * Rule-based shopping-intent classifier. Deterministic, zero-cost — a trend
 * keyword only reaches the SHPP_INST probe when it matches a signal.
 */
export function isShoppingKeyword(
  keyword: string,
  signals: readonly string[] = DEFAULT_SHOPPING_SIGNALS,
): boolean {
  if (!keyword) return false;
  return signals.some((s) => s.length > 0 && keyword.includes(s));
}

/**
 * Classify a monthly ratio series. Last 3 points vs the points before them;
 * ±20% threshold mirrors the legacy blog-postdate heuristic.
 */
export function classifyTrend(series: TrendSeries): 'rising' | 'falling' | 'stable' {
  if (series.length < 4) return 'stable';
  const avg = (pts: TrendSeries) => pts.reduce((s, p) => s + p.ratio, 0) / pts.length;
  const recent = avg(series.slice(-3));
  const olderPts = series.slice(0, series.length - 3);
  const older = avg(olderPts);
  const change = older > 0 ? (recent - older) / older : recent > 0 ? 1 : 0;
  if (change > 0.2) return 'rising';
  if (change < -0.2) return 'falling';
  return 'stable';
}

export function peakRatio(series: TrendSeries): number {
  return series.reduce((m, p) => Math.max(m, p.ratio), 0);
}

/**
 * Anchor-relative volume score. The anchor keyword is present in every
 * SCH_TRND request so scores stay comparable across chunked requests.
 * Range: 0..1000, where the anchor itself scores 1000.
 */
export function scaleVolume(keywordPeak: number, anchorPeak: number): number {
  if (anchorPeak <= 0) return Math.round(keywordPeak * 1000);
  return Math.round((keywordPeak / anchorPeak) * 1000);
}

/**
 * SHPP_INST category probe resolution: the pool observation with the highest
 * click ratio wins. All-zero/empty observations → null (graceful skip).
 */
export function pickShoppingCategory(
  observations: ShoppingCategoryObservation[],
): ShoppingCategoryPick | null {
  const best = observations
    .filter((o) => o.peakRatio > 0)
    .sort((a, b) => b.peakRatio - a.peakRatio)[0];
  if (!best) return null;
  return { name: best.name, category: best.category, shoppingRatio: best.peakRatio };
}
