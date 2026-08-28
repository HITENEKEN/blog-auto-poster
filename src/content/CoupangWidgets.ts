import * as cheerio from 'cheerio';

/** 쿠팡 위젯 마커 종류 (에디터에서 삽입, 발행 시 실제 HTML로 확장) */
export const COUPANG_WIDGET_KINDS = [
  'product-link',
  'event-link',
  'dynamic-banner',
  'search-widget',
  'category-banner',
] as const;

export type CoupangWidgetKind = (typeof COUPANG_WIDGET_KINDS)[number];

export interface CoupangWidgetProps {
  /** 링크류(product-link/event-link): 쿠팡 파트너스 링크 URL */
  url?: string;
  /** 링크류: 링크 텍스트 */
  text?: string;
  /** 임베드류(dynamic-banner/search-widget/category-banner): 파트너스가 제공한 위젯 HTML/script */
  snippet?: string;
}

/** 저장 포맷(마커): <div data-coupang-widget="{kind}" data-widget-props="{encoded json}"></div> */
export function buildCoupangWidgetMarker(
  kind: CoupangWidgetKind,
  props: CoupangWidgetProps,
): string {
  const encoded = encodeURIComponent(JSON.stringify(props));
  return `<div data-coupang-widget="${kind}" data-widget-props="${encoded}"></div>`;
}

/**
 * Expand `data-coupang-widget` marker elements into real HTML.
 *
 * - product-link / event-link: props.url && props.text →
 *   `<a href="{url}" target="_blank" rel="nofollow sponsored">{text}</a>`
 * - dynamic-banner / search-widget / category-banner: props.snippet is
 *   substituted verbatim (partner-provided widget HTML/script).
 * - Markers without the required props are removed.
 */
export function expandCoupangWidgets(html: string): string {
  const $ = cheerio.load(html);

  $('[data-coupang-widget]').each((_, el) => {
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
      if (props.url && props.text) {
        const anchor = $('<a></a>')
          .attr('href', props.url)
          .attr('target', '_blank')
          .attr('rel', 'nofollow sponsored')
          .text(props.text);
        $(el).replaceWith(anchor);
      } else {
        $(el).remove();
      }
      return;
    }

    if (kind === 'dynamic-banner' || kind === 'search-widget' || kind === 'category-banner') {
      if (props.snippet) {
        $(el).replaceWith(props.snippet);
      } else {
        $(el).remove();
      }
      return;
    }

    $(el).remove();
  });

  return $('body').html() ?? '';
}
