import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerBuiltinTemplateHelpers } from '../../src/content/TemplateEngine';
import { splitRaw } from '../../src/web/shared/hbsConvert';

/**
 * 이슈 #23 1-1: 기준 템플릿(naver-coupang-review) 체크리스트를 전 템플릿이 만족하는지 고정한다.
 *  - sectionImages 본문 슬롯 존재
 *  - 제휴 CTA는 {{#if ...affiliateUrl}} 가드 안에서만 렌더 (이슈 #20 원인 C)
 *  - 쿠팡 파트너스 고지 문구 존재
 *  - "향후 구현 예정" 등 미구현 스텁 문구 0회 (#22)
 *  - 최소 데이터로 컴파일·렌더가 예외 없이 끝난다
 */
const templatesDir = fileURLToPath(new URL('../../templates', import.meta.url));
const templateFiles = readdirSync(templatesDir).filter((f) => f.endsWith('.hbs'));

registerBuiltinTemplateHelpers();

/** hbs 주석({{!-- --}}, {{! }})과 html 주석(<!-- -->)을 제거한다. */
function stripComments(s: string): string {
  return s
    .replace(/\{\{!--[\s\S]*?--\}\}/g, '')
    .replace(/\{\{![\s\S]*?\}\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

const SAMPLE = {
  productName: '무선 청소기 프리미엄',
  price: 189000,
  originalPrice: 249000,
  discountRate: 24,
  rating: 4.5,
  reviewCount: 1247,
  brand: '프리미엄',
  categoryName: '가전제품',
  productCount: 3,
  currentYear: 2026,
  description: '강력한 흡입력.',
  experienceIntro: '먼지 때문에 고민이 많았습니다.',
  realUsageStory: '2주간 매일 사용했습니다.',
  whyIChoseIt: '가벼워서 골랐습니다.',
  conclusion: '만족합니다.',
  oneLineReview: '가성비 좋음',
  pros: ['가벼움', '조용함'],
  cons: ['비쌈'],
  specs: { 무게: '1.2kg', 흡입력: '200W' },
  checklist: ['무게 확인', 'AS 정책'],
  buyingChecklist: ['무게 확인'],
  usageTips: ['필터를 주기적으로 청소'],
  targetAudience: ['1인 가구'],
  faqList: [{ question: '소음은?', answer: '조용합니다.' }],
  products: [
    { name: 'A', price: 10000, rating: 4.1, pros: ['좋음'], cons: ['무거움'] },
    { name: 'B', price: 20000, rating: 4.6, pros: ['가벼움'], cons: ['비쌈'] },
  ],
  comparisonTable: [{ name: 'A', price: '1만원' }],
  budgetRanges: [{ label: '10만원 이하', pick: 'A' }],
  budgetSteps: [{ label: '입문', desc: '저가형' }],
  recommendations: [{ title: '가성비', name: 'A' }],
  mistakesToAvoid: ['스펙만 보고 결정'],
  topPick: { name: 'A', reason: '가성비' },
  intro: '고르는 법을 정리합니다.',
  keywordInsight: {
    keyword: '무선청소기',
    trendLabel: '상승세',
    shoppingRatio: 72,
    relatedKeywords: ['차이슨', '샤오미'],
  },
  topPosts: [{ title: '다른 후기', link: 'https://example.com', bloggername: '블로거' }],
  sectionImages: {},
};

describe.each(templateFiles)('%s — 구조 체크리스트', (file) => {
  const raw = readFileSync(`${templatesDir}/${file}`, 'utf8');
  const body = splitRaw(raw).body;
  const bodyNoComments = stripComments(body);

  it('본문 섹션 이미지 슬롯(sectionImages.*)이 하나 이상 있다', () => {
    expect(/sectionImages\.\w+/.test(bodyNoComments)).toBe(true);
  });

  it('제휴 CTA(href="{{...affiliateUrl}}")는 모두 {{#if ...affiliateUrl}} 가드 안에 있다', () => {
    const hrefRe = /href="\{\{([^}]*affiliateUrl)\}\}"/g;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(bodyNoComments)) !== null) {
      const expr = m[1].trim();
      const before = bodyNoComments.slice(0, m.index);
      expect(before, `${expr} 가드 누락`).toContain(`{{#if ${expr}}}`);
    }
  });

  it('쿠팡 파트너스 고지 문구가 있다', () => {
    expect(bodyNoComments).toContain('쿠팡 파트너스 활동의 일환');
  });

  it('미구현 스텁 문구가 없다', () => {
    expect(body).not.toMatch(/향후 구현|구현 예정|준비\s*중|coming soon/i);
  });

  it('최소 데이터로 컴파일·렌더가 예외 없이 끝난다', () => {
    const html = Handlebars.compile(body)(SAMPLE);
    expect(html.trim().length).toBeGreaterThan(0);
    expect(html).not.toContain('href="#"');
  });
});
