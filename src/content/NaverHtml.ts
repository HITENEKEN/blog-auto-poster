import * as cheerio from 'cheerio';

/**
 * 네이버 발행 직전 본문 HTML을 SmartEditor가 살릴 수 있는 형태로 정규화한다(이슈 #10/#20).
 *
 * - `<script>` 제거: 네이버 블로그는 외부 script를 실행하지 않고 SE 붙여넣기
 *   파서가 제거하므로, 남아 있으면 파싱을 방해한다. (쿠팡 script 위젯은
 *   발행 루트가 실제 상품 카드로 치환한다 — 이슈 #20 T3/T4.)
 * - `<style>` 제거: SE가 버리는 태그다. 인라인화는 StyleInliner가 선행하므로
 *   남아 있는 style은 폐기해도 안전하다.
 * - `<iframe>` 제거(이슈 #20 원인 B): 2026-09-06 실발행물에서 iframe은 100%
 *   소실된다(`iframes: expected 1, found 0`). SE 붙여넣기 파서가 iframe을
 *   아예 수용하지 않으므로, 남아 있으면 붙여넣기 파싱을 방해하고 "기대 1/실제 0"
 *   무결성 실패를 매 발행마다 유발한다. 미리 걷어내 무결성 기대값을 현실과 맞춘다.
 * - 비-http 앵커 언래핑(이슈 #20 원인 C): `<a href="#">텍스트</a>` → `텍스트`.
 *   SE는 href가 http(s)가 아닌 앵커를 버리고 내부 텍스트만 평문으로 남긴다.
 *   결과적으로 "가격 확인하기" 버튼이 링크 없는 죽은 텍스트로 발행된다.
 *   여기서 앵커를 벗겨 내면 어떤 경로로 들어온 href="#"라도 발행물에
 *   죽은 버튼이 남지 않는다(마지막 방어선). 실제 링크 치환은 fillCtaAffiliateUrl이
 *   이 단계보다 먼저 수행한다.
 * - `h1~h6` → 인라인 스타일 `<p>` 변환: SE 붙여넣기 파서가 heading 태그를 평문
 *   모듈로 평탄화해 글자 크기 계층이 사라지므로(이슈 #9/#10), 인라인
 *   font-size/굵기를 직접 부여한다. 기존 인라인 style(StyleInliner 산출)은
 *   최우선으로 유지한다.
 *
 * 순수 함수 — 유닛 테스트 대상(tests/unit/naver-html.test.ts).
 */

const HEADING_DEFAULT_STYLES: Record<string, string> = {
  h1: 'font-size: 1.45rem; font-weight: 700; margin: 26px 0 12px',
  h2: 'font-size: 1.25rem; font-weight: 700; margin: 24px 0 10px',
  h3: 'font-size: 1.1rem; font-weight: 700; margin: 20px 0 8px',
  h4: 'font-size: 1.02rem; font-weight: 700; margin: 16px 0 6px',
  h5: 'font-size: 1rem; font-weight: 700; margin: 14px 0 6px',
  h6: 'font-size: 0.95rem; font-weight: 700; margin: 12px 0 6px',
};

/** SE가 href를 유지해 주는 스킴. 그 외(빈 값/#/javascript:/상대경로)는 죽은 링크다. */
const SURVIVABLE_HREF_SCHEMES = ['http:', 'https:', 'mailto:', 'tel:'];

/** href가 SE 발행 후에도 살아남는 링크인지 판정한다(이슈 #20 원인 C). */
export function isSurvivableHref(href: string | undefined): boolean {
  const value = (href ?? '').trim();
  if (!value || value.startsWith('#')) return false;
  // 스킴 없는 상대경로(/foo, foo/bar)는 SE가 href를 버린다.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
  if (!schemeMatch) return false;
  return SURVIVABLE_HREF_SCHEMES.includes(`${schemeMatch[1].toLowerCase()}:`);
}

/** 기본 스타일과 기존 인라인 style을 병합한다 — 기존 선언이 우선한다. */
function mergeHeadingStyles(defaults: string, existing: string): string {
  const map = new Map<string, string>();
  for (const decl of `${defaults}; ${existing}`.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop && value) map.set(prop, value);
  }
  return [...map.entries()].map(([k, v]) => `${k}: ${v}`).join('; ');
}

export function prepareNaverHtml(html: string): string {
  if (!html) return html;
  const $ = cheerio.load(html);
  $('script').remove();
  $('style').remove();
  // 이슈 #20 원인 B — iframe은 100% 소실되므로 기대값 자체를 없앤다.
  $('iframe').remove();
  // 이슈 #20 원인 C — 죽은 앵커는 벗기고 내부 콘텐츠(텍스트/이미지)만 남긴다.
  $('a').each((_, el) => {
    const anchor = $(el);
    if (isSurvivableHref(anchor.attr('href'))) return;
    anchor.replaceWith(anchor.contents());
  });
  for (const [tag, defaults] of Object.entries(HEADING_DEFAULT_STYLES)) {
    $(tag).each((_, el) => {
      const node = $(el);
      const merged = mergeHeadingStyles(defaults, (node.attr('style') || '').trim());
      node.replaceWith(`<p style="${merged}">${node.html() ?? ''}</p>`);
    });
  }
  return $('body').html() ?? '';
}
