import * as cheerio from 'cheerio';

/**
 * 네이버 발행 직전 본문 HTML을 SmartEditor가 살릴 수 있는 형태로 정규화한다(이슈 #10).
 *
 * - `<script>` 제거: 네이버 블로그는 외부 script를 실행하지 않고 SE 붙여넣기
 *   파서가 제거하므로, 남아 있으면 파싱을 방해한다. (쿠팡 script 위젯의 iframe
 *   변환은 expandCoupangWidgets({ platform: 'naver' })가 선행한다.)
 * - `<style>` 제거: SE가 버리는 태그다. 인라인화는 StyleInliner가 선행하므로
 *   남아 있는 style은 폐기해도 안전하다.
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
  for (const [tag, defaults] of Object.entries(HEADING_DEFAULT_STYLES)) {
    $(tag).each((_, el) => {
      const node = $(el);
      const merged = mergeHeadingStyles(defaults, (node.attr('style') || '').trim());
      node.replaceWith(`<p style="${merged}">${node.html() ?? ''}</p>`);
    });
  }
  return $('body').html() ?? '';
}
