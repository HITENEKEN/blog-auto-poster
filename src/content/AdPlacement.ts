import * as cheerio from 'cheerio';
import { liftWidgetMarkers } from './WidgetPlacement';
import {
  AD_BUNDLE_LEAD_TEXT,
  DEFAULT_AD_POLICY,
  type AdItem,
  type AdPolicy,
  type AdSlot,
  type RankedAd,
} from './AdTypes';

/**
 * 섹션 경계 광고 배치 (설계 §3-3). 순수 함수 — 유닛 테스트 대상.
 *
 * 결정적 알고리즘이다. 같은 입력이면 언제나 같은 결과를 내고, 두 번 적용해도
 * 한 번 적용한 것과 같다(`stripAutoAds`가 이전 자동 광고를 먼저 지운다).
 * 배치는 발행 시점이 아니라 **초안 단계**에서 끝낸다 — 사람이 확인한 미리보기와
 * 실제 발행본이 달라지지 않게 하기 위해서다.
 */

export interface AdPlacementPlan {
  html: string;
  slots: AdSlot[];
  notes: string[];
}

/** 자주 묻는 질문 섹션 — 이 섹션 **앞**이 묶음(추천 모음) 자리다. */
const FAQ_TITLE_RE = /자주\s*묻는|FAQ|Q&A/i;

/** 참고/출처 섹션은 광고를 붙이지 않는다(검색엔진이 캡션으로 흡수한 이력 — #17). */
const EXCLUDED_TITLE_RE = /참고|출처|자료|관련\s*글/;

interface Section {
  /** 1-based h2 순번 */
  index: number;
  title: string;
  /** heading 직후 오프셋 */
  start: number;
  /** 다음 heading 직전 오프셋(= 이 섹션의 끝 = 마커 삽입 지점) */
  end: number;
}

interface Insertion {
  offset: number;
  html: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * 자동 광고 마커와 자동 고지를 전부 지운다. 순수 함수.
 *
 * `data-ad-source="auto"`가 붙은 요소만 대상이다 — 사용자가 직접 넣은 위젯은
 * 건드리지 않는다(설계 §3-3 규칙 1).
 */
export function stripAutoAds(html: string): string {
  if (!html || !/data-ad-source\s*=/.test(html)) return html;
  const $ = cheerio.load(html);
  const nodes = $('[data-ad-source="auto"]').toArray();
  if (nodes.length === 0) return html;

  // 문서 전체를 재직렬화하지 않고 해당 요소 문자열만 걷어낸다 — 나머지 바이트가
  // 그대로 남아야 배치가 멱등하고, 최상위 <style>이 cheerio 직렬화에서 head로
  // 옮겨가며 사라지는 일도 없다.
  let out = html;
  for (const el of nodes) {
    const serialized = $.html(el);
    if (!serialized || !out.includes(serialized)) {
      // 예기치 않은 표기(속성 따옴표 변형 등)면 문서를 정규화해 한 번에 지운다.
      const fallback = cheerio.load(html);
      fallback('[data-ad-source="auto"]').remove();
      return fallback('body').html() ?? html;
    }
    out = out.replace(serialized, '');
  }
  return out;
}

/** 자동 광고 마커 1개(상품 = 마커 1개). 발행 시 오프라인 카드로 확장된다. */
export function buildAutoAdMarker(ad: AdItem, slotKind: AdSlot['kind']): string {
  const props: Record<string, string> = { url: ad.url, text: ad.productName };
  if (ad.imageUrl) props.imageUrl = ad.imageUrl;
  const encoded = encodeURIComponent(JSON.stringify(props));
  return `<div data-coupang-widget="product-link" data-ad-source="auto" data-ad-id="${ad.id}" data-ad-slot-kind="${slotKind}" data-widget-props="${encoded}"></div>`;
}

/** 묶음 앞 고정 문구(설계 §3-4) — LLM 문장을 쓰지 않는다. */
export function buildBundleLead(): string {
  return `<p data-ad-source="auto" data-ad-bundle-lead="true">${AD_BUNDLE_LEAD_TEXT}</p>`;
}

function sectionTitle(raw: string): string {
  return cheerio.load(raw)('body').text().replace(/\s+/g, ' ').trim();
}

/**
 * 문서 순서대로 h2 섹션을 모은다(설계 §3-3 규칙 2).
 * h2가 없으면 h3를 쓰고, 둘 다 없으면 빈 배열을 돌려준다(호출부가 본문 끝 묶음으로 처리).
 * 섹션 끝 = 다음 heading 직전 — 마커도 그 자리에 들어간다.
 */
function collectSections(html: string): Section[] {
  let matches = [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)];
  if (matches.length === 0) matches = [...html.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)];
  return matches.map((m, i) => ({
    index: i + 1,
    title: sectionTitle(m[1]),
    start: m.index + m[0].length,
    end: i + 1 < matches.length ? matches[i + 1].index : html.length,
  }));
}

