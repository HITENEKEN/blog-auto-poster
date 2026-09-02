import * as cheerio from 'cheerio';
import axios from 'axios';
import { getLogger } from '@core/logger';
import type { AffiliateAdapter } from '@core/interfaces';

const logger = getLogger('coupang-preview');

/**
 * 쿠팡 링크 미리보기(이슈 #12).
 *
 * 발행 시점에 product-link/event-link 마커의 URL을 읽어 실제 상품 정보(이미지·
 * 가격·평점 등)를 담은 광고 카드 HTML로 치환한다. 단순 텍스트 링크만 발행되던
 * 문제를 해결한다.
 *
 * 데이터 획득 우선순위:
 *  1. link.coupang.com 단축 링크 리다이렉트 해석 → productId → 파트너스 OpenAPI
 *     getProductDetails(CoupangAdapter, 1시간 캐시)
 *  2. OG 메타(og:title/og:image) 스캔 폴백
 *  3. 모두 실패 → null (기존 텍스트 링크로 발행 — 발행이 막히지 않게 한다)
 *
 * HTML 생성은 순수 함수(인라인 스타일만 사용 — 네이버 SE에서 살아남는다).
 */

export interface WidgetPreviewData {
  imageUrl?: string;
  title?: string;
  price?: number;
  originalPrice?: number;
  discountRate?: number;
  rating?: number;
  reviewCount?: number;
  /** 데이터 출처 — 'none'이면 카드를 만들 수 없어 기존 링크로 폴백한다 */
  source: 'api' | 'og' | 'none';
}

export interface HttpFetchResult {
  status: number;
  location?: string;
  body?: string;
}

export type HttpFetcher = (url: string) => Promise<HttpFetchResult>;

export type ProductDetailsFetcher = NonNullable<
  Pick<AffiliateAdapter, 'getProductDetails'>
>['getProductDetails'];

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 기본 fetcher — 리다이렉트 추적용(30x의 Location 헤더와 200의 본문을 함께 반환) */
export const defaultHttpFetcher: HttpFetcher = async (url) => {
  const res = await axios.get<string>(url, {
    maxRedirects: 0,
    timeout: 10_000,
    validateStatus: () => true,
    headers: { 'User-Agent': USER_AGENT },
  });
  return {
    status: res.status,
    location: (res.headers?.location as string | undefined) ?? undefined,
    body: typeof res.data === 'string' ? res.data : undefined,
  };
};

/** 쿠팡 상품 URL에서 productId를 추출한다. 순수 함수 — 유닛 테스트 대상. */
export function extractProductIdFromProductUrl(url: string): string | null {
  const m = /coupang\.com\/(?:vp\/)?products\/(\d+)/.exec(url || '');
  return m ? m[1] : null;
}

/**
 * 단축 링크를 최종 URL로 해석한다. 30x Location, meta refresh, JS location,
 * canonical/og:url 순으로 추적한다. 순수 로직(fetcher 주입) — 유닛 테스트 대상.
 */
export async function resolveShortLink(
  url: string,
  fetcher: HttpFetcher = defaultHttpFetcher,
  maxHops: number = 5,
): Promise<string> {
  let current = url;
  for (let i = 0; i < maxHops; i++) {
    if (/coupang\.com\/(?:vp\/)?products\/\d+/.test(current)) return current;
    const res = await fetcher(current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString();
      continue;
    }
    if (res.body) {
      const meta =
        /<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>]+)/i.exec(
          res.body,
        )?.[1];
      const js = /location\.(?:replace|href)\s*=?\s*["']([^"']+)["']/i.exec(res.body)?.[1];
      const canonical = /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(
        res.body,
      )?.[1];
      const og = /<meta[^>]+property=["']og:url["'][^>]+content=["']([^"']+)["']/i.exec(
        res.body,
      )?.[1];
      const next = meta ?? js ?? canonical ?? og;
      if (next) {
        const abs = new URL(next, current).toString();
        if (abs !== current) {
          current = abs;
          continue;
        }
      }
    }
    return current;
  }
  return current;
}

