import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createImageGenerator,
  generateImagesSafely,
  resolveGeminiImageConfig,
} from '../../src/content/ImageGenerator';
import { describe, expect, it } from 'vitest';
import {
  SECTION_IMAGE_KEYS,
  buildProductImagePrompts,
  buildSectionImageSpecs,
  buildSectionImageMap,
} from '../../src/content/imagePrompts';
import { TemplateEngineImpl } from '../../src/content/TemplateEngine';
import { createTemplateEngine } from '../../src/content/TemplateEngine';

describe('buildProductImagePrompts', () => {
  it('returns 2 base prompts, 3 with detail prompt when product name present', () => {
    const base = buildProductImagePrompts({ categoryName: '노트북' });
    expect(base).toHaveLength(2);

    const withProduct = buildProductImagePrompts({
      productName: '맥북 에어 M3',
      categoryName: '노트북',
      brand: 'Apple',
      options: ['스페이스 그레이', '16GB'],
    });
    expect(withProduct).toHaveLength(3);
  });

  it('includes product name and Korean blog style suffix in every prompt', () => {
    const prompts = buildProductImagePrompts({
      productName: '무선 청소기',
      categoryName: '가전',
    });
    for (const prompt of prompts) {
      expect(prompt).toContain('무선 청소기');
      expect(prompt).toContain('실사 사진');
      expect(prompt).toContain('한국 쇼핑 블로그');
    }
  });
});

describe('buildSectionImageSpecs', () => {
  it('uses default sections whose keys match SECTION_IMAGE_KEYS', () => {
    const specs = buildSectionImageSpecs({ productName: '공기청정기' });
    expect(specs.map((s) => s.key)).toEqual([...SECTION_IMAGE_KEYS]);
  });

  it('builds prompts from custom section titles and summaries', () => {
    const specs = buildSectionImageSpecs({
      productName: '공기청정기',
      sections: [{ key: 'usage', title: '직접 사용해 본 모습', summary: '거실에서 2주 사용' }],
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].key).toBe('usage');
    expect(specs[0].title).toBe('직접 사용해 본 모습');
    expect(specs[0].prompt).toContain('공기청정기');
    expect(specs[0].prompt).toContain('직접 사용해 본 모습');
    expect(specs[0].prompt).toContain('거실에서 2주 사용');
  });
});

describe('buildSectionImageMap', () => {
  it('zips paths to keys in order', () => {
    const map = buildSectionImageMap(['a.png', 'b.png'], ['usage', 'tips'] as const);
    expect(map).toEqual({ usage: 'a.png', tips: 'b.png' });
  });

  it('drops extra paths and leaves missing keys absent', () => {
    const map = buildSectionImageMap(['a.png'], SECTION_IMAGE_KEYS);
    expect(map).toEqual({ usage: 'a.png' });

    const overflow = buildSectionImageMap(['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png'], [
      'usage',
      'tips',
    ] as const);
    expect(overflow).toEqual({ usage: 'a.png', tips: 'b.png' });
  });

  it('returns empty map for no paths', () => {
    expect(buildSectionImageMap([])).toEqual({});
  });
});

