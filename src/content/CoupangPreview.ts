import * as cheerio from 'cheerio';
import axios from 'axios';
import { getLogger } from '@core/logger';
import type { AffiliateAdapter } from '@core/interfaces';
import { normalizeLinkWidgetProps } from './CoupangWidgets';

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

/**
 * 카드 마크업 규칙 (2026-09-07 실발행물 logNo 224400196736/224404059950에서 실측)
 *
 * SmartEditor ONE은 붙여넣은 HTML을 자기 모듈 모델로 접어 넣는다. 그 과정에서:
 *  - `<a href="http…"><img></a>` → `se-image` + 이미지 링크(`data-linkdata.link`,
 *    `linkUse:true`)로 **보존된다**.
 *  - `<p><a href="http…">텍스트</a></p>` → `se-link` 텍스트 링크로 **보존된다**.
 *  - 그러나 하나의 `<a>`가 이미지와 텍스트를 **함께** 감싸면, SE는 그 앵커를
 *    이미지 링크로만 승격시키고 나머지 텍스트를 캡션으로 강등하면서
 *    **텍스트 쪽 링크를 전부 버린다**(실측: 카드 3장에 `<a>` 0개, "🛒 쿠팡에서
 *    보기"가 죽은 평문으로 발행됐다).
 *  - flex/border/box-shadow 같은 레이아웃 인라인 스타일은 전부 버려진다. 그래서
 *    가격·할인·CTA를 한 줄에 몰아넣으면 `"…상등급9,290원 33%↓🛒 쿠팡에서 보기"`
 *    처럼 붙어서 발행된다.
 *
 * 그래서 카드는 **앵커를 이미지용/텍스트용으로 분리하고, 각 줄을 별도 문단**으로
 * 만든다. 스타일은 살면 좋고 죽어도 읽히는 형태로만 쓴다.
 */

const CARD_WRAP_STYLE =
  'max-width:640px;margin:24px auto;padding:14px 16px;border:1px solid #e9ecef;border-radius:12px;background:#fff;text-align:center';
const CARD_LINK_ATTRS = 'target="_blank" rel="nofollow sponsored"';

/** 카드 본문 링크 한 줄 — SE가 텍스트 링크로 보존하는 형태(문단 1개 = 앵커 1개). */
function linkParagraph(url: string, inner: string, style: string): string {
  return `<p style="${style}"><a href="${escapeHtml(url)}" ${CARD_LINK_ATTRS} style="color:inherit;text-decoration:none">${inner}</a></p>`;
}

/** 이미지 링크 블록 — SE가 `linkUse:true` 이미지 링크로 보존한다. */
function imageLinkBlock(url: string, imageUrl: string, alt: string, imgStyle: string): string {
  return `<p style="margin:0 0 10px"><a href="${escapeHtml(url)}" ${CARD_LINK_ATTRS}><img src="${escapeHtml(
    imageUrl,
  )}" alt="${alt}" style="${imgStyle}" /></a></p>`;
}

