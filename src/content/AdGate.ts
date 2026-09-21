import * as cheerio from 'cheerio';
import { countDisclosures, isDisclosureText } from './Disclosure';
import { matchAds } from './AdMatcher';
import { PLACEHOLDER_RE, STUB_TEXT_RE } from '../platforms/naver/PublishedPostInspector';
import {
  AD_TEXT_CODES,
  findForbiddenTextRule,
  forbiddenTextRules,
  type ForbiddenTextRule,
} from './ForbiddenText';
import {
  AD_BUNDLE_LEAD_TEXT,
  DEFAULT_AD_POLICY,
  type AdItem,
  type AdSlot,
  type AdTopic,
  type GateViolation,
} from './AdTypes';

/**
 * 발행 전 광고 게이트 (설계 §3-5·§3-6).
 *
 * 위반이 하나라도 있으면 로봇은 발행하지 않는다. 구조 검사는 순수하고,
 * 링크 생존 검사만 fetcher를 주입받는다(유닛 테스트는 실제 네트워크를 쓰지 않는다).
 */

/** 마커가 갇히면 SmartEditor가 앞 요소의 캡션으로 흡수한다(SmartEditor 실측 #17). */
const MARKER_TRAP_TAGS = 'figure,figcaption,p,li,ul,ol,blockquote,table';

/** 통과 가능한 파트너스 링크 접두사 — 그 외 호스트는 광고로 내보내지 않는다. */
const ALLOWED_AD_URL_PREFIXES = [
  'https://link.coupang.com/a/',
  'https://www.coupang.com/vp/products/',
];

export interface AdGateExpectation {
  /** 계획한 슬롯(place-ads 결과) — 블록 수 판정 기준 */
  slots: AdSlot[];
  /** 계획에 쓴 인벤토리 — AD_UNKNOWN_ID 판정 */
  inventory: AdItem[];
  /** 주제 — 주면 관련성(AD_IRRELEVANT)까지 검사한다 */
  topic?: AdTopic;
  /** 금지 문구 스코프 오버라이드(기본: AD_TEXT_CODES — 광고 문구·상품명) */
  forbiddenCodes?: ReadonlyArray<string>;
  /**
   * 자체 RegExp[] 오버라이드. 기본은 공용 표(`ForbiddenText.ts`)의 AD_TEXT_CODES 규칙이다.
   * 넘기면 코드 대신 `CUSTOM_n`으로 보고한다.
   */
  forbiddenPatterns?: RegExp[];
}

interface AutoAd {
  id: string;
  kind: string;
  slotKind: string;
  url: string;
  imageUrl: string;
  text: string;
  /** 자동 문구에 포함되는 텍스트(상품명 포함) */
  element: cheerio.Element;
}

