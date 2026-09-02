import * as cheerio from 'cheerio';
import { getLogger } from '@core/logger';

const logger = getLogger('coupang-widgets');

/** 쿠팡 위젯 마커 종류 (에디터에서 삽입, 발행 시 실제 HTML로 확장) */
export const COUPANG_WIDGET_KINDS = [
  'product-link',
  'event-link',
  'dynamic-banner',
  'search-widget',
  'category-banner',
  'ad-banner',
] as const;

export type CoupangWidgetKind = (typeof COUPANG_WIDGET_KINDS)[number];

export interface CoupangWidgetProps {
  /** 링크류(product-link/event-link): 쿠팡 파트너스 링크 URL */
  url?: string;
  /** 링크류: 링크 텍스트 */
  text?: string;
  /** 임베드류(dynamic-banner/search-widget/category-banner): 파트너스가 제공한 위젯 HTML/script */
  snippet?: string;
  /** 광고 배너(ad-banner): 배너 이미지 URL */
  imageUrl?: string;
}

/** 저장 포맷(마커): <div data-coupang-widget="{kind}" data-widget-props="{encoded json}"></div> */
export function buildCoupangWidgetMarker(
  kind: CoupangWidgetKind,
  props: CoupangWidgetProps,
): string {
  const encoded = encodeURIComponent(JSON.stringify(props));
  return `<div data-coupang-widget="${kind}" data-widget-props="${encoded}"></div>`;
}

export interface ExpandCoupangWidgetsOptions {
  /**
   * 발행 대상 플랫폼. 'naver'면 네이버 블로그가 외부 script를 실행하지 못하므로
   * script 기반 위젯(dynamic-banner 등)을 파트너스 공식 iframe 위젯으로 변환하고,
   * 변환할 수 없는 script는 제거한다(다른 플랫폼은 기존대로 snippet을 그대로 사용).
   * 플랫폼이 지정되면(=발행 시점) 임베드/배너 위젯을 중앙 정렬 컨테이너로 감싸
   * 발행물 스타일을 다듬는다(이슈 #12).
   */
  platform?: string;
  /**
   * product-link/event-link를 미리보기 카드 HTML로 치환한다(이슈 #12).
   * 키는 마커의 문서 순서 인덱스 — fetchLinkPreviewCards가 사전 수집한다.
   * 해당 인덱스에 카드가 없으면 기존 텍스트 링크로 발행한다.
   */
  previewCards?: Map<number, string>;
}

/** 링크 위젯의 text가 비어 있을 때 사용하는 기본 라벨 (유실 방지 — 이슈 #10) */
const DEFAULT_LINK_TEXT: Record<string, string> = {
  'product-link': '상품 보기',
  'event-link': '이벤트 확인하기',
};

const NAVER_PLATFORM = 'naver';

/**
 * Coupang Partners script 스니펫에서 `new PartnersCoupang.G({...})` 파라미터를
 * 추출한다. 순수 함수 — 유닛 테스트 대상.
 */