/** 상품 미리보기 카드 HTML(순수, 인라인 스타일) — 유닛 테스트 대상. */
export function buildProductPreviewCard(
  url: string,
  data: WidgetPreviewData,
  fallbackText?: string,
): string {
  const title = escapeHtml(data.title || fallbackText || '쿠팡 상품');
  const lines: string[] = [];

  if (data.imageUrl) {
    lines.push(
      imageLinkBlock(
        url,
        data.imageUrl,
        title,
        'max-width:320px;width:100%;height:auto;border-radius:8px',
      ),
    );
  }

  lines.push(
    linkParagraph(
      url,
      `<b style="font-size:15px;color:#212529">${title}</b>`,
      'margin:0 0 6px;line-height:1.5',
    ),
  );

  // 가격·할인·평점은 각각 별도 문단 — SE가 인라인 레이아웃을 버려도 붙지 않는다.
  if (typeof data.price === 'number' && data.price > 0) {
    const parts = [`<b style="color:#212529">${formatKrw(data.price)}</b>`];
    if (data.originalPrice && data.originalPrice > data.price) {
      parts.push(`<s style="color:#adb5bd">${formatKrw(data.originalPrice)}</s>`);
    }
    if (data.discountRate) {
      parts.push(`<span style="color:#e8590c;font-weight:700">${data.discountRate}%↓</span>`);
    }
    lines.push(`<p style="margin:0 0 6px;font-size:14px">${parts.join(' · ')}</p>`);
  }
  if (data.rating || data.reviewCount) {
    const reviews = data.reviewCount ? ` (${data.reviewCount.toLocaleString('ko-KR')}개 리뷰)` : '';
    lines.push(
      `<p style="margin:0 0 6px;font-size:12px;color:#868e96">⭐ ${data.rating ?? '-'}${reviews}</p>`,
    );
  }

  lines.push(
    linkParagraph(
      url,
      '<b style="color:#e64980">🛒 쿠팡에서 보기</b>',
      'margin:8px 0 0;font-size:14px',
    ),
  );

  // 파트너스 고지는 카드마다 반복하지 않는다 — 템플릿 상단 disclosure가 1회 고지하고,
  // 실측 발행물에서는 카드 3장 때문에 같은 문구가 4번 노출됐다.
  return `<div style="${CARD_WRAP_STYLE}">${lines.join('')}</div>`;
}

/** 이벤트/프로모션 미리보기 카드 HTML(순수, 인라인 스타일) — 유닛 테스트 대상. */
export function buildEventPreviewCard(
  url: string,
  data: WidgetPreviewData,
  fallbackText?: string,
): string {
  const title = escapeHtml(data.title || fallbackText || '쿠팡 이벤트 · 프로모션');
  const lines: string[] = [];

  if (data.imageUrl) {
    lines.push(
      imageLinkBlock(
        url,
        data.imageUrl,
        title,
        'max-width:100%;width:100%;height:auto;border-radius:8px',
      ),
    );
  }

  lines.push(
    `<p style="margin:0 0 6px;font-size:11px;font-weight:700;color:#e8590c">EVENT</p>`,
    linkParagraph(
      url,
      `<b style="font-size:15px;color:#212529">🎉 ${title}</b>`,
      'margin:0 0 6px;line-height:1.5',
    ),
    linkParagraph(
      url,
      '<b style="color:#e8590c">이벤트 확인하기</b>',
      'margin:8px 0 0;font-size:14px',
    ),
  );

  return `<div style="max-width:640px;margin:24px auto;padding:14px 16px;border:1px solid #ffd8a8;border-radius:12px;background:#fff4e6;text-align:center">${lines.join(
    '',
  )}</div>`;
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
        imageUrl?: string;
      };
      // URL 칸에 파트너스 배너 스니펫이 들어와도 href/이미지/alt를 회수해 쓴다
      // (정규화 실패 = 발행 불가 링크 → expandCoupangWidgets가 drop으로 기록한다).
      const link = normalizeLinkWidgetProps(kind, props);
      if (!link) continue;
      url = link.url;
      const data = await fetchWidgetPreviewData(url, adapter, fetcher);
      // 배너 스니펫의 이미지는 원격 조회가 실패해도 쓸 수 있는 확실한 소재다.
      const withBannerImage: WidgetPreviewData =
        link.imageUrl && !data.imageUrl
          ? {
              ...data,
              imageUrl: link.imageUrl,
              source: data.source === 'none' ? 'og' : data.source,
            }
          : data;
      if (withBannerImage.source === 'none') {
        // 이벤트 링크는 데이터 수집에 실패해도 기본 타이틀의 스타일 카드로
        // 발행한다(단순 텍스트 링크보다 눈에 띈다). 상품 링크는 텍스트 링크 폴백.
        if (kind !== 'event-link') continue;
        cards.set(i, buildEventPreviewCard(url, { source: 'none' }, link.text));
        continue;
      }
      const card =
        kind === 'event-link'
          ? buildEventPreviewCard(url, withBannerImage, link.text)
          : buildProductPreviewCard(url, withBannerImage, link.text);
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
