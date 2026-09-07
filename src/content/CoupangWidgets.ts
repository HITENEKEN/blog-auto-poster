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
   * 발행 대상 플랫폼. 'naver'면 네이버 블로그가 외부 script를 실행하지 못하고
   * iframe을 100% 제거하므로(이슈 #20 원인 B), 스니펫에서 script/iframe을 걷어내고
   * 남은 콘텐츠가 없으면 마커를 제거한다(다른 플랫폼은 기존대로 snippet을 그대로 사용).
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
  /**
   * 임베드 위젯(dynamic-banner/search-widget/category-banner) 자리에 발행할
   * 실제 상품 카드 묶음 HTML(이슈 #20 T3).
   * 키는 마커의 문서 순서 인덱스 — previewCards와 동일한 규약이며, 발행 라우트가
   * fetchPartnersWidgetCards로 사전 수집한다.
   * 카드가 있으면 스니펫 대신 카드로 치환한다(iframe은 네이버가 100% 제거하므로
   * 카드가 유일한 생존 경로). 카드가 없고 script 전용 스니펫이면 drop으로 기록한다.
   */
  widgetCards?: Map<number, string>;
}

/** 링크 위젯의 text가 비어 있을 때 사용하는 기본 라벨 (유실 방지 — 이슈 #10) */
const DEFAULT_LINK_TEXT: Record<string, string> = {
  'product-link': '상품 보기',
  'event-link': '이벤트 확인하기',
};

const NAVER_PLATFORM = 'naver';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Coupang Partners script 스니펫에서 위젯 파라미터(id/trackingCode/template/…)를
 * 추출한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 두 가지 스니펫 형태를 모두 받아들인다:
 *  - `new PartnersCoupang.G({"id":…,"trackingCode":…})` — 파트너스가 사용자에게
 *    제공하는 삽입용 스니펫(파라미터가 최상위에 있다).
 *  - `new PartnersCoupang.Carousel("#container", {"items":…,"config":…,"logParams":…})`
 *    — 위젯 문서가 렌더링하는 형태(파라미터가 logParams/config에 흩어져 있다).
 *
 * 추출한 파라미터는 fetchPartnersWidgetCards가 위젯 문서를 재요청해 실제 상품
 * 카드를 만드는 데 쓰인다(이슈 #20 T3/T4).
 */
export function parsePartnersCoupangScript(snippet: string): Record<string, unknown> | null {
  const obj = parsePartnersCallObject(snippet || '');
  if (!obj) return null;

  // G 형태 — 파라미터가 최상위에 있다.
  if (obj.id != null && obj.trackingCode != null) return obj;

  // Carousel(서버 렌더) 형태 — logParams/config에서 파라미터를 복원한다.
  const logParams = isRecord(obj.logParams) ? obj.logParams : {};
  const config = isRecord(obj.config) ? obj.config : {};
  const id = logParams.id ?? obj.id;
  const trackingCode = logParams.trackingCode ?? obj.trackingCode;
  if (id == null || trackingCode == null) return null;
  return {
    id,
    trackingCode,
    subId: logParams.subId ?? obj.subId,
    template: logParams.widgetName ?? obj.template,
    width: config.width ?? obj.width,
    height: config.height ?? obj.height,
  };
}

/**
 * `new PartnersCoupang.<Name>(…)` 호출에서 첫 객체 인수를 찾아 JSON으로 파싱한다.
 * 순수 함수 — 유닛 테스트 대상.
 *
 * 두 형태를 모두 처리한다:
 *  - `new PartnersCoupang.G({"id":…})` — 첫 인수가 곧 파라미터 객체
 *  - `new PartnersCoupang.Carousel("#container", {"items":…})` — 두 번째 인수가 객체
 *
 * 상품명에 `)`·`{}`가 섞일 수 있으므로, 닫는 괄호를 `indexOf(')')`로 자르지 않고
 * 문자열(따옴표)을 인식하며 중괄호 균형을 맞춰 객체 범위를 찾는다.
 */
function parsePartnersCallObject(snippet: string): Record<string, unknown> | null {
  const callRe = /new\s+PartnersCoupang\.\w+\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = callRe.exec(snippet)) !== null) {
    const open = snippet.indexOf('{', call.index + call[0].length);
    if (open < 0) continue;

    let depth = 0;
    let end = -1;
    let inString = false;
    let escaped = false;
    for (let i = open; i < snippet.length; i += 1) {
      const ch = snippet[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) continue;
    try {
      const parsed: unknown = JSON.parse(snippet.slice(open, end + 1));
      if (isRecord(parsed)) return parsed;
    } catch {
      // 다음 호출 시도로
    }
  }
  return null;
}

/**
 * 네이버 발행에서 살아남을 수 없는 요소(script/iframe)를 스니펫에서 걷어낸다.
 * 남은 콘텐츠(앵커/이미지/텍스트)가 없으면 null — 호출부가 drop으로 기록한다.
 *
 * 이슈 #20 원인 B: iframe은 네이버가 100% 제거한다. 그래서 iframe 위젯으로
 * "변환"하는 기존 경로는 매 발행마다 무결성 실패를 유발했고, 위젯 자리는
 * 빈 구멍으로 남았다. iframe/script를 걷어내고 script 없는 순수 `<a><img>`
 * 스니펫(카테고리 배너 등)만 통과시킨다 — 이건 발행물에서 정상 동작이 확인됐다.
 */
