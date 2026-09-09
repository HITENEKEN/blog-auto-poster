import * as cheerio from 'cheerio';
import axios from 'axios';
import { getLogger } from '@core/logger';
import { buildProductPreviewCard } from './CoupangPreview';
import { parsePartnersCoupangScript } from './CoupangWidgets';

const logger = getLogger('partners-widget');

/**
 * 쿠팡 파트너스 위젯 → 실제 상품 카드(이슈 #20 T2).
 *
 * 원인 B: 네이버 SmartEditor는 `<iframe>`을 100% 제거한다(2026-09-06 실발행물에서
 * `iframes: expected 1, found 0`). 그래서 dynamic-banner/search-widget/category-banner
 * 를 파트너스 iframe 위젯으로 변환하던 기존 경로는 매 발행마다 무결성 실패를
 * 유발했고, 위젯 자리가 비어 보였다.
 *
 * 해결: iframe 대신 `ads-partners.coupang.com/widgets.html`이 돌려주는 위젯
 * 페이로드(`new PartnersCoupang.Carousel("#container", {...})`)에서 실제 상품
 * 목록을 뽑아, 네이버 발행에서 이미 살아남음이 검증된 인라인 스타일 상품 카드
 * (`buildProductPreviewCard`)로 치환한다. 파트너스 트래킹은 각 아이템의
 * `landingUrl`(lptag/traceid 포함)을 그대로 사용해 보존된다.
 *
 * 파싱은 순수 함수(유닛 테스트 대상), 네트워크는 주입 가능한 fetcher 한 곳에만.
 */

/** 위젯 페이로드에서 뽑아낸 상품 한 건 */
export interface PartnersWidgetItem {
  /** 쿠팡 상품 ID — 없는 아이템은 쿠팡 홈 광고이므로 카드화에서 제외한다 */
  productId?: number;
  name: string;
  /** config.coupangCdnBaseUrl + imagePath 로 조립한 절대 이미지 URL */
  imageUrl: string;
  /** 파트너스 트래킹이 포함된 랜딩 URL(lptag/traceid/subid) */
  landingUrl: string;
  salesPrice?: number;
  discountRate?: number;
}

/** 마커 한 개당 발행할 기본 카드 수 — 위젯 한 자리에 카드가 몰리지 않게 제한한다 */
export const DEFAULT_WIDGET_CARD_LIMIT = 3;

/** ads-partners.coupang.com 위젯 문서 엔드포인트 */
export const PARTNERS_WIDGETS_ENDPOINT = 'https://ads-partners.coupang.com/widgets.html';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 위젯 문서 fetcher — 테스트에서 주입해 네트워크를 끊는다 */
export type WidgetFetcher = (url: string) => Promise<string>;

/** 기본 fetcher(브라우저 UA, 리다이렉트 추적, 10초 타임아웃) */
export const defaultWidgetFetcher: WidgetFetcher = async (url) => {
  const res = await axios.get<string>(url, {
    timeout: 10_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko;q=0.9' },
  });
  return typeof res.data === 'string' ? res.data : '';
};

/**
 * startIdx의 `{`에서 시작해 짝이 맞는 `}`까지의 JSON 문자열을 뽑는다.
 * 위젯 페이로드의 JSON은 items/config/logParams가 중첩되므로 단순한 비탐욕
 * 정규식(`\{[\s\S]*?\}`)으로는 첫 중괄호에서 잘린다. 문자열 리터럴 내부의
 * 중괄호는 무시한다.
 */
