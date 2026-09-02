/**
 * CSS 스코핑 유틸리티 — 포스트/템플릿의 `<style>` 블록을 에디터(WYSIWYG)에
 * 안전하게 적용하기 위해 셀렉터를 지정 스코프(기본 `.ProseMirror`)로 한정한다.
 *
 * 에디터에서 `<style>` 블록은 StyleBlock 노드(칩)로 보존되지만, 문서 전역에
 * 스타일이 새는 것을 막으려면 각 셀렉터를 에디터 컨테이너 하위로 재작성해야 한다.
 * 예: `.ncr-wrap{...}` → `.ProseMirror .ncr-wrap{...}`
 *
 * 지원 범위: 단순 규칙, 쉼표 다중 셀렉터, `@media`/`@supports` 중첩(내부 재귀 스코핑).
 * `@keyframes` 내부의 퍼센트 셀렉터는 스코핑하지 않고 그대로 둔다.
 * CSS 주석은 제거한다.
 */

/** @keyframes 계열 at-rule 내부는 셀렉터 스코핑을 하지 않는다 */
const KEYFRAMES_PATTERN = /^@(-[a-z]+-)?keyframes/i;

function scopeBlock(src: string, scope: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    const selector = src.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') depth--;
      j++;
    }
    const body = src.slice(open + 1, depth === 0 ? j - 1 : j);
    if (selector.startsWith('@')) {
      out += KEYFRAMES_PATTERN.test(selector)
        ? `${selector}{${body}}`
        : `${selector}{${scopeBlock(body, scope)}}`;
    } else {
      const scoped = selector
        .split(',')
        .map((sel) => sel.trim())
        .filter(Boolean)
        .map((sel) => (/^(html|body|:root)$/i.test(sel) ? scope : `${scope} ${sel}`))
        .join(', ');
      if (scoped) out += `${scoped}{${body}}`;
    }
    i = j;
  }
  return out;
}

export function scopeCss(css: string, scope = '.ProseMirror'): string {
  const src = String(css ?? '').replace(/\/\*[\s\S]*?\*\//g, '');
  return scopeBlock(src, scope);
}
