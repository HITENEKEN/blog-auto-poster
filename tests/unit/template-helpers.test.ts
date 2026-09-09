import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerBuiltinTemplateHelpers } from '../../src/content/TemplateEngine';
import { splitRaw } from '../../src/web/shared/hbsConvert';

const templatesDir = fileURLToPath(new URL('../../templates', import.meta.url));
const templateFiles = readdirSync(templatesDir).filter((f) => f.endsWith('.hbs'));

// Handlebars가 자체 제공하는 것들 — 등록 여부를 검사하지 않는다.
const BUILTINS = new Set([
  'each',
  'if',
  'unless',
  'with',
  'log',
  'lookup',
  'else',
  'blockHelperMissing',
  'helperMissing',
]);

/** 인자를 동반한 머스태시(= 헬퍼 호출 위치)의 이름을 모은다. 인자 없는 `{{foo}}`는 데이터 참조. */
function collectHelperNames(body: string): string[] {
  const names = new Set<string>();
  const re = /\{\{[~]?([#/]?)([a-zA-Z_][\w]*)\s+[^}]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    if (m[1] === '/') continue;
    if (!BUILTINS.has(m[2])) names.add(m[2]);
  }
  return [...names];
}

describe('template helpers — 템플릿이 호출하는 헬퍼는 모두 등록되어 있어야 한다', () => {
  registerBuiltinTemplateHelpers();

  it.each(templateFiles)('%s 가 호출하는 헬퍼가 전역 Handlebars에 등록돼 있다', (file) => {
    const raw = readFileSync(`${templatesDir}/${file}`, 'utf8');
    const { body } = splitRaw(raw);
    const missing = collectHelperNames(body).filter((name) => !(name in Handlebars.helpers));
    expect(missing).toEqual([]);
  });

  // 이슈 #20 후속: `math`가 프리뷰 라우트에서만 등록돼 초안 생성이
  // `Missing helper: "math"`로 실패했다. 발행 경로에서도 항상 있어야 한다.
  it('math 헬퍼가 등록돼 있고 산술을 수행한다', () => {
    const render = (tpl: string) => Handlebars.compile(tpl)({});
    expect(render('{{math 0 "+" 1}}')).toBe('1');
    expect(render('{{math 7 "-" 2}}')).toBe('5');
    expect(render('{{math 3 "*" 4}}')).toBe('12');
    expect(render('{{math 8 "/" 2}}')).toBe('4');
    expect(render('{{math 7 "%" 4}}')).toBe('3');
  });

  it('coupang-comparison-guide 의 상품 순위가 1부터 매겨진다', () => {
    const raw = readFileSync(`${templatesDir}/coupang-comparison-guide.hbs`, 'utf8');
    const { body } = splitRaw(raw);
    const html = Handlebars.compile(body)({
      products: [
        { name: '첫째', price: 1000 },
        { name: '둘째', price: 2000 },
      ],
    });
    expect(html).toContain('>1위<');
    expect(html).toContain('>2위<');
  });
});