function extractBalancedJson(text: string, startIdx: number): string | null {
  if (text[startIdx] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** basePath를 CDN 베이스와 조립해 절대 URL로 만든다(순수). */
function toAbsoluteImageUrl(basePath: string, cdnBaseUrl: string): string {
  const path = (basePath ?? '').trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('//')) return `https:${path}`;
  const base = (cdnBaseUrl ?? '').trim();
  if (!base) return path.startsWith('/') ? path : `/${path}`;
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** 숫자 필드만 통과시킨다(문자열/NaN 방어). */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * 파트너스 위젯 응답 문서에서 상품 목록을 뽑는다. 순수 함수 — 유닛 테스트 대상.
 *
 * `new PartnersCoupang.Carousel("#container", {...})`(및 다른 PartnersCoupang
 * 생성자 호출)의 인자 JSON을 파싱해 items를 PartnersWidgetItem으로 매핑한다.
 * productId가 없는 아이템은 쿠팡 홈/프로모션 광고라 상품 카드화할 수 없어
 * 제외한다. 어떤 실패에서도 던지지 않고 []를 반환한다.
 */
export function parsePartnersWidgetPayload(html: string): PartnersWidgetItem[] {
  if (!html) return [];
  const callMatch = /new\s+PartnersCoupang\.[A-Za-z_]+\s*\(/.exec(html);
  if (!callMatch) return [];

  // 호출 인자 중 첫 객체 리터럴을 찾는다(첫 인자가 "#container" 문자열일 수 있음)
  const openIdx = html.indexOf('{', callMatch.index + callMatch[0].length);
  if (openIdx === -1) return [];
  const jsonText = extractBalancedJson(html, openIdx);
  if (!jsonText) return [];

  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];

  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.items) ? (record.items as unknown[]) : [];
  const config =
    record.config && typeof record.config === 'object' && !Array.isArray(record.config)
      ? (record.config as Record<string, unknown>)
      : {};
  const cdnBaseUrl = typeof config.coupangCdnBaseUrl === 'string' ? config.coupangCdnBaseUrl : '';

  const out: PartnersWidgetItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const productId = toNumber(item.productId);
    // productId가 없으면 쿠팡 홈 배너 광고 — 상품 카드로 만들 수 없어 제외한다.
    if (productId == null) continue;
    const landingUrl = typeof item.landingUrl === 'string' ? item.landingUrl : '';
    const name = typeof item.name === 'string' ? item.name : '';
    const imageUrl = toAbsoluteImageUrl(
      typeof item.imagePath === 'string' ? item.imagePath : '',
      cdnBaseUrl,
    );
    out.push({
      productId,
      name,
      imageUrl,
      landingUrl,
      salesPrice: toNumber(item.salesPrice),
      discountRate: toNumber(item.discountRate),
    });
  }
  return out;
}

/**
 * PartnersCoupang 파라미터를 위젯 문서 URL로 변환한다. 순수 함수 — 유닛 테스트 대상.
 * id/trackingCode가 없으면 null(위젯을 재요청할 수 없다).
 */
export function buildPartnersWidgetUrl(params: Record<string, unknown>): string | null {
  const id = params.id;
  const trackingCode = params.trackingCode;
  if (id == null || String(id).trim() === '') return null;
  if (trackingCode == null || String(trackingCode).trim() === '') return null;

  const usp = new URLSearchParams();
  usp.set('id', String(id));
  usp.set('trackingCode', String(trackingCode));
  const subId = params.subId;
  if (subId != null && String(subId).trim() !== '' && String(subId) !== 'null') {
    usp.set('subId', String(subId));
  }
  const template = params.template;
  if (template != null && String(template).trim() !== '') usp.set('template', String(template));
  const width = params.width;
  const height = params.height;
  if (width != null) usp.set('width', String(width));
  if (height != null) usp.set('height', String(height));

  return `${PARTNERS_WIDGETS_ENDPOINT}?${usp.toString()}`;
}

/**
 * 위젯 파라미터로 실제 상품 목록을 가져온다(이슈 #20 T2).
 *
 * 실패(파라미터 부족/네트워크/파싱) 시 []를 반환한다 — 호출부가 마커를 drop
 * 리포트에 기록하고 발행은 계속 진행한다(발행이 막히지 않는다).
 */
export async function fetchPartnersWidgetItems(
  params: Record<string, unknown>,
  limit: number = DEFAULT_WIDGET_CARD_LIMIT,
  fetcher: WidgetFetcher = defaultWidgetFetcher,
): Promise<PartnersWidgetItem[]> {
  const url = buildPartnersWidgetUrl(params);
  if (!url) {
    logger.warn({ params }, 'Partners widget url not buildable: id/trackingCode missing');
    return [];
  }
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_WIDGET_CARD_LIMIT;

  let body: string;
  try {
    body = await fetcher(url);
  } catch (error) {
    logger.warn({ url, error: String(error) }, 'Partners widget fetch failed');
    return [];
  }

  const items = parsePartnersWidgetPayload(body).slice(0, max);
  if (items.length === 0) {
    logger.warn({ url }, 'Partners widget payload had no product items');
    return [];
  }
  return items;
}

/** 위젯 상품 한 건을 발행용 카드 HTML로 만든다. 순수 함수. */
export function renderWidgetItemCard(item: PartnersWidgetItem): string {
  return buildProductPreviewCard(item.landingUrl, {
    imageUrl: item.imageUrl || undefined,
    title: item.name || undefined,
    price: item.salesPrice,
    discountRate: item.discountRate,
    source: 'api',
  });
}

/**
 * 위젯 파라미터로 상품 카드 HTML 배열을 만든다(이슈 #20 T2).
 * 실패 시 [] — 호출부가 drop 리포트에 기록하고 발행은 계속된다.
 */