describe('template sectionImages slots (R5)', () => {
  const engine: TemplateEngineImpl = createTemplateEngine('./templates');
  const baseData = {
    productName: '테스트 제품',
    price: 10000,
    pros: ['가성비'],
    cons: ['소음'],
    affiliateUrl: '#',
    experienceIntro: '도입',
    realUsageStory: '사용기',
    conclusion: '총평',
  };

  const load = async (name: string) => {
    await engine.loadTemplates();
    const info = engine.getTemplateInfo(name);
    if (!info) throw new Error(`template missing: ${name}`);
    for (const field of info.requiredFields) {
      if (!(field in baseData)) baseData[field] = `값-${field}`;
    }
  };

  // comparison-guide 템플릿이 쓰는 math 헬퍼는 서버(routes)가 전역 등록한다.
  engine.registerHelper('math', (a: number, op: string, b: number) => (op === '+' ? a + b : a));
  it('renders section-image figure when sectionImages injected (product-review)', async () => {
    await load('coupang-product-review');
    const result = await engine.render('coupang-product-review', {
      ...baseData,
      sectionImages: { usage: '/img/usage.png' },
    });
    expect(result.content).toContain('class="section-image"');
    expect(result.content).toContain('src="/img/usage.png"');
    // 주입되지 않은 키의 슬롯은 소멸
    expect(result.content).not.toContain('/img/tips');
  });

  it('renders specs slot inside the specs block when injected (naver-coupang-review)', async () => {
    await load('naver-coupang-review');
    const result = await engine.render('naver-coupang-review', {
      ...baseData,
      specs: { '연속 사용': '30분' },
      sectionImages: { specs: '/img/specs.png' },
    });
    expect(result.content).toContain('src="/img/specs.png"');
    // 주입되지 않은 usage/tips 슬롯은 소멸
    expect(result.content).not.toContain('/img/usage');
    expect(result.content).not.toContain('/img/tips');
  });

  it('drops all image slots when sectionImages absent (naver-coupang-review)', async () => {
    await load('naver-coupang-review');
    const result = await engine.render('naver-coupang-review', { ...baseData });
    expect(result.content).not.toContain('class="section-image"');
    expect(result.content).not.toContain('sectionImages');
  });

  it('renders compare slot in comparison-guide and checklist slot in buying-guide', async () => {
    await load('coupang-comparison-guide');
    const comparison = await engine.render('coupang-comparison-guide', {
      ...baseData,
      categoryName: '가전',
      productCount: 2,
      products: [
        { name: 'A', price: 10000, description: 'd', pros: ['p'], cons: ['c'], affiliateUrl: '#' },
      ],
      comparisonTable: { columns: ['A'], rows: [{ label: '가격', values: ['1만원'] }] },
      sectionImages: { compare: '/img/compare.png' },
    });
    expect(comparison.content).toContain('src="/img/compare.png"');

    await load('coupang-buying-guide');
    const guide = await engine.render('coupang-buying-guide', {
      ...baseData,
      categoryName: '가전',
      currentYear: 2026,
      checklist: [{ title: '체크', description: '내용' }],
      sectionImages: { checklist: '/img/checklist.png' },
    });
    expect(guide.content).toContain('src="/img/checklist.png"');
  });

  it('renders usage slot in partner-review', async () => {
    await load('coupang-partner-review');
    const result = await engine.render('coupang-partner-review', {
      ...baseData,
      oneLineReview: '한 줄평',
      sectionImages: { usage: '/img/usage2.png' },
    });
    expect(result.content).toContain('src="/img/usage2.png"');
  });
});

describe('generateImagesSafely — 실패 폴백 (A3)', () => {
  it('개별 프롬프트 실패 시 경고 후 건너뛰고 images 없이 반환한다', async () => {
    const generator = createImageGenerator('placeholder', mkdtempSync(join(tmpdir(), 'imgtest-')));
    generator.registerProvider('fail', {
      name: 'fail',
      generate: async () => {
        throw new Error('boom');
      },
      validateConfig: async () => false,
    });
    generator.setDefaultProvider('fail');

    const result = await generateImagesSafely(generator, [
      { prompt: '상품 프롬프트' },
      { key: 'usage', prompt: '섹션 프롬프트' },
    ]);

    expect(result.urls).toEqual([]);
    expect(result.localPaths).toEqual([]);
    expect(result.sectionImages).toEqual({});
  });
});

describe('resolveGeminiImageConfig — 게이팅', () => {
  it('test 설정(gemini enabled:false, 키 없음)에서는 null을 반환한다', () => {
    expect(resolveGeminiImageConfig()).toBeNull();
  });
});