/**
 * 섹션 본문만 잘라낸다 — heading을 감싼 컨테이너가 닫히는 지점까지.
 *
 * 이미지 파이프라인은 섹션 이미지(`figure.section-image`)를 섹션 래퍼 **바깥**에
 * 붙인다. 그대로 두면 "섹션 마지막 블록"이 그 이미지로 잘못 잡혀 멀쩡한 섹션이
 * 후보에서 빠진다. 컨테이너가 닫힌 뒤의 블록은 이 섹션의 블록이 아니다
 * (래퍼가 없는 문서에서는 닫히는 지점이 없으므로 그대로 끝까지 본다).
 */
function sectionContent(html: string, section: Section): string {
  const region = html.slice(section.start, section.end);
  const tagRe = /<(\/?)(?:div|section|article)\b[^>]*>/gi;
  let depth = 0;
  for (const match of region.matchAll(tagRe)) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth < 0) return region.slice(0, match.index);
  }
  return region;
}

/**
 * 섹션의 마지막 블록이 이미지인지 — 이미지 바로 뒤 광고는 금지한다(설계 §3-3 규칙 4).
 * `<figure>` 자체와 "이미지만 담은 문단"을 모두 이미지 블록으로 본다.
 */
function endsWithImage(html: string, section: Section): boolean {
  const region = sectionContent(html, section);
  if (!region.trim()) return false;
  const $ = cheerio.load(region);
  const last = $('body').children().last();
  if (!last.length) return false;
  if (last.is('img,figure')) return true;
  return last.find('img,figure').length > 0 && last.text().trim() === '';
}

function insertAtOffsets(html: string, insertions: Insertion[]): string {
  let out = html;
  for (const item of [...insertions].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, item.offset) + item.html + out.slice(item.offset);
  }
  return out;
}

/** 마지막 섹션 끝(= 문서 끝)에 넣을 때는 바깥 래퍼 안쪽에 붙인다. */
function appendToContentEnd(html: string, snippet: string): string {
  const $ = cheerio.load(html);
  const body = $('body');
  const last = body.children().last();
  if (last.length) last.append(snippet);
  else body.append(snippet);
  return body.html() ?? html;
}

/** 같은 소재를 한 글에 두 번 넣지 않는다(설계 §3-2 규칙 5). */
function uniqueAds(ranked: RankedAd[]): AdItem[] {
  const seen = new Set<string>();
  const ads: AdItem[] = [];
  for (const item of ranked ?? []) {
    if (!item?.ad || seen.has(item.ad.id)) continue;
    seen.add(item.ad.id);
    ads.push(item.ad);
  }
  return ads;
}

/**
 * 섹션 경계 슬롯에 광고를 배치한다(설계 §3-3).
 *
 * `ranked`는 `matchAds`가 점수순으로 돌려준 목록이다. 상위 상품은 단일 광고로,
 * 다음 상품은 묶음(추천 모음)으로 간다.
 */
