import { classifyTrend, type TrendSeries } from '@intelligence/TrendAnalysis';
import { DAY_MS } from './kst';
import {
  DRAFT_TEXT_CODES,
  FORBIDDEN_TEXT_RULES,
  findForbiddenTextCodes,
} from '@content/ForbiddenText';

/**
 * 스킬 규칙의 코드화 — `.omp/skills/naver-blog-cycle/SKILL.md` §5·§6·§11이 원본이었고,
 * 설계 `documents/24-auto-poster-robot-design.md` §5-4에서 이 파일로 옮겨 왔다.
 * 옮긴 뒤에는 **이 코드가 단일 출처**다(스킬은 이 파일을 가리키는 포인터만 둔다).
 *
 * 이 파일은 순수 함수·상수만 담는다: 네트워크·DB·fs 접근 없음.
 */

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 스킬 §11 상한: 주 3회. 설정값이 이 값을 넘으면 기동을 거부한다(§6 검증). */
export const WEEKLY_HARD_CAP = 3;

/** 스킬 §2 S0: NID_AUT/NID_SES 잔여일이 이보다 짧으면 중단(사람이 `npm run naver:login`). */
export const SESSION_MIN_DAYS = 14;

/** 중복 윈도우(스킬 §11): 동일 키워드/주제 180일, 계절 키워드는 365일. */
export const DUPLICATE_WINDOW_DAYS = 180;
export const SEASONAL_DUPLICATE_WINDOW_DAYS = 365;

/**
 * 광고 블록 수 하드 캡 — 광고 모듈의 `AdPolicy.maxBlocks` 상한(설계 §3-1 `maxBlocks: 4`)과
 * 같은 값이다. `robot.ads.maxBlocks` 설정이 이 값을 넘으면 기동을 거부한다.
 */
export const MAX_BLOCKS_HARD_CAP = 4;

/** 묶음 광고 상한 — `AdPolicy.bundleSize` 상한(설계 §3-1 `[2, 3]`). */
export const MAX_BUNDLE_SIZE = 3;

/** 판단(§5-3)에서 소재 요청 기준으로 넘길 개수. */
export const PRODUCT_CRITERIA_COUNT = 3;

/** 로봇이 허용하는 실행 종류. */
export type RunKind = 'plan' | 'publish';

// ---------------------------------------------------------------------------
// 정규화
// ---------------------------------------------------------------------------

/**
 * 키워드·제목 비교용 정규화: 소문자 → 공백·문장부호·기호 제거(한글은 보존).
 * `트위드 자켓`과 `트위드자켓`은 같아진다(스킬 §5 조건 3의 표기 변형 규칙).
 * `\W`는 한글도 비단어로 취급하므로 쓰지 않는다 — `\p{P}`/`\p{S}`로 구두점·기호만 지운다.
 */
export function normalizeKeyword(value: string): string {
  return (value || '').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');
}

/** HTML 태그를 걷어낸 본문 텍스트(공백 정리 포함). */
export function stripTags(html: string): string {
  return (html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 공백 제외 본문 길이 — `checkEditedDraft`의 70% 규칙에 쓴다. */
export function bodyTextLength(html: string): number {
  return stripTags(html).replace(/\s+/g, '').length;
}

export function countMatches(html: string, re: RegExp): number {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  return (html || '').match(new RegExp(re.source, flags))?.length ?? 0;
}

export function extractH2Titles(html: string): string[] {
  const titles: string[] = [];
  const re = /<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html || '')) !== null) titles.push(stripTags(m[1]));
  return titles;
}

/** 태그별로 속성값을 **전부** 뽑는다(한 태그에 같은 속성이 두 번 있어도 놓치지 않는다). */
function extractAttrValues(html: string, tag: string, attr: string): string[] {
  const values: string[] = [];
  const tagRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
  const attrRe = new RegExp(`\\b${attr}=("([^"]*)"|'([^']*)')`, 'gi');
  for (const tagText of (html || '').match(tagRe) ?? []) {
    attrRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(tagText)) !== null) {
      const value = m[2] ?? m[3] ?? '';
      if (value) values.push(value);
    }
  }
  return values;
}

export function extractImageSrcs(html: string): string[] {
  return extractAttrValues(html, 'img', 'src');
}

