import * as cheerio from 'cheerio';
import { normalizeLinkWidgetProps, type CoupangWidgetProps } from './CoupangWidgets';
import { isSurvivableHref } from './NaverHtml';

/**
 * 본문 위젯 마커 유틸 (이슈 #17·#18·#20).
 *
 * 자동 광고 배치는 `AdPlacement.ts`가 맡는다 — 예전처럼 등록된 프리셋을 모든 글에
 * 균등 분산하지 않는다(주제 무관 상품 문제, 이슈 #21). 여기에는 마커를 다루는
 * 순수 함수(승격·CTA 채우기)만 남는다.
 */

/** 본문에 위젯 마커가 이미 존재하는지 */
export function hasWidgetMarkers(html: string): boolean {
  return /data-coupang-widget=/.test(html);
}

/** 본문을 h2/h3 섹션 경계로 분리한 뒤 각 섹션의 끝 오프셋을 반환한다. */
export function findSectionBoundaries(html: string): Array<{ start: number; end: number }> {
  const boundaries: Array<{ start: number; end: number }> = [];
  const re = /<h[23]\b[^>]*>[\s\S]*?<\/h[23]>/gi;
  const headings: Array<{ start: number; end: number }> = [];
  for (const m of html.matchAll(re)) {
    headings.push({ start: m.index, end: m.index + m[0].length });
  }
  for (let i = 0; i < headings.length; i++) {
    // 섹션 = 이 heading 다음부터 다음 heading 직전까지
    const end = i + 1 < headings.length ? headings[i + 1].start : html.length;
    boundaries.push({ start: headings[i].end, end });
  }
  return boundaries;
}

/**
 * 위젯 마커가 갇히면 SmartEditor가 앞 요소에 흡수해 버리는 컨테이너들.
 * `<figure>` 안에 들어간 마커는 섹션 사진의 **캡션**으로 병합됐다
 * (2026-09-07 실발행물 logNo 224404059950 #17 — 이벤트 카드가 독립 카드가 아니라
 * 앞 사진의 캡션 텍스트로 발행됐다).
 */
const MARKER_TRAP_TAGS = 'figure,figcaption,p,li,ul,ol,blockquote,table';

/**
 * 블록 컨테이너 안에 갇힌 위젯 마커를 그 컨테이너 **뒤 형제**로 끌어올린다.
 * 순수 함수 — 유닛 테스트 대상.
 *
 * 에디터에서 커서 위치에 마커를 삽입하면 `<figure class="section-image">`나 `<p>`
 * 내부에 들어갈 수 있다. 그 상태로 발행하면 SE가 컨테이너를 컴포넌트 1개로 접으면서
 * 위젯을 캡션으로 흡수해, 카드가 독립 블록으로 보이지 않는다.
 *
 * - 중첩된 경우 **가장 바깥쪽** 컨테이너 뒤로 옮긴다.
 * - 옮길 마커가 없으면 원본 문자열을 그대로 반환한다 — cheerio 재직렬화로
 *   문서 구조가 바뀔 여지를 없앤다(fillCtaAffiliateUrl과 같은 규약).
 */
export function liftWidgetMarkers(html: string): string {
  if (!html || !hasWidgetMarkers(html)) return html;

  const $ = cheerio.load(html);
  let moved = 0;
  $('[data-coupang-widget]').each((_, el) => {
    const node = $(el);
    const traps = node.parents(MARKER_TRAP_TAGS);
    if (traps.length === 0) return;
    traps.last().after(node);
    moved += 1;
  });
  if (moved === 0) return html;
  return $('body').html() ?? html;
}

/**
 * 템플릿 CTA 앵커의 class — 발행 시점에 실제 제휴 URL을 채워 넣을 대상.
 * 생성 시점엔 `affiliateUrl`이 비어 있어 CTA 자체가 렌더되지 않지만(이슈 #20 원인 C),
 * 프리셋에서 URL을 확보한 경로에서는 죽은 href("")/#를 실제 URL로 채워 발행한다.
 */
const CTA_ANCHOR_CLASSES = [
  'ncr-cta',
  'ncf-cta',
  'cpr-cta-primary',
  'cpr-cta-large',
  'ccg-cta',
  'cbg-cta-sm',
  'cta-button',
  'purchase-button',
];

/**
 * 본문 속 죽은 CTA 앵커(href가 빈 값/'#')에 실제 제휴 URL을 채운다. 순수 함수.
 *
 * 배경(이슈 #20 원인 C): 네이버 SmartEditor는 href가 http(s)가 아닌 앵커를
 * 버리고 내부 텍스트만 평문으로 남긴다. 그래서 `affiliateUrl: '#'`로 렌더된
 * "🛒 가격 확인하기" 버튼은 발행물에서 링크 없는 죽은 문구가 됐다.
 *
 * - url이 비어 있으면 html을 그대로 반환한다(채울 값이 없으면 손대지 않는다).
 * - 치환한 앵커가 하나도 없으면 원본 문자열을 그대로 반환한다 — cheerio
 *   재직렬화로 문서 구조가 바뀔 여지를 없앤다.
 */
export function fillCtaAffiliateUrl(html: string, url: string): string {
  const target = (url ?? '').trim();
  if (!html || !target) return html;

  const $ = cheerio.load(html);
  let filled = 0;
  for (const cls of CTA_ANCHOR_CLASSES) {
    $(`a.${cls}`).each((_, el) => {
      const href = ($(el).attr('href') ?? '').trim();
      // 빈 값/'#'만 치환한다 — 이미 실제 링크가 있으면 사용자/프리셋 값을 존중한다.
      if (href === '' || href === '#') {
        $(el).attr('href', target);
        filled += 1;
      }
    });
  }
  if (filled === 0) return html;
  return $('body').html() ?? html;
}

/**
 * 본문 CTA 버튼에 채울 제휴 URL을 정한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 우선순위: 본문의 첫 유효 product-link 마커(자동 광고 포함) → 글 메타의 affiliateUrl.
 *
 * 배경(2026-09-07 실발행물 logNo 224404059950): 기존 로직은 등록 프리셋만 봤고,
 * 프리셋이 하나도 없으면 `ctaUrl`이 빈 값이 되어 "가격 확인하기" 버튼이 발행물에서
 * 통째로 사라졌다. 지금은 프리셋 대신 인벤토리에서 배치된 자동 광고 마커를 쓴다.
 */
export function resolveCtaAffiliateUrl(html: string, fallbackUrl?: string): string {
  if (html && hasWidgetMarkers(html)) {
    const $ = cheerio.load(html);
    for (const el of $('[data-coupang-widget="product-link"]').toArray()) {
      try {
        const props = JSON.parse(
          decodeURIComponent($(el).attr('data-widget-props') || ''),
        ) as CoupangWidgetProps;
        const link = normalizeLinkWidgetProps('product-link', props);
        if (link) return link.url;
      } catch {
        // props가 깨진 마커는 건너뛴다 — expand 단계가 drop으로 기록한다
      }
    }
  }

  const fallback = (fallbackUrl ?? '').trim();
  return isSurvivableHref(fallback) ? fallback : '';
}