export function parsePartnersCoupangScript(snippet: string): Record<string, unknown> | null {
  const match = /new\s+PartnersCoupang\.G\((\{[\s\S]*?\})\)/.exec(snippet || '');
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * PartnersCoupang.G 파라미터를 네이버 블로그에서 동작하는 파트너스 공식 iframe
 * 위젯 URL로 변환한다. ads-partners.coupang.com/widgets.html은 script 위젯과
 * 동일한 배너 문서를 서빙한다(라이브 검증 완료). 순수 함수 — 유닛 테스트 대상.
 */
export function buildPartnersIframeSnippet(params: Record<string, unknown>): string | null {
  const id = params.id;
  const trackingCode = params.trackingCode;
  if (id == null || trackingCode == null) return null;

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

  const attrs: string[] = [
    `src="https://ads-partners.coupang.com/widgets.html?${usp.toString()}"`,
    'frameborder="0"',
    'scrolling="no"',
    'referrerpolicy="unsafe-url"',
  ];
  if (width != null) attrs.push(`width="${String(width)}"`);
  if (height != null) attrs.push(`height="${String(height)}"`);
  return `<iframe ${attrs.join(' ')}></iframe>`;
}

/** script 전용 스니펫을 네이버에서 동작 가능한 형태로 변환한다. 불가하면 null. */
function convertSnippetForNaver(snippet: string): string | null {
  const trimmed = snippet.trim();
  if (!trimmed) return null;
  // script가 없는 snippet(앵커/이미지/iframe 등 안전한 HTML)은 그대로 사용한다.
  if (!/<script[\s>]/i.test(trimmed)) return trimmed;
  // iframe이 포함된 snippet도 그대로 둔다(iframe은 네이버에서 허용, script는
  // 이후 prepareNaverHtml이 제거한다).
  if (/<iframe[\s>]/i.test(trimmed)) return trimmed;
  // script-only snippet은 PartnersCoupang.G 파라미터를 iframe 위젯으로 변환한다.
  const params = parsePartnersCoupangScript(trimmed);
  if (params) {
    const iframe = buildPartnersIframeSnippet(params);
    if (iframe) return iframe;
  }
  return null;
}

/**
 * Expand `data-coupang-widget` marker elements into real HTML.
 *
 * - product-link / event-link: props.url →
 *   `<a href="{url}" target="_blank" rel="nofollow sponsored">{text}</a>`
 *   text가 비어 있으면 유실 방지를 위해 기본 라벨로 발행한다(이슈 #10).
 * - dynamic-banner / search-widget / category-banner: props.snippet is
 *   substituted verbatim (partner-provided widget HTML/script). 단 platform이
 *   'naver'면 script 전용 snippet은 파트너스 iframe 위젯으로 변환하고, 변환할 수
 *   없으면 제거한다(네이버는 외부 script를 실행하지 않는다).
 * - ad-banner: props.url && props.imageUrl →
 *   `<a href="{url}" target="_blank" rel="nofollow sponsored"><img src="{imageUrl}" alt="{text}"/></a>`
 *   props.text가 있으면 이미지 아래 캡션 문단을 추가한다.
 * - 필수 props가 없는 마커는 제거된다(경고 로그).
 */
export function expandCoupangWidgets(
  html: string,
  options: ExpandCoupangWidgetsOptions = {},
): string {
  const isNaver = options.platform === NAVER_PLATFORM;
  const $ = cheerio.load(html);

  $('[data-coupang-widget]').each((index, el) => {
    const kind = $(el).attr('data-coupang-widget');
    let props: CoupangWidgetProps = {};
    const raw = $(el).attr('data-widget-props');
    if (raw) {
      try {
        props = JSON.parse(decodeURIComponent(raw)) as CoupangWidgetProps;
      } catch {
        props = {};
      }
    }

    if (kind === 'product-link' || kind === 'event-link') {
      // 미리보기 카드가 사전 수집되어 있으면 단순 링크 대신 광고 카드로 발행한다(이슈 #12).
      const card = options.previewCards?.get(index);
      if (props.url && card) {
        $(el).replaceWith(card);
        return;
      }
      if (props.url) {
        // text가 비어 있어도 삭제하지 않고 기본 라벨로 발행한다(이슈 #10 —
        // URL만 입력한 위젯이 발행물에서 조용히 사라지는 원인).
        const text = (props.text ?? '').trim() || DEFAULT_LINK_TEXT[kind] || '상품 보기';
        const anchor = $('<a></a>')
          .attr('href', props.url)
          .attr('target', '_blank')
          .attr('rel', 'nofollow sponsored')
          .text(text);
        $(el).replaceWith(anchor);
      } else {
        logger.warn({ kind }, 'Coupang link widget dropped: url prop missing');
        $(el).remove();
      }
      return;
    }

    if (kind === 'ad-banner') {
      if (props.url && props.imageUrl) {
        const anchor = $('<a></a>')
          .attr('href', props.url)
          .attr('target', '_blank')
          .attr('rel', 'nofollow sponsored');
        anchor.append(
          $('<img></img>')
            .attr('src', props.imageUrl)
            .attr('alt', props.text ?? ''),
        );
        if (options.platform) {
          // 발행 시점 스타일 다듬기 — 배너 중앙 정렬 컨테이너(이슈 #12)
          $(el).replaceWith(
            $('<div style="margin:24px 0;text-align:center"></div>').append(anchor),
          );
        } else {
          $(el).replaceWith(anchor);
        }
        if (props.text) {
          anchor.after($('<p></p>').text(props.text));
        }
      } else {
        $(el).remove();
      }
      return;
    }

    if (kind === 'dynamic-banner' || kind === 'search-widget' || kind === 'category-banner') {
      if (props.snippet) {
        const replacement = isNaver ? convertSnippetForNaver(props.snippet) : props.snippet;
        if (replacement) {
          $(el).replaceWith(
            options.platform
              ? `<div style="margin:24px 0;text-align:center">${replacement}</div>`
              : replacement,
          );
        } else {
          logger.warn(
            { kind },
            'Coupang script widget dropped for naver: not convertible to iframe',
          );
          $(el).remove();
        }
      } else {
        $(el).remove();
      }
      return;
    }

    $(el).remove();
  });

  return $('body').html() ?? '';
}
