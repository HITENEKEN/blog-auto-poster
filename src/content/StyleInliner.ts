import * as cheerio from 'cheerio';

/**
 * 네이버 블로그 에디터는 <style> 블록을 제거하므로(이슈 #9), 발행 전에 CSS 규칙을
 * 각 요소의 인라인 style 속성으로 변환한다. 이렇게 하면 줄간격/문단 간격/박스
 * 꾸밈이 네이버에 그대로 반영된다.
 *
 * 처리 범위: 단일/복수/후손 셀렉터, @media(내부 규칙 평탄화), CSS 주석 제거.
 * @keyframes/@font-face 블록과 :hover 같은 의사 클래스 셀렉터는 인라인화 대상에서
 * 제외한다(인라인 스타일로 표현 불가). 기존 style 속성은 우선순위가 가장 높다.
 *
 * 순수 함수 — 유닛 테스트 대상(tests/unit/style-inliner.test.ts).
 */

interface CssRule {
  selector: string;
  declarations: Record<string, string>;
  specificity: number;
  order: number;
}

/** 대략적 CSS specificity — inline 적용 순서 결정용(높을수록 나중에 적용). */
function specificity(selector: string): number {
  let score = 0;
  score += (selector.match(/#/g)?.length ?? 0) * 100;
  score += (selector.match(/[.[]/g)?.length ?? 0) * 10;
  const rest = selector.replace(/[#.][\w-]+/g, '').trim();
  score += rest.split(/[\s>+~]+/).filter((t) => t && !t.startsWith(':')).length;
  return score;
}

function parseDeclarations(decls: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of decls.split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop && value) map[prop] = value;
  }
  return map;
}

function pushRule(rules: CssRule[], selector: string, decls: string, order: { n: number }): void {
  // 의사 클래스/의사 엘리먼트 셀렉터는 인라인화할 수 없다
  if (/:/.test(selector)) return;
  for (const sel of selector.split(',')) {
    const s = sel.trim();
    if (!s) continue;
    rules.push({
      selector: s,
      declarations: parseDeclarations(decls),
      specificity: specificity(s),
      order: order.n++,
    });
  }
}

/** 단순 CSS 토크나이저 — @media 평탄화, @keyframes/@font-face 스킵, 주석 제거. */
function collectRules(css: string, rules: CssRule[]): void {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  const order = { n: 0 };
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
      if (/^@keyframes/i.test(selector) || /^@font-face/i.test(selector)) {
        // 그대로 둔다? — 인라인 대상이 아니므로 폐기한다.
      } else {
        collectRules(body, rules);
      }
    } else {
      pushRule(rules, selector, body, order);
    }
    i = j;
  }
}

function mergeDeclarations(existingStyle: string, declarations: Record<string, string>): string {
  // 기존 인라인 style이 최우선, 규칙 선언은 빈 속성만 채운다
  const map: Record<string, string> = { ...declarations };
  for (const part of (existingStyle || '').split(';')) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    if (prop && value) map[prop] = value;
  }
  return Object.entries(map)
    .map(([k, v]) => `${k}: ${v}`)
    .join('; ');
}

/** CSS 규칙을 HTML 요소에 인라인 적용한다(기존 style 유지 + 규칙 선언 병합). */
function applyRules($: ReturnType<typeof cheerio.load>, rules: CssRule[]): void {
  const sorted = [...rules].sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  for (const rule of sorted) {
    let matched: ReturnType<typeof $> | null = null;
    try {
      matched = $(rule.selector);
    } catch {
      continue; // cheerio가 파싱 못하는 셀렉터는 건너뛴다
    }
    if (!matched || matched.length === 0) continue;
    matched.each((_, el) => {
      const node = $(el);
      const existing = (node.attr('style') || '').trim();
      node.attr('style', mergeDeclarations(existing, rule.declarations));
    });
  }
}

/**
 * HTML 내 <style> 블록의 규칙을 요소 인라인 style로 변환하고 <style> 태그를
 * 제거한다. 네이버처럼 <style>을 지우는 플랫폼 발행 전에 호출한다.
 */
export function inlineStyleBlocks(html: string): string {
  if (!html || !html.includes('<style')) return html;
  const $ = cheerio.load(html);
  const rules: CssRule[] = [];
  $('style').each((_, el) => collectRules($(el).text() || '', rules));
  if (rules.length === 0) {
    $('style').remove();
    // 문서 전체(<html><body>)가 아닌 body 조각을 반환한다 — 네이버 SmartEditor
    // 붙여넣기 파서에 문서 전체를 넣으면 마크업이 망가진다(이슈 #10).
    return $('body').html() ?? '';
  }
  applyRules($, rules);
  $('style').remove();
  return $('body').html() ?? '';
}