export function extractLinkHrefs(html: string): string[] {
  return extractAttrValues(html, 'a', 'href');
}

// ---------------------------------------------------------------------------
// 금지 패턴 (스킬 §6 / 설계 §5-4)
// ---------------------------------------------------------------------------

/**
 * 금지 문구 표는 `@content/ForbiddenText`가 **단일 출처**다(설계 §5-4).
 * 초안 편집 게이트와 광고 게이트가 같은 규칙을 봐야 한쪽만 통과하는 초안이 없다.
 * 여기서는 초안 본문 스코프(DRAFT_TEXT_CODES)로 조회만 한다.
 */

/** 본문에서 일치한 금지 패턴 코드 목록(중복 없이, 표 순서 유지). */
export function findForbiddenPatterns(text: string): string[] {
  return findForbiddenTextCodes(text, DRAFT_TEXT_CODES);
}

/**
 * 코드 → 정규식 맵(설계 §5-4 표기). 표 자체는 위 단일 출처에서 파생된 **읽기용 뷰**다 —
 * 정규식을 여기서 다시 쓰지 않는다(중복 정의 = 규칙 분기).
 */
export const FORBIDDEN_PATTERNS: Record<string, RegExp> = Object.fromEntries(
  DRAFT_TEXT_CODES.map((code) => [
    code,
    new RegExp(
      FORBIDDEN_TEXT_RULES.find((rule) => rule.code === code)?.re.source ?? '(?!)',
      FORBIDDEN_TEXT_RULES.find((rule) => rule.code === code)?.re.flags ?? '',
    ),
  ]),
);

/** 구조 금지: iframe 0, 스크립트 0 (스킬 §6 구조 규칙). */
export function findForbiddenStructure(html: string): string[] {
  const codes: string[] = [];
  if (countMatches(html, /<iframe\b/i) > 0) codes.push('IFRAME');
  if (countMatches(html, /<script\b/i) > 0) codes.push('SCRIPT');
  return codes;
}

// ---------------------------------------------------------------------------
// 수요·포화·중복 (스킬 §5 조건 1·2·3, §11)
// ---------------------------------------------------------------------------

/** 주간 시계열의 최근 4주 구간(부족하면 가진 만큼). */
export function lastWeeks(series: TrendSeries, weeks = 4): TrendSeries {
  return (series || []).slice(-weeks);
}

/**
 * 아직 끝나지 않은 마지막 주를 제거한다.
 * 검색어트렌드를 `timeUnit=week`로 조회하면 **현재 진행 중인 주가 부분 집계**로 마지막에
 * 붙는다(예: 화요일 조회 → 월·화 이틀만 반영). 이 값을 '최근 4주'에 넣으면 모든 키워드가
 * 하락으로 보이므로, 완결된 주끼리 비교하기 위해 마지막 구간을 버린다(스킬 §5 "최근 4주").
 */
export function dropPartialWeek(series: TrendSeries, now: Date): TrendSeries {
  const points = series || [];
  if (!points.length) return points;
  const last = points[points.length - 1];
  const bucketStartMs = Date.parse(`${last.period}T00:00:00+09:00`);
  if (Number.isNaN(bucketStartMs)) return points;
  return now.getTime() < bucketStartMs + 7 * DAY_MS ? points.slice(0, -1) : points;
}

/**
 * 수요 조건(스킬 §5 조건 1): 하락이 아니면서, 최근 4주의 마지막 값이 최근 4주 최댓값의 80% 이상.
 * 상대 지수(0–100)를 그대로 쓴다 — 절대 검색량이 아니다.
 */
export function isDemandOk(series: TrendSeries, now?: Date): boolean {
  const points = now ? dropPartialWeek(series, now) : series || [];
  const recent = lastWeeks(points, 4);
  if (recent.length === 0) return false;
  if (classifyTrend(points) === 'falling') return false;
  const peak = recent.reduce((m, p) => Math.max(m, p.ratio), 0);
  if (peak <= 0) return false;
  const last = recent[recent.length - 1].ratio;
  return last >= peak * 0.8;
}

