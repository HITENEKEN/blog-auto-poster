import type { AdItem, AdTopic, RankedAd } from './AdTypes';

/**
 * 주제–소재 관련성 매칭 (설계 §3-2). 순수 함수 — 유닛 테스트 대상.
 *
 * 무관한 상품으로 자리를 채우지 않는다(이슈 #21 교훈: 청바지 글에 쌀·화장지).
 * 점수가 0인 소재는 결과에서 아예 빠지고, 개수 미달 판정은 호출부가 한다
 * (이 함수는 `minAds`로 실패를 판정하지 않는다).
 */

/** 키워드 완전 일치 */
const SCORE_KEYWORD_EXACT = 100;
/** 한쪽이 다른 쪽을 포함 */
const SCORE_KEYWORD_CONTAINS = 70;
/** 카테고리 일치 */
const SCORE_CATEGORY_EXACT = 40;
/** 조상 카테고리 일치 */
const SCORE_CATEGORY_ANCESTOR = 25;

/**
 * 표기 변형을 하나로 모은다 — 소문자화 후 공백·문장부호·기호를 제거한다.
 * `트위드 자켓`과 `트위드자켓`, `Tweed-Jacket`과 `tweedjacket`이 같은 값이 된다.
 */
export function normalizeKeyword(value: string): string {
  return (value ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 주제 키워드와 소재 키워드들 사이의 최고 점수. */
function scoreKeywords(topic: string, adKeywords: string[] | undefined): number {
  const target = normalizeKeyword(topic);
  if (!target) return 0;
  let best = 0;
  for (const keyword of adKeywords ?? []) {
    const normalized = normalizeKeyword(keyword);
    if (!normalized) continue;
    if (normalized === target) return SCORE_KEYWORD_EXACT;
    if (normalized.includes(target) || target.includes(normalized)) {
      best = Math.max(best, SCORE_KEYWORD_CONTAINS);
    }
  }
  return best;
}

/** 주제 카테고리와 소재 카테고리 사이의 점수(일치 40, 조상 일치 25, 그 외 0). */
function scoreCategory(topic: AdTopic, ad: AdItem): number {
  if (!topic.categoryId || !ad.categoryId) return 0;
  if (ad.categoryId === topic.categoryId) return SCORE_CATEGORY_EXACT;
  if ((topic.categoryPath ?? []).includes(ad.categoryId)) return SCORE_CATEGORY_ANCESTOR;
  return 0;
}

/** active이고 만료되지 않은 소재만 배치 대상이다. */
export function isUsableAd(ad: AdItem, now: Date = new Date()): boolean {
  if (ad.status !== 'active') return false;
  if (!ad.expiresAt) return true;
  const expiresAt = Date.parse(ad.expiresAt);
  // 파싱 불가한 만료값은 막지 않는다 — 상태(active)가 이미 사람의 판단을 담고 있다.
  return Number.isNaN(expiresAt) ? true : expiresAt > now.getTime();
}

function createdAtMs(ad: AdItem): number {
  const parsed = Date.parse(ad.createdAt ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 주제에 맞는 소재를 점수 내림차순으로 돌려준다(설계 §3-2).
 *
 * - 키워드 완전 일치 100 · 포함 70 · 카테고리 일치 40 · 조상 일치 25, 모두 0이면 제외
 * - 동점이면 `usedCount`가 적은 순 → `createdAt`이 최근인 순(같은 상품 반복 노출 방지)
 * - 그래도 같으면 id 순 — 결과가 입력 순서에 흔들리지 않게 한다
 */
export function matchAds(topic: AdTopic, inventory: AdItem[], now: Date = new Date()): RankedAd[] {
  const ranked: RankedAd[] = [];
  for (const ad of inventory ?? []) {
    if (!isUsableAd(ad, now)) continue;
    const keywordScore = scoreKeywords(topic.keyword, ad.keywords);
    const categoryScore = scoreCategory(topic, ad);
    const score = Math.max(keywordScore, categoryScore);
    if (score === 0) continue;
    ranked.push({
      ad,
      score,
      matchedBy: keywordScore > 0 && keywordScore >= categoryScore ? 'keyword' : 'category',
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.ad.usedCount !== b.ad.usedCount) return a.ad.usedCount - b.ad.usedCount;
    const createdDiff = createdAtMs(b.ad) - createdAtMs(a.ad);
    if (createdDiff !== 0) return createdDiff;
    return a.ad.id < b.ad.id ? -1 : a.ad.id > b.ad.id ? 1 : 0;
  });
  return ranked;
}
