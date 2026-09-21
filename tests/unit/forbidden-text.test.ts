import { describe, expect, it } from 'vitest';
import {
  AD_TEXT_CODES,
  DRAFT_TEXT_CODES,
  findForbiddenTextCodes,
  FORBIDDEN_TEXT_CODES,
  FORBIDDEN_TEXT_RULES,
  forbiddenTextRules,
  matchesForbiddenText,
} from '../../src/content/ForbiddenText';
import { checkAdGate } from '../../src/content/AdGate';
import { findForbiddenPatterns } from '../../src/robot/policies';
import type { AdItem } from '../../src/content/AdTypes';

/**
 * 금지 문구 표의 단일 출처 (설계 §5-4).
 *
 * 이전에는 `AdTypes.FORBIDDEN_PATTERNS`와 `robot/policies.FORBIDDEN_PATTERNS`가
 * 서로 다른 정규식을 들고 있어, 같은 초안이 한쪽 게이트만 통과할 수 있었다.
 * 여기서는 표가 하나인지, 스코프 차이가 의도한 것뿐인지를 고정한다.
 */

/** 규칙별 검출 샘플 — 표의 union이 실제로 잡는지 확인하는 데 쓴다. */
const SAMPLES: Record<string, string[]> = {
  FIRST_PERSON: [
    '제가 직접 써봤습니다',
    '저는 이렇게 골랐어요',
    '저희가 비교했습니다',
    '내돈내산 후기',
    '신어봤어요',
    '사용해 봤습니다',
    '직접 구매했습니다',
  ],
  STUB_TEXT: ['향후 구현 예정입니다', '구현 예정', 'coming soon', '준비 중입니다'],
  PLACEHOLDER: ['⟦IMG1⟧ 자리', 'TODO: 채우기', 'FIXME', 'Lorem ipsum dolor'],
  UNSUPPORTED_PRICE: ['최저가 보장', '무조건 최저', '가격 보장', '100% 정품 보장'],
};

/** 이전 두 표에서 서로 어긋났던 표현들 — 통합 후 모두 잡혀야 한다. */
const PREVIOUSLY_DIVERGENT = [
  '저희가 정리했습니다',
  '내돈내산 후기',
  '신어봤어요',
  '사용해 봤어요',
  '⟦IMG7⟧',
  'FIXME',
  'Lorem ipsum',
  '100% 정품 보장',
  '가격 보장',
];