function convertSnippetForNaver(snippet: string): string | null {
  const trimmed = (snippet || '').trim();
  if (!trimmed) return null;
  const hasScript = /<script[\s>]/i.test(trimmed);
  const hasIframe = /<iframe[\s>]/i.test(trimmed);
  // script/iframe이 없는 snippet(앵커/이미지 등 안전한 HTML)은 그대로 사용한다.
  if (!hasScript && !hasIframe) return trimmed;

  const $ = cheerio.load(trimmed);
  $('iframe').remove();
  $('script').remove();
  const rest = ($('body').html() ?? '').trim();
  return rest || null;
}

/**
 * Expand `data-coupang-widget` marker elements into real HTML.
 *
 * - product-link / event-link: props.url →
 *   `<a href="{url}" target="_blank" rel="nofollow sponsored">{text}</a>`
 *   text가 비어 있으면 유실 방지를 위해 기본 라벨로 발행한다(이슈 #10).
 * - dynamic-banner / search-widget / category-banner: options.widgetCards에 사전
 *   수집한 실제 상품 카드가 있으면 그것을 발행한다(이슈 #20 T3). 카드가 없으면
 *   props.snippet을 사용하되, platform이 'naver'면 script/iframe을 걷어낸다 —
 *   네이버는 외부 script를 실행하지 못하고 iframe을 100% 제거하기 때문에 남은
 *   콘텐츠가 없으면 마커를 제거하고 drop에 기록한다.
 * - ad-banner: props.url && props.imageUrl →
 *   `<a href="{url}" target="_blank" rel="nofollow sponsored"><img src="{imageUrl}" alt="{text}"/></a>`
 *   props.text가 있으면 이미지 아래 캡션 문단을 추가한다.
 * - 필수 props가 없는 마커는 제거되며 drop 리포트에 기록된다(이슈 #15 —
 *   조용한 유실을 방지하기 위해 발행 라우트가 리포트를 로깅/보고한다).
 */

/** 확장 실패로 제거된 위젯 마커 한 건 (이슈 #15) */
export interface CoupangWidgetDrop {
  kind: string;
  reason: string;
}

export interface ExpandWidgetsReport {
  html: string;
  /** 실제 HTML로 확장된 마커 수 */
  expanded: number;
  /** 확장 실패로 제거된 마커 목록 */
  dropped: CoupangWidgetDrop[];
}

export function expandCoupangWidgets(
  html: string,
  options: ExpandCoupangWidgetsOptions = {},
): string {
  return expandCoupangWidgetsReport(html, options).html;
}

export function expandCoupangWidgetsReport(
  html: string,
  options: ExpandCoupangWidgetsOptions = {},
): ExpandWidgetsReport {
  const dropped: CoupangWidgetDrop[] = [];
  const expandedCount = { value: 0 };
  const expanded = expandMarkers(html, options, dropped, expandedCount);
  return { html: expanded, expanded: expandedCount.value, dropped };
}

function expandMarkers(
  html: string,
  options: ExpandCoupangWidgetsOptions,
  dropped: CoupangWidgetDrop[],
  expandedCount: { value: number },
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
        expandedCount.value += 1;
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
        expandedCount.value += 1;
      } else {
        logger.warn({ kind }, 'Coupang link widget dropped: url prop missing');
        dropped.push({ kind, reason: 'url prop missing' });
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
        expandedCount.value += 1;
      } else {
        logger.warn({ kind }, 'Coupang ad-banner widget dropped: url/imageUrl prop missing');
        dropped.push({ kind, reason: 'url/imageUrl prop missing' });
        $(el).remove();
      }
      return;
    }

    if (kind === 'dynamic-banner' || kind === 'search-widget' || kind === 'category-banner') {
      // 이슈 #20 T3 — 사전 수집한 실제 상품 카드가 있으면 스니펫 대신 카드로 발행한다.
      // iframe/script는 네이버에서 100% 제거되므로 카드가 유일한 생존 경로다.
      const cards = options.widgetCards?.get(index);
      if (cards) {
        $(el).replaceWith(
          options.platform ? `<div style="margin:24px 0;text-align:center">${cards}</div>` : cards,
        );
        expandedCount.value += 1;
        return;
      }

      if (props.snippet) {
        const replacement = isNaver ? convertSnippetForNaver(props.snippet) : props.snippet;
        if (replacement) {
          $(el).replaceWith(
            options.platform
              ? `<div style="margin:24px 0;text-align:center">${replacement}</div>`
              : replacement,
          );
          expandedCount.value += 1;
        } else {
          logger.warn(
            { kind },
            'Coupang embed widget dropped for naver: snippet has no publishable content',
          );
          dropped.push({
            kind,
            reason: 'naver cannot publish this widget (script/iframe removed, no card)',
          });
          $(el).remove();
        }
      } else {
        logger.warn({ kind }, 'Coupang embed widget dropped: snippet prop missing');
        dropped.push({ kind, reason: 'snippet prop missing' });
        $(el).remove();
      }
      return;
    }

    logger.warn({ kind }, 'Coupang widget dropped: unknown kind');
    dropped.push({ kind: kind ?? 'unknown', reason: 'unknown widget kind' });
    $(el).remove();
  });

  return $('body').html() ?? '';
}