function decodeProps(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** 자동 배치 마커(사용자 위젯 제외)를 문서 순서로 뽑는다. */
function collectAutoAds($: cheerio.Root): AutoAd[] {
  return $('[data-coupang-widget][data-ad-source="auto"]')
    .toArray()
    .filter((el) => $(el).attr('data-coupang-widget') === 'product-link')
    .map((el) => {
      const node = $(el);
      const props = decodeProps(node.attr('data-widget-props'));
      return {
        id: node.attr('data-ad-id') ?? '',
        kind: node.attr('data-coupang-widget') ?? '',
        slotKind: node.attr('data-ad-slot-kind') ?? '',
        url: props.url ?? '',
        imageUrl: props.imageUrl ?? '',
        text: props.text ?? '',
        element: el,
      };
    });
}

/** 광고 블록 — 묶음 슬롯의 연속 마커는 블록 1개다. */
interface AdBlock {
  kind: 'single' | 'bundle';
  ids: string[];
}

/**
 * 마커를 광고 블록으로 묶는다 — 묶음 슬롯의 연속 마커는 블록 1개다.
 * (설계 §3-6 AD_COUNT: "자동 광고 블록 수")
 */
function groupAdBlocks(ads: AutoAd[]): AdBlock[] {
  const blocks: AdBlock[] = [];
  let previousKind = '';
  for (const ad of ads) {
    const kind: AdBlock['kind'] = ad.slotKind === 'bundle' ? 'bundle' : 'single';
    if (kind === 'bundle' && previousKind === 'bundle') blocks[blocks.length - 1].ids.push(ad.id);
    else blocks.push({ kind, ids: [ad.id] });
    previousKind = ad.slotKind;
  }
  return blocks;
}

/** 초안에 배치된 자동 광고 id를 문서 순서로 돌려준다(로봇·게이트가 같은 목록을 본다). */
export function collectPlacedAdIds(html: string): string[] {
  return groupAdBlocks(collectAutoAds(cheerio.load(html ?? ''))).flatMap((block) => block.ids);
}

/**
 * 초안 마커에서 슬롯 구성을 도출한다 — 계획(place-ads 응답) 없이 게이트를 돌릴 때의
 * 대조 기준이다. `afterSection`/`sectionTitle`은 마커에 남아 있지 않으므로 비운다
 * (게이트의 AD_COUNT는 블록 수만 본다).
 */
export function deriveAdSlots(html: string): AdSlot[] {
  return groupAdBlocks(collectAutoAds(cheerio.load(html ?? ''))).map((block) => ({
    kind: block.kind,
    afterSection: 0,
    sectionTitle: '',
    adIds: block.ids,
  }));
}

/** 같은 부모 안에서 몇 번째 블록인가(1-based) — 고지 위치 판정용. */
function blockPosition($: cheerio.Root, el: cheerio.Element): number {
  return $(el).prevAll().length + 1;
}

/**
 * 발행 전 구조 게이트 (설계 §3-6). 순수 함수 — 유닛 테스트 대상.
 *
 * `html`은 배치가 끝난 초안본(post.html)이다. 위반 목록이 비면 통과다.
 */
export function checkAdGate(html: string, expected: AdGateExpectation): GateViolation[] {
  const policy = DEFAULT_AD_POLICY;
  const violations: GateViolation[] = [];
  const $ = cheerio.load(html ?? '');
  const ads = collectAutoAds($);
  const blocks = groupAdBlocks(ads).length;
  const plannedBlocks = expected.slots?.length ?? 0;

  // AD_COUNT — 계획한 블록 수와 실제 블록 수, 최소 상품 수
  if (blocks !== plannedBlocks) {
    violations.push({
      code: 'AD_COUNT',
      message: `자동 광고 블록 수가 계획과 다르다(실제 ${blocks}, 계획 ${plannedBlocks})`,
      detail: { blocks, plannedBlocks },
    });
  }
  if (ads.length > 0 && ads.length < policy.minAds) {
    violations.push({
      code: 'AD_COUNT',
      message: `상품 수가 최소 기준(${policy.minAds})에 못 미친다: ${ads.length}개`,
      detail: { adCount: ads.length, minAds: policy.minAds },
    });
  }

  // DISCLOSURE_COUNT — 광고 ≥ 1 ⇔ 고지 정확히 1회
  const disclosures = countDisclosures(html ?? '');
  if (ads.length > 0 && disclosures !== 1) {
    violations.push({
      code: 'DISCLOSURE_COUNT',
      message: `광고가 있는데 파트너스 고지가 ${disclosures}회다(정확히 1회여야 한다)`,
      detail: { disclosures, adCount: ads.length },
    });
  }
  if (ads.length === 0 && disclosures > 0) {
    violations.push({
      code: 'DISCLOSURE_COUNT',
      message: `광고가 없는데 파트너스 고지가 ${disclosures}회 있다`,
      detail: { disclosures },
    });
  }

  // DISCLOSURE_POSITION — 첫 3개 블록 이내
  const disclosureEl = $('[data-ad-disclosure="true"]').first();
  const disclosureSource: cheerio.Cheerio | null = disclosureEl.length
    ? disclosureEl
    : $('body *')
        .filter((_, el) => isDisclosureText($(el).text()))
        .first();
  if (disclosureSource && disclosureSource.length > 0) {
    const position = blockPosition($, disclosureSource.get(0));
    if (position > 3) {
      violations.push({
        code: 'DISCLOSURE_POSITION',
        message: `고지가 본문 앞 3개 블록을 벗어났다(위치 ${position})`,
        detail: { position },
      });
    }
  }

  const inventoryById = new Map((expected.inventory ?? []).map((ad) => [ad.id, ad]));
  const relevantIds = expected.topic
    ? new Set(matchAds(expected.topic, expected.inventory ?? []).map((ranked) => ranked.ad.id))
    : null;
  // 금지 문구 표는 `ForbiddenText.ts` 하나다(설계 §5-4). 광고 문구·상품명에는
  // 판매자가 지은 값이 들어가므로 AD_TEXT_CODES 스코프(가격 단정 제외)를 기본으로 쓴다.
  const forbiddenRules: ReadonlyArray<ForbiddenTextRule> = expected.forbiddenPatterns
    ? expected.forbiddenPatterns.map((re, index) => ({ code: `CUSTOM_${index + 1}`, re }))
    : forbiddenTextRules(expected.forbiddenCodes ?? AD_TEXT_CODES);

  for (const ad of ads) {
    // AD_IN_TRAP — 마커가 접히는 컨테이너 안에 있으면 캡션으로 흡수된다
    if ($(ad.element).parents(MARKER_TRAP_TAGS).length > 0) {
      violations.push({
        code: 'AD_IN_TRAP',
        message: `광고 마커가 ${MARKER_TRAP_TAGS} 안에 있다: ${ad.id || '(id 없음)'}`,
        detail: { adId: ad.id },
      });
    }

    // AD_AFTER_IMAGE — 바로 앞 형제가 이미지면 금지
    const previous = $(ad.element).prev();
    if (
      previous.length > 0 &&
      (previous.is('img,figure') || previous.find('img,figure').length > 0)
    ) {
      violations.push({
        code: 'AD_AFTER_IMAGE',
        message: `광고 블록 바로 앞에 이미지가 있다: ${ad.id || '(id 없음)'}`,
        detail: { adId: ad.id },
      });
    }

    // AD_URL_HOST — 파트너스 링크 형식만 허용
    if (!ALLOWED_AD_URL_PREFIXES.some((prefix) => ad.url.startsWith(prefix))) {
      violations.push({
        code: 'AD_URL_HOST',
        message: `광고 URL이 허용 형식이 아니다: ${ad.url || '(url 없음)'}`,
        detail: { adId: ad.id, url: ad.url },
      });
    }

    // AD_IMAGE_URL — 이미지는 https만
    if (ad.imageUrl && !ad.imageUrl.startsWith('https://')) {
      violations.push({
        code: 'AD_IMAGE_URL',
        message: `광고 이미지 URL이 https가 아니다: ${ad.imageUrl}`,
        detail: { adId: ad.id, imageUrl: ad.imageUrl },
      });
    }

    // AD_UNKNOWN_ID — 인벤토리에 없거나 active가 아닌 소재
    const inventoryItem = inventoryById.get(ad.id);
    if (!inventoryItem || inventoryItem.status !== 'active') {
      violations.push({
        code: 'AD_UNKNOWN_ID',
        message: `인벤토리에 없거나 active가 아닌 소재다: ${ad.id || '(id 없음)'}`,
        detail: { adId: ad.id, status: inventoryItem?.status ?? null },
      });
    }

    // AD_IRRELEVANT — 주제 매칭 결과에 없는 소재(설계 §3-5 관련성)
    if (relevantIds && !relevantIds.has(ad.id)) {
      violations.push({
        code: 'AD_IRRELEVANT',
        message: `주제와 관련성이 확인되지 않은 소재다: ${ad.id}`,
        detail: { adId: ad.id },
      });
    }

    // FORBIDDEN_TEXT — 자동 문구에 1인칭 체험·스텁·자리표시자(스코프 밖 규칙은 제외)
    const matchedRule = findForbiddenTextRule(`${ad.text} ${AD_BUNDLE_LEAD_TEXT}`, forbiddenRules);
    if (matchedRule) {
      violations.push({
        code: 'FORBIDDEN_TEXT',
        message: `자동 광고 문구에 금지 표현이 있다(${matchedRule.code}): ${ad.text}`,
        detail: { adId: ad.id, rule: matchedRule.code },
      });
    }
  }

  // AD_ADJACENT — 블록 사이에 h2/h3가 없으면 연속 광고로 본다(묶음 내부는 예외)
  const sequence = $('body').find('h2,h3,[data-coupang-widget][data-ad-source="auto"]').toArray();
  let lastBlockSeen: cheerio.Element | null = null;
  let lastBlockSlotKind = '';
  let headingSinceLastBlock = false;
  for (const node of sequence) {
    const isMarker = $(node).attr('data-ad-source') === 'auto';
    if (!isMarker) {
      headingSinceLastBlock = true;
      continue;
    }
    const slotKind = $(node).attr('data-ad-slot-kind') ?? '';
    const continuesBundle =
      lastBlockSeen !== null && slotKind === 'bundle' && lastBlockSlotKind === 'bundle';
    if (!continuesBundle) {
      if (lastBlockSeen !== null && !headingSinceLastBlock) {
        violations.push({
          code: 'AD_ADJACENT',
          message: '연속된 광고 블록 사이에 섹션 제목이 없다',
          detail: { adId: $(node).attr('data-ad-id') ?? '' },
        });
      }
      lastBlockSeen = node;
      lastBlockSlotKind = slotKind;
      headingSinceLastBlock = false;
    }
  }

  // LEFTOVER_MARKER — 채우지 못한 템플릿 슬롯, iframe/script 잔존
  if (/data-ad-slot\s*=/.test(html ?? '')) {
    violations.push({
      code: 'LEFTOVER_MARKER',
      message: '확장되지 않은 템플릿 광고 슬롯(data-ad-slot)이 남아 있다',
    });
  }
  if (/<iframe\b/i.test(html ?? '')) {
    violations.push({ code: 'LEFTOVER_MARKER', message: '<iframe>이 남아 있다' });
  }
  if (/<script\b/i.test(html ?? '')) {
    violations.push({ code: 'LEFTOVER_MARKER', message: '<script>가 남아 있다' });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 발행 전 구조 검사 (런북 백로그 ④) — 발행 후에만 돌던 점검을 직전으로 승격한다.
// 검사 대상은 확장이 끝난 발행 HTML(자동 광고 카드·스타일·평탄화 적용 후)이다.
// ---------------------------------------------------------------------------

/**
 * 확장된 발행 HTML의 구조를 검사한다(설계 §3-6 LEFTOVER_MARKER + 스킬 S10).
 *
 * `PLACEHOLDER_RE`/`STUB_TEXT_RE`는 발행물 검사기(`PublishedPostInspector`)의
 * 상수를 그대로 쓴다 — 발행 전후가 같은 패턴을 봐야 규칙이 갈라지지 않는다.
 */
export function checkPublishStructure(html: string): GateViolation[] {
  const violations: GateViolation[] = [];
  const source = html ?? '';

  const placeholders = (source.match(PLACEHOLDER_RE) ?? []).length;
  if (placeholders > 0) {
    violations.push({
      code: 'STRUCTURE_PLACEHOLDER',
      message: `본문 이미지 플레이스홀더가 남아 있다: ${placeholders}회`,
      detail: { placeholders },
    });
  }

  const stubs = (source.match(STUB_TEXT_RE) ?? []).length;
  if (stubs > 0) {
    violations.push({
      code: 'STRUCTURE_STUB',
      message: `미구현 스텁 문구가 남아 있다: ${stubs}회`,
      detail: { stubs },
    });
  }

  const markers = (source.match(/data-coupang-widget/g) ?? []).length;
  if (markers > 0) {
    violations.push({
      code: 'STRUCTURE_MARKER',
      message: `확장되지 않은 위젯 마커가 남아 있다: ${markers}개`,
      detail: { markers },
    });
  }

  if (/<iframe\b/i.test(source) || /<script\b/i.test(source)) {
    violations.push({
      code: 'STRUCTURE_EMBED',
      message: 'iframe/script가 남아 있다 — 네이버는 실행하지 못하고 iframe은 제거한다',
    });
  }

  return violations;
}

// ---------------------------------------------------------------------------
// 링크 생존 검사 — 네트워크는 fetcher 주입으로만 쓴다(설계 §3-7).
// ---------------------------------------------------------------------------

export interface AdLinkResponse {
  /** redirect: 'manual' 응답의 상태 코드 */
  status: number;
  /** 3xx일 때의 Location 헤더 */
  location?: string | null;
  error?: string;
}

export type AdLinkFetcher = (url: string) => Promise<AdLinkResponse>;

export interface AdLinkCheck {
  id: string;
  url: string;
  ok: boolean;
  status: number | null;
  location: string | null;
  reason?: string;
}

/** 쿠팡 호스트인지 — `coupang.com`과 그 서브도메인만 인정한다. */
export function isCoupangHost(location: string): boolean {
  try {
    const host = new URL(location).hostname.toLowerCase();
    return host === 'coupang.com' || host.endsWith('.coupang.com');
  } catch {
    return false;
  }
}

/**
 * 광고 링크 생존 검사 (설계 §3-7). 광고 1개당 요청 1회, **첫 리다이렉트만** 본다.
 *
 * fetcher는 `redirect: 'manual'`로 호출해야 한다(3xx를 그대로 돌려준다).
 * 상품 페이지까지 따라가지 않는다 — 이 요청이 파트너스 클릭으로 집계될 수 있어
 * 반복 호출하지 않는다.
 */
export async function checkAdLinks(ads: AdItem[], fetcher: AdLinkFetcher): Promise<AdLinkCheck[]> {
  const results: AdLinkCheck[] = [];
  for (const ad of ads ?? []) {
    try {
      const response = await fetcher(ad.url);
      const location = response.location ?? null;
      if (response.status >= 300 && response.status < 400 && location && isCoupangHost(location)) {
        results.push({ id: ad.id, url: ad.url, ok: true, status: response.status, location });
        continue;
      }
      results.push({
        id: ad.id,
        url: ad.url,
        ok: false,
        status: response.status,
        location,
        reason:
          response.status >= 400
            ? `HTTP ${response.status}`
            : location
              ? `쿠팡 밖으로 리다이렉트: ${location}`
              : `리다이렉트가 없거나 Location이 비었다(HTTP ${response.status})`,
      });
    } catch (error) {
      results.push({
        id: ad.id,
        url: ad.url,
        ok: false,
        status: null,
        location: null,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