const ad = (id: string, text: string): AdItem => ({
  id,
  source: 'manual',
  kind: 'product-link',
  productName: text,
  url: `https://link.coupang.com/a/${id}`,
  keywords: ['트위드자켓'],
  status: 'active',
  usedCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const ADS_DISCLOSURE =
  '<p data-ad-source="auto" data-ad-disclosure="true">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>';

function marker(id: string, text: string): string {
  const props = encodeURIComponent(
    JSON.stringify({ url: `https://link.coupang.com/a/${id}`, text }),
  );
  return `<div data-coupang-widget="product-link" data-ad-source="auto" data-ad-id="${id}" data-ad-slot-kind="single" data-widget-props="${props}"></div>`;
}

function gateCodes(text: string): string[] {
  const html = `<div class="wrap">${ADS_DISCLOSURE}<h2>섹션</h2>${marker('ad-1', text)}</div>`;
  return checkAdGate(html, { slots: [], inventory: [ad('ad-1', text)] })
    .filter((v) => v.code === 'FORBIDDEN_TEXT')
    .map((v) => String((v.detail as { rule?: string })?.rule));
}

describe('ForbiddenText — 표 자체', () => {
  it('코드마다 정규식이 하나씩 있고 코드는 중복되지 않는다', () => {
    const codes = FORBIDDEN_TEXT_RULES.map((rule) => rule.code);
    expect(codes).toHaveLength(4);
    expect(new Set(codes).size).toBe(codes.length);
    for (const rule of FORBIDDEN_TEXT_RULES) {
      expect(rule.re).toBeInstanceOf(RegExp);
      expect(rule.code.length).toBeGreaterThan(0);
      // 상태를 들고 다니는 g 플래그는 금지 — 호출 순서에 따라 판정이 바뀐다.
      expect(rule.re.global).toBe(false);
    }
    expect(FORBIDDEN_TEXT_CODES).toEqual(codes);
  });

  it('코드는 로봇 메시지·테스트가 참조하는 4개로 고정한다', () => {
    expect([...FORBIDDEN_TEXT_CODES].sort()).toEqual([
      'FIRST_PERSON',
      'PLACEHOLDER',
      'STUB_TEXT',
      'UNSUPPORTED_PRICE',
    ]);
  });

  it('스코프: 초안 본문은 전부, 광고 문구는 가격 단정만 제외', () => {
    expect([...DRAFT_TEXT_CODES]).toEqual([...FORBIDDEN_TEXT_CODES]);
    expect([...AD_TEXT_CODES]).toEqual(['FIRST_PERSON', 'STUB_TEXT', 'PLACEHOLDER']);
  });
});

describe('ForbiddenText — 스코프별 검출', () => {
  it('초안 스코프는 규칙별 샘플을 모두 잡는다', () => {
    for (const code of FORBIDDEN_TEXT_CODES) {
      for (const sample of SAMPLES[code]) {
        expect(findForbiddenTextCodes(sample, DRAFT_TEXT_CODES), `${code}: ${sample}`).toContain(
          code,
        );
        expect(matchesForbiddenText(sample, DRAFT_TEXT_CODES)).toBe(true);
      }
    }
  });

  it('광고 스코프는 가격 단정을 제외한 샘플을 잡는다', () => {
    for (const code of AD_TEXT_CODES) {
      for (const sample of SAMPLES[code]) {
        expect(findForbiddenTextCodes(sample, AD_TEXT_CODES), `${code}: ${sample}`).toContain(code);
      }
    }
    // 판매자 상품명에 정당하게 들어가는 표현 — 광고 문구에서는 막지 않는다.
    for (const sample of SAMPLES.UNSUPPORTED_PRICE) {
      expect(findForbiddenTextCodes(sample, AD_TEXT_CODES)).toEqual([]);
      expect(matchesForbiddenText(sample, AD_TEXT_CODES)).toBe(false);
    }
  });

  it('예전에 두 표가 어긋났던 표현을 전부 잡는다', () => {
    for (const sample of PREVIOUSLY_DIVERGENT) {
      expect(findForbiddenTextCodes(sample, DRAFT_TEXT_CODES).length, sample).toBeGreaterThan(0);
    }
  });

  it('정상 문장은 통과한다', () => {
    const clean = '안감 있는 울 혼방을 고르고, 봉제선과 단추 마감을 확인하세요.';
    expect(findForbiddenTextCodes(clean, DRAFT_TEXT_CODES)).toEqual([]);
    expect(matchesForbiddenText(clean, AD_TEXT_CODES)).toBe(false);
    expect(findForbiddenTextCodes('', DRAFT_TEXT_CODES)).toEqual([]);
    expect(forbiddenTextRules(['FIRST_PERSON']).map((rule) => rule.code)).toEqual(['FIRST_PERSON']);
  });
});

describe('두 게이트가 같은 표를 본다', () => {
  it('초안 게이트(policies)와 광고 게이트가 같은 코드를 보고한다', () => {
    expect(findForbiddenPatterns('제가 직접 써봤습니다')).toEqual(['FIRST_PERSON']);
    expect(gateCodes('제가 직접 써봤습니다')).toEqual(['FIRST_PERSON']);
    // 예전 robots 표에 없던 표현도 초안 게이트가 잡는다(통합 확인).
    expect(findForbiddenPatterns('저희가 정리한 기준입니다')).toEqual(['FIRST_PERSON']);
    expect(findForbiddenPatterns('쓰레기 같은 문장')).toEqual([]);
  });

  it('광고 게이트는 가격 단정 상품명을 막지 않는다(스코프 차이만 다르다)', () => {
    expect(gateCodes('100% 정품 보장 트위드자켓')).toEqual([]);
    // 같은 문장을 초안 본문으로 보면 잡힌다 — 규칙 자체는 단일 표에 있다.
    expect(findForbiddenTextCodes('100% 정품 보장 트위드자켓', DRAFT_TEXT_CODES)).toEqual([
      'UNSUPPORTED_PRICE',
    ]);
  });

  it('호출부가 RegExp[]를 넘기면 그 규칙으로 판정한다(오버라이드 유지)', () => {
    const html = `<div class="wrap">${ADS_DISCLOSURE}<h2>섹션</h2>${marker('ad-1', '평범한 상품명')}</div>`;
    const violations = checkAdGate(html, {
      slots: [],
      inventory: [ad('ad-1', '평범한 상품명')],
      forbiddenPatterns: [/평범한/],
    });
    expect(violations.filter((v) => v.code === 'FORBIDDEN_TEXT')).toHaveLength(1);
    expect(JSON.stringify(violations)).toContain('CUSTOM_1');
  });
});