export function planAdSlots(
  html: string,
  ranked: RankedAd[],
  policy: AdPolicy = DEFAULT_AD_POLICY,
): AdPlacementPlan {
  const notes: string[] = [];
  const base = stripAutoAds(html);
  const ads = uniqueAds(ranked);
  if (ads.length === 0) {
    return { html: base, slots: [], notes: ['소재 없음 — 배치하지 않는다'] };
  }

  const sections = collectSections(base);
  if (sections.length === 0) {
    const bundleAds = ads.slice(0, clamp(ads.length, policy.bundleSize[0], policy.bundleSize[1]));
    notes.push('h2/h3 섹션이 없다 — 본문 끝에 묶음 1개만 둔다');
    const snippet = [
      buildBundleLead(),
      ...bundleAds.map((ad) => buildAutoAdMarker(ad, 'bundle')),
    ].join('');
    return {
      html: appendToContentEnd(base, snippet),
      slots: [
        { kind: 'bundle', afterSection: 0, sectionTitle: '', adIds: bundleAds.map((ad) => ad.id) },
      ],
      notes,
    };
  }

  const n = sections.length;
  const blocks = clamp(Math.floor(n / 3), policy.minBlocks, policy.maxBlocks);

  // 하단 앵커: FAQ 섹션의 **직전 섹션 끝**. FAQ가 없으면 마지막 섹션 끝.
  const faqIndex = sections.findIndex((s) => FAQ_TITLE_RE.test(s.title));
  const anchor = faqIndex > 0 ? faqIndex : n;

  const candidates = sections.filter((section) => {
    if (section.index < policy.firstAfterSection || section.index > anchor - 1) return false;
    if (EXCLUDED_TITLE_RE.test(section.title)) {
      notes.push(`§${section.index} "${section.title}" 제외 — 참고/출처 섹션`);
      return false;
    }
    if (endsWithImage(base, section)) {
      notes.push(`§${section.index} "${section.title}" 제외 — 마지막 블록이 이미지`);
      return false;
    }
    return true;
  });

  // 상품 배분: 단일 광고 수 s + 묶음 1개. 묶음이 최소 수량을 못 채우면 s를 줄여 넘긴다.
  const total = ads.length;
  let singleCount = Math.max(0, blocks - 1);
  while (singleCount > 0 && total - singleCount < policy.bundleSize[0]) singleCount -= 1;
  let bundleCount = Math.min(total - singleCount, policy.bundleSize[1]);
  if (bundleCount < policy.bundleSize[0]) {
    // 그래도 모자라면 남은 상품을 전부 단일 광고로 두고 묶음은 만들지 않는다.
    singleCount = Math.min(total, singleCount + bundleCount);
    bundleCount = 0;
  }

  singleCount = Math.min(singleCount, candidates.length);
  const len = candidates.length;
  const chosen: Section[] = [];
  for (let j = 0; j < singleCount && len > 0; j += 1) {
    const position = clamp(Math.round(((j + 1) * len) / (singleCount + 1)) - 1, 0, len - 1);
    const section = candidates[position];
    if (!chosen.includes(section)) chosen.push(section);
  }

  // 간격 검사: 광고끼리, 그리고 하단 앵커와 minSectionGap 이상 떨어진 단일 광고만 남긴다.
  const accepted: Section[] = [];
  let previous = 0;
  for (const section of [...chosen].sort((a, b) => a.index - b.index)) {
    const distanceFromPrevious =
      previous === 0 ? Number.MAX_SAFE_INTEGER : section.index - previous;
    if (
      distanceFromPrevious < policy.minSectionGap ||
      anchor - section.index < policy.minSectionGap
    ) {
      notes.push(
        `§${section.index} "${section.title}" 제외 — 간격 부족(이전 광고 §${previous || '-'}, 앵커 §${anchor})`,
      );
      continue;
    }
    accepted.push(section);
    previous = section.index;
  }

  const singleAds = ads.slice(0, accepted.length);
  const remaining = ads.slice(accepted.length);
  const bundleAds =
    remaining.length >= policy.bundleSize[0] ? remaining.slice(0, policy.bundleSize[1]) : [];
  if (bundleAds.length === 0 && remaining.length > 0) {
    notes.push(
      `묶음 최소 수량(${policy.bundleSize[0]})에 못 미쳐 ${remaining.length}개 상품은 배치하지 않는다`,
    );
  }
  if (bundleCount > 0 && bundleAds.length < bundleCount) {
    notes.push(`묶음 상품이 ${bundleAds.length}개로 줄었다(간격 제외 반영)`);
  }

  const slots: AdSlot[] = accepted.map((section, i) => ({
    kind: 'single',
    afterSection: section.index,
    sectionTitle: section.title,
    adIds: [singleAds[i].id],
  }));
  const anchorSection = sections[anchor - 1];
  if (bundleAds.length > 0) {
    slots.push({
      kind: 'bundle',
      afterSection: anchor,
      sectionTitle: anchorSection.title,
      adIds: bundleAds.map((ad) => ad.id),
    });
  }

  const insertions: Insertion[] = accepted.map((section, i) => ({
    offset: section.end,
    html: buildAutoAdMarker(singleAds[i], 'single'),
  }));
  if (bundleAds.length > 0) {
    insertions.push({
      offset: anchorSection.end,
      html: [buildBundleLead(), ...bundleAds.map((ad) => buildAutoAdMarker(ad, 'bundle'))].join(''),
    });
  }

  const tail: string[] = [];
  const splices: Insertion[] = [];
  for (const insertion of insertions) {
    if (insertion.offset >= base.length) tail.push(insertion.html);
    else splices.push(insertion);
  }
  let out = insertAtOffsets(base, splices);
  if (tail.length > 0) out = appendToContentEnd(out, tail.join(''));

  return { html: liftWidgetMarkers(out), slots, notes };
}