/** OG 메타 스캔 폴백(이벤트 링크/상품 API 실패 시) */
async function fetchOgMetadata(
  url: string,
  fetcher: HttpFetcher = defaultHttpFetcher,
): Promise<WidgetPreviewData> {
  let current = url;
  let body = '';
  for (let hop = 0; hop < 3; hop++) {
    const res = await fetcher(current);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString();
      continue;
    }
    body = res.body ?? '';
    break;
  }
  const pick = (prop: string): string | undefined =>
    new RegExp(
      `<meta[^>]+(?:property=["']${prop}["']|name=["']${prop}["'])[^>]+content=["']([^"']*)["']`,
      'i',
    ).exec(body)?.[1];
  const title = pick('og:title');
  const imageUrl = pick('og:image');
  if (!title && !imageUrl) return { source: 'none' };
  return { title, imageUrl, source: 'og' };
}

/** URL 하나에 대한 미리보기 데이터를 수집한다(API → OG → none 폴백) */
export async function fetchWidgetPreviewData(
  url: string,
  adapter?: { getProductDetails: ProductDetailsFetcher } | null,
  fetcher: HttpFetcher = defaultHttpFetcher,
): Promise<WidgetPreviewData> {
  try {
    const finalUrl = await resolveShortLink(url, fetcher);
    const productId = extractProductIdFromProductUrl(finalUrl);
    if (adapter && productId) {
      const product = await adapter.getProductDetails(productId);
      if (product) {
        return {
          imageUrl: product.imageUrl,
          title: product.name,
          price: product.price,
          originalPrice: product.originalPrice,
          discountRate: product.discountRate,
          rating: product.rating,
          reviewCount: product.reviewCount,
          source: 'api',
        };
      }
    }
  } catch (error) {
    logger.warn({ url, error: String(error) }, 'Coupang product preview via API failed; trying OG');
  }
  try {
    const og = await fetchOgMetadata(url, fetcher);
    if (og.source !== 'none') return og;
  } catch (error) {
    logger.warn({ url, error: String(error) }, 'Coupang OG preview fetch failed');
  }
  return { source: 'none' };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatKrw(price: number): string {
  return `${price.toLocaleString('ko-KR')}원`;
}

/** 상품 미리보기 카드 HTML(순수, 인라인 스타일) — 유닛 테스트 대상. */
export function buildProductPreviewCard(
  url: string,
  data: WidgetPreviewData,
  fallbackText?: string,
): string {
  const title = escapeHtml(data.title || fallbackText || '쿠팡 상품');
  const img = data.imageUrl
    ? `<img src="${escapeHtml(data.imageUrl)}" alt="${title}" style="width:110px;height:110px;object-fit:cover;flex:none;border-radius:8px" />`
    : `<span style="width:110px;height:110px;flex:none;display:flex;align-items:center;justify-content:center;background:#fff0f6;border-radius:8px;font-size:34px">🛍️</span>`;
  const priceLine =
    typeof data.price === 'number' && data.price > 0
      ? `<span style="font-size:15px;color:#212529"><b>${formatKrw(data.price)}</b>${
          data.originalPrice && data.originalPrice > data.price
            ? ` <s style="color:#adb5bd;font-size:12px">${formatKrw(data.originalPrice)}</s>`
            : ''
        }${
          data.discountRate
            ? ` <span style="color:#e8590c;font-weight:700">${data.discountRate}%↓</span>`
            : ''
        }</span>`
      : '';
  const metaLine =
    data.rating || data.reviewCount
      ? `<span style="font-size:12px;color:#868e96">⭐ ${data.rating ?? '-'}${
          data.reviewCount ? ` (${data.reviewCount.toLocaleString('ko-KR')}개 리뷰)` : ''
        }</span>`
      : '';
  return `<div style="max-width:640px;margin:24px auto;border:1px solid #e9ecef;border-radius:12px;background:#fff;box-shadow:0 3px 12px rgba(0,0,0,.08);overflow:hidden"><a href="${escapeHtml(
    url,
  )}" target="_blank" rel="nofollow sponsored" style="text-decoration:none;color:inherit"><div style="display:flex;align-items:center;gap:14px;padding:14px 16px">${img}<div style="display:flex;flex-direction:column;gap:6px;min-width:0"><span style="font-size:15px;font-weight:700;color:#212529;line-height:1.5">${title}</span>${priceLine}${metaLine}<span style="display:inline-block;background:linear-gradient(135deg,#e64980,#f76707);color:#fff;font-size:13px;font-weight:700;padding:8px 18px;border-radius:20px;margin-top:2px">🛒 쿠팡에서 보기</span></div></div></a><div style="border-top:1px solid #f1f3f5;padding:6px 16px;font-size:11px;color:#adb5bd;text-align:right">이 포스팅은 쿠팡 파트너스 링크를 포함합니다</div></div>`;
}

/** 이벤트/프로모션 미리보기 카드 HTML(순수, 인라인 스타일) — 유닛 테스트 대상. */
export function buildEventPreviewCard(
  url: string,
  data: WidgetPreviewData,
  fallbackText?: string,
): string {
  const title = escapeHtml(data.title || fallbackText || '쿠팡 이벤트 · 프로모션');
  const img = data.imageUrl
    ? `<img src="${escapeHtml(data.imageUrl)}" alt="${title}" style="max-width:100%;width:100%;border-radius:8px 8px 0 0;display:block" />`
    : '';
  return `<div style="max-width:640px;margin:24px auto;border:1px solid #ffd8a8;border-radius:12px;background:#fff4e6;box-shadow:0 3px 12px rgba(232,89,12,.12);overflow:hidden;text-align:center"><a href="${escapeHtml(
    url,
  )}" target="_blank" rel="nofollow sponsored" style="text-decoration:none;color:inherit">${img}<div style="padding:16px 18px"><span style="display:inline-block;background:#e8590c;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px">EVENT</span><div style="font-size:15px;font-weight:700;color:#212529;margin-top:8px;line-height:1.5">🎉 ${title}</div><span style="display:inline-block;background:linear-gradient(135deg,#e8590c,#f76707);color:#fff;font-size:13px;font-weight:700;padding:8px 22px;border-radius:20px;margin-top:10px">이벤트 확인하기</span></div></a></div>`;
}

/**
 * 본문의 product-link/event-link 마커에 대해 미리보기 카드 HTML을 사전 수집한다.
 * 키는 마커의 문서 순서 인덱스(expandCoupangWidgets의 previewCards와 짝을 이룬다).
 * 카드를 만들 수 없는 마커는 맵에서 생략(기존 텍스트 링크 폴백).
 */
export async function fetchLinkPreviewCards(
  html: string,
  adapter?: { getProductDetails: ProductDetailsFetcher } | null,
  fetcher: HttpFetcher = defaultHttpFetcher,
): Promise<Map<number, string>> {
  const cards = new Map<number, string>();
  if (!html || !html.includes('data-coupang-widget')) return cards;
  const $ = cheerio.load(html);
  const markers = $('[data-coupang-widget]').toArray();
  for (let i = 0; i < markers.length; i++) {
    const el = markers[i];
    const kind = $(el).attr('data-coupang-widget');
    if (kind !== 'product-link' && kind !== 'event-link') continue;
    let url = '';
    try {
      const props = JSON.parse(decodeURIComponent($(el).attr('data-widget-props') || '')) as {
        url?: string;
        text?: string;
      };
      url = props.url ?? '';
      if (!url) continue;
      const data = await fetchWidgetPreviewData(url, adapter, fetcher);
      if (data.source === 'none') {
        // 이벤트 링크는 데이터 수집에 실패해도 기본 타이틀의 스타일 카드로
        // 발행한다(단순 텍스트 링크보다 눈에 띈다). 상품 링크는 텍스트 링크 폴백.
        if (kind !== 'event-link') continue;
        cards.set(i, buildEventPreviewCard(url, { source: 'none' }, props.text));
        continue;
      }
      const card =
        kind === 'event-link'
          ? buildEventPreviewCard(url, data, props.text)
          : buildProductPreviewCard(url, data, props.text);
      cards.set(i, card);
    } catch (error) {
      logger.warn({ url, error: String(error) }, 'Link preview card build failed');
    }
  }
  return cards;
}

/**
 * 발행 시점 위젯/이미지 스타일 정리(이슈 #12 — 전 위젯 최종 스타일 다듬기).
 * 모든 img에 반응형(max-width:100%) 인라인 스타일을 보장한다.
 * 순수 함수 — 유닛 테스트 대상.
 */
export function stylePublishHtml(html: string): string {
  if (!html) return html;
  const $ = cheerio.load(html);
  $('img').each((_, el) => {
    const node = $(el);
    const existing = (node.attr('style') || '').trim();
    if (/max-width\s*:/i.test(existing)) return;
    node.attr(
      'style',
      existing ? `${existing}; max-width: 100%; height: auto` : 'max-width: 100%; height: auto',
    );
  });
  return $('body').html() ?? '';
}