export async function fetchPartnersWidgetCards(
  params: Record<string, unknown>,
  limit: number = DEFAULT_WIDGET_CARD_LIMIT,
  fetcher: WidgetFetcher = defaultWidgetFetcher,
): Promise<string[]> {
  const items = await fetchPartnersWidgetItems(params, limit, fetcher);
  return items.map((item) => renderWidgetItemCard(item));
}

/** 카드 묶음으로 치환할 임베드 위젯 종류 */
const EMBED_WIDGET_KINDS = new Set(['dynamic-banner', 'search-widget', 'category-banner']);

/**
 * 본문 속 임베드 위젯 마커를 순회해 각 마커에 발행할 상품 카드 묶음을 미리
 * 수집한다(이슈 #20 T4). `fetchLinkPreviewCards`(이슈 #12)와 동일한 규약을 따른다:
 *
 *  - 키 = `[data-coupang-widget]` 마커의 **문서 순서 인덱스**(전체 마커 기준,
 *    종류별 인덱스가 아님) — `expandCoupangWidgets`의 `each((index, el))`와 일치한다.
 *  - 값 = 카드 HTML 묶음(마커 하나를 통째로 치환한다).
 *  - 파라미터를 만들 수 없거나 카드가 0장이면 해당 인덱스를 비운다 →
 *    호출부(expandCoupangWidgets)가 drop 리포트에 기록하고 마커를 제거한다.
 *
 * 마커별 네트워크 실패는 서로 격리된다(한 위젯이 죽어도 나머지는 발행된다).
 */
export async function collectWidgetCards(
  html: string,
  limit: number = DEFAULT_WIDGET_CARD_LIMIT,
  fetcher: WidgetFetcher = defaultWidgetFetcher,
): Promise<Map<number, string>> {
  return (await collectWidgetCardsReport(html, limit, fetcher)).cards;
}

/** 마커 한 자리에 실제로 실릴 상품 목록 — 발행 전에 사용자에게 보여준다. */
export interface WidgetCardPlacement {
  /** 마커의 문서 순서 인덱스 */
  index: number;
  kind: string;
  /** 이 자리에 발행될 상품명 */
  names: string[];
}

export interface CollectWidgetCardsReport {
  cards: Map<number, string>;
  placements: WidgetCardPlacement[];
}

/**
 * `collectWidgetCards`와 같은 수집을 하되, 각 마커 자리에 실제로 실릴 **상품명**까지
 * 돌려준다.
 *
 * 다이나믹 배너(`PartnersCoupang` 위젯)는 방문자 문맥이 있어야 관련 상품을 내놓는다.
 * 서버에서 조회하면 문맥이 없어 일반 베스트셀러가 나온다(2026-09-08 실측:
 * 청바지 리뷰에 쌀·화장지·복사용지가 실렸다). 상품을 바꿀 수는 없으므로, 최소한
 * **무엇이 실리는지 발행 전에 보이게** 한다.
 */
export async function collectWidgetCardsReport(
  html: string,
  limit: number = DEFAULT_WIDGET_CARD_LIMIT,
  fetcher: WidgetFetcher = defaultWidgetFetcher,
): Promise<CollectWidgetCardsReport> {
  const cards = new Map<number, string>();
  const placements: WidgetCardPlacement[] = [];
  if (!html || !html.includes('data-coupang-widget')) return { cards, placements };

  const $ = cheerio.load(html);
  const markers = $('[data-coupang-widget]').toArray();
  for (let i = 0; i < markers.length; i += 1) {
    const el = markers[i];
    const kind = $(el).attr('data-coupang-widget') ?? '';
    if (!EMBED_WIDGET_KINDS.has(kind)) continue;

    let props: Record<string, unknown>;
    try {
      const raw = decodeURIComponent($(el).attr('data-widget-props') || '');
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      props = parsed as Record<string, unknown>;
    } catch {
      continue; // props가 깨진 마커는 expand 단계가 drop으로 기록한다
    }

    const snippet = typeof props.snippet === 'string' ? props.snippet : '';
    const params = parsePartnersCoupangScript(snippet);
    if (!params) continue; // 카드를 만들 위젯 파라미터가 없다(비-파트너스 스니펫 등)

    try {
      const items = await fetchPartnersWidgetItems(params, limit, fetcher);
      if (items.length === 0) continue;
      cards.set(i, items.map((item) => renderWidgetItemCard(item)).join(''));
      placements.push({ index: i, kind, names: items.map((item) => item.name).filter(Boolean) });
    } catch (error) {
      // 마커별 격리 — 나머지 위젯 수집은 계속한다
      logger.warn({ index: i, kind, error: String(error) }, 'Widget card collection failed');
    }
  }
  return { cards, placements };
}