/** 후보 전체(경쟁 문서량)의 중앙값. 짝수 개면 두 중앙값의 평균. */
export function medianBlogsSim(values: number[]): number {
  const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 포화 조건(스킬 §5 조건 2): `blogs.sim`(유사도순 문서 수)이 후보 전체 중앙값 이하.
 * 한 후보만 있으면 자기 자신이 중앙값이므로 통과한다.
 */
export function isSaturationOk(candidateSim: number, allSims: number[]): boolean {
  if (!Number.isFinite(candidateSim)) return false;
  return candidateSim <= medianBlogsSim(allSims);
}

export interface LivePostTitle {
  title: string;
  pubDate: Date | null;
}

/**
 * 중복 조건(스킬 §5 조건 3, §11): 정규화 키워드가 라이브 제목에 포함되고
 * pubDate가 윈도우(기본 180일, 계절은 365일) 이내. pubDate가 없으면 보수적으로 중복으로 본다.
 */
export function isDuplicate(
  keyword: string,
  live: LivePostTitle[],
  days: number = DUPLICATE_WINDOW_DAYS,
  now: Date = new Date(),
): boolean {
  const needle = normalizeKeyword(keyword);
  if (!needle) return false;
  const windowMs = days * 24 * 60 * 60 * 1000;
  for (const post of live || []) {
    const haystack = normalizeKeyword(post.title);
    if (!haystack || !haystack.includes(needle)) continue;
    if (!post.pubDate) return true;
    const age = now.getTime() - post.pubDate.getTime();
    if (age < 0 || age > windowMs) continue;
    return true;
  }
  return false;
}

/** 연속 카테고리 제한(스킬 §11): 직전 발행 실행과 같은 카테고리면 탈락. */
export function isConsecutiveCategory(
  previousCategoryId: string | null | undefined,
  categoryId: string | null | undefined,
): boolean {
  if (!previousCategoryId || !categoryId) return false;
  return String(previousCategoryId) === String(categoryId);
}

/** 주간 상한(스킬 §11): RSS 최근 7일 수와 이번 주(KST 월–일) 로봇 발행 수 중 **큰 값**. */
export function weeklyPublishedCount(rssLast7Days: number, robotThisWeek: number): number {
  return Math.max(Number(rssLast7Days) || 0, Number(robotThisWeek) || 0);
}

export function isWeeklyCapReached(rssLast7Days: number, robotThisWeek: number): boolean {
  return weeklyPublishedCount(rssLast7Days, robotThisWeek) >= WEEKLY_HARD_CAP;
}

// ---------------------------------------------------------------------------
// 후보 필터·순위 (스킬 §5, 설계 §5-4 `rankTopics`)
// ---------------------------------------------------------------------------

export interface TopicCandidate {
  keyword: string;
  categoryId?: string;
  categoryName?: string;
  /** 주간 상대지수 시계열(검색어트렌드, 16주) */
  series: TrendSeries;
  /** 분야 클릭지수 시계열(쇼핑인사이트, 카테고리 단위) */
  categorySeries?: TrendSeries;
  /** 경쟁 문서량: 유사도순(sim) / 최신순(date) 총 건수 */
  blogs: { sim: number; date: number };
  /** Judge가 채운다 — 경험 없이 기준형으로 정직하게 쓸 수 있는 주제인지 */
  writable?: boolean;
  seasonal?: boolean;
  angle?: string;
  reason?: string;
  productCriteria?: string[];
  /** 보유 active 소재 수(설계 §5-1 `REQUEST_ADS` 조회 결과) */
  adCount: number;
}

export interface RejectedTopic {
  keyword: string;
  reasons: string[];
}

export interface TopicFilterResult {
  pass: TopicCandidate[];
  rejected: RejectedTopic[];
}

/**
 * 1차 필터 — 판단(LLM) 전에 수치로만 거른다. 탈락 사유는 실행 증거
 * (`keyword/decision.md`)에 그대로 남는다(스킬 §5 기록 요건).
 */
export function filterCandidates(
  candidates: TopicCandidate[],
  opts: {
    live: LivePostTitle[];
    now?: Date;
    previousCategoryId?: string | null;
    requireCategoryTrend?: boolean;
  },
): TopicFilterResult {
  const now = opts.now ?? new Date();
  const allSims = (candidates || []).map((c) => c.blogs?.sim ?? Number.NaN);
  const pass: TopicCandidate[] = [];
  const rejected: RejectedTopic[] = [];

  for (const candidate of candidates || []) {
    const reasons: string[] = [];
    // 완결된 주만 비교한다(진행 중인 주는 부분 집계 — dropPartialWeek 주석 참조).
    const series = dropPartialWeek(candidate.series, now);
    const categorySeries = candidate.categorySeries
      ? dropPartialWeek(candidate.categorySeries, now)
      : candidate.categorySeries;
    if (candidate.writable === false) reasons.push('not-writable');
    if (!isDemandOk(series)) reasons.push('demand');

    if (opts.requireCategoryTrend !== false && categorySeries) {
      if (classifyTrend(categorySeries) === 'falling') reasons.push('category-trend');
    }

    if (!isSaturationOk(candidate.blogs?.sim ?? Number.NaN, allSims)) reasons.push('saturation');

    const window = candidate.seasonal ? SEASONAL_DUPLICATE_WINDOW_DAYS : DUPLICATE_WINDOW_DAYS;
    if (isDuplicate(candidate.keyword, opts.live, window, now)) reasons.push('duplicate');

    if (isConsecutiveCategory(opts.previousCategoryId, candidate.categoryId)) {
      reasons.push('consecutive-category');
    }

    if (reasons.length) rejected.push({ keyword: candidate.keyword, reasons });
    // 통과 후보는 완결 주 시계열로 넘긴다(순위 계산도 같은 기준을 쓰도록).
    else pass.push({ ...candidate, series, categorySeries });
  }

  return { pass, rejected };
}

export interface RankedTopic {
  candidate: TopicCandidate;
  score: number;
}

/** 소재 보유 가점(설계 §5-4). */
export const AD_BONUS = 0.3;

/**
 * 주제 순위(설계 §5-4): 점수 = 최근 4주 평균 지수 × (1 + 소재 보유 가점 0.3) ÷ log10(blogs.sim + 10).
 * 동점이면 소재가 많은 순, 그다음 keyword 사전순(결정적 순서).
 */
export function rankTopics(candidates: TopicCandidate[]): RankedTopic[] {
  return (candidates || [])
    .map((candidate) => {
      const recent = lastWeeks(candidate.series, 4);
      const avg = recent.length ? recent.reduce((s, p) => s + p.ratio, 0) / recent.length : 0;
      const bonus = (candidate.adCount || 0) > 0 ? 1 + AD_BONUS : 1;
      const divisor = Math.log10(Math.max(candidate.blogs?.sim ?? 0, 0) + 10);
      const score = divisor > 0 ? (avg * bonus) / divisor : 0;
      return { candidate, score: Math.round(score * 1000) / 1000 };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ads = (b.candidate.adCount || 0) - (a.candidate.adCount || 0);
      if (ads !== 0) return ads;
      return a.candidate.keyword.localeCompare(b.candidate.keyword);
    });
}

// ---------------------------------------------------------------------------
// 편집 게이트 (설계 §5-3 `checkEditedDraft`)
// ---------------------------------------------------------------------------

export interface EditedDraftViolation {
  code: string;
  message: string;
  detail?: unknown;
}

const MIN_EDIT_RATIO = 0.7;

/**
 * LLM 편집본 검증. 원본 대비 구조가 망가졌거나 금지 문구가 들어오면 위반 목록을 돌려준다
 * (호출부는 위반을 되먹여 최대 3회 재편집하고, 그래도 남으면 `aborted-edit-gate`).
 */
export function checkEditedDraft(original: string, edited: string): EditedDraftViolation[] {
  const violations: EditedDraftViolation[] = [];
  const src = original || '';
  const out = edited || '';

  const h2Before = countMatches(src, /<h2\b/i);
  const h2After = countMatches(out, /<h2\b/i);
  if (h2Before !== h2After) {
    violations.push({
      code: 'H2_COUNT',
      message: `h2 개수가 달라졌습니다 (원본 ${h2Before} → 편집 ${h2After})`,
    });
  }

  const imagesBefore = new Set(extractImageSrcs(src));
  const addedImages = extractImageSrcs(out).filter((src) => !imagesBefore.has(src));
  if (addedImages.length) {
    violations.push({
      code: 'IMAGE_ADDED',
      message: '원본에 없는 이미지가 추가되었습니다',
      detail: addedImages.slice(0, 5),
    });
  }

  const linksBefore = new Set(extractLinkHrefs(src));
  const addedLinks = extractLinkHrefs(out).filter(
    (href) => !linksBefore.has(href) && !href.startsWith('#'),
  );
  if (addedLinks.length) {
    violations.push({
      code: 'LINK_ADDED',
      message: '원본에 없는 링크가 추가되었습니다',
      detail: addedLinks.slice(0, 5),
    });
  }

  const forbidden = findForbiddenPatterns(stripTags(out));
  if (forbidden.length) {
    violations.push({
      code: 'FORBIDDEN_TEXT',
      message: `금지 문구가 남아 있습니다: ${forbidden.join(', ')}`,
      detail: forbidden,
    });
  }

  const structure = findForbiddenStructure(out);
  if (structure.length) {
    violations.push({
      code: 'FORBIDDEN_STRUCTURE',
      message: `직렬화되지 않는 요소가 있습니다: ${structure.join(', ')}`,
      detail: structure,
    });
  }

  const beforeLen = bodyTextLength(src);
  const afterLen = bodyTextLength(out);
  if (beforeLen > 0 && afterLen < beforeLen * MIN_EDIT_RATIO) {
    violations.push({
      code: 'TOO_SHORT',
      message: `본문이 원본의 ${Math.round(MIN_EDIT_RATIO * 100)}% 미만입니다 (${beforeLen} → ${afterLen})`,
    });
  }

  const widgetBefore = countMatches(src, /data-coupang-widget=/i);
  const widgetAfter = countMatches(out, /data-coupang-widget=/i);
  if (widgetBefore !== widgetAfter) {
    violations.push({
      code: 'WIDGET_MARKER',
      message: `쿠팡 위젯 마커 수가 달라졌습니다 (${widgetBefore} → ${widgetAfter})`,
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 설정 검증 (설계 §6)
// ---------------------------------------------------------------------------

export interface RobotAdsPolicyInput {
  minAds: number;
  minBlocks: number;
  maxBlocks: number;
  bundleSize: [number, number];
}

export interface RobotConfigLike {
  enabled: boolean;
  mode: 'manual' | 'auto';
  categories: string[];
  images: { review: 'human' | 'vision' | 'drop' };
  slots: { plan: SlotSpec[]; publish: SlotSpec[] };
  ads: RobotAdsPolicyInput;
}

export interface SlotSpec {
  day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  time: string;
}

/** 설정 검증 실패 사유(빈 배열이면 통과). */
export function validateRobotConfig(config: RobotConfigLike): string[] {
  const errors: string[] = [];

  if (config.mode === 'auto' && config.images?.review === 'human') {
    errors.push('mode=auto에서는 images.review=human을 쓸 수 없습니다 (사람 승인 단계가 없음)');
  }

  if (config.enabled && (config.categories || []).length === 0) {
    errors.push('enabled=true인데 robot.categories가 비어 있습니다');
  }

  for (const kind of ['plan', 'publish'] as const) {
    const slots = config.slots?.[kind] || [];
    if (slots.length > WEEKLY_HARD_CAP) {
      errors.push(
        `${kind} 슬롯이 주 ${slots.length}회입니다 — 주간 상한 ${WEEKLY_HARD_CAP}회를 넘습니다`,
      );
    }
  }

  const ads = config.ads;
  if (ads) {
    if (ads.maxBlocks > MAX_BLOCKS_HARD_CAP) {
      errors.push(
        `robot.ads.maxBlocks=${ads.maxBlocks}가 하드 캡 ${MAX_BLOCKS_HARD_CAP}을 넘습니다`,
      );
    }
    if (ads.minBlocks > ads.maxBlocks) {
      errors.push('robot.ads.minBlocks가 maxBlocks보다 큽니다');
    }
    if (!Array.isArray(ads.bundleSize) || ads.bundleSize.length !== 2) {
      errors.push('robot.ads.bundleSize는 [min, max] 두 값이어야 합니다');
    } else if (ads.bundleSize[1] > MAX_BUNDLE_SIZE) {
      errors.push(`robot.ads.bundleSize 상한이 ${MAX_BUNDLE_SIZE}를 넘습니다`);
    } else if (ads.bundleSize[0] > ads.bundleSize[1]) {
      errors.push('robot.ads.bundleSize[0]이 [1]보다 큽니다');
    }
    if (ads.minAds < 1) errors.push('robot.ads.minAds는 1 이상이어야 합니다');
  }

  return errors;
}
