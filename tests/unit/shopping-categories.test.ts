import { describe, expect, it } from 'vitest';
import {
  buildShoppingBody,
  loadShoppingCategories,
  type ShoppingCategoryNode,
} from '../../src/web/server/routes/index';
import shoppingCategoriesJson from '../../src/web/shared/shoppingCategories.json';

/** 데이터랩 쇼핑인사이트 실측 코드표(2026-08) — 1~3분류 재귀 수집 + SHPP probe 검증.
 *  노드 수: 대분류 12 / 2분류 247 / 3분류 2,375. */
const KNOWN_MAJORS: ReadonlyArray<{ catId: string; name: string; subCount: number }> = [
  { catId: '50000000', name: '패션의류', subCount: 4 },
  { catId: '50000001', name: '패션잡화', subCount: 18 },
  { catId: '50000002', name: '화장품/미용', subCount: 13 },
  { catId: '50000003', name: '디지털/가전', subCount: 28 },
  { catId: '50000004', name: '가구/인테리어', subCount: 17 },
  { catId: '50000005', name: '출산/육아', subCount: 31 },
  { catId: '50000006', name: '식품', subCount: 28 },
  { catId: '50000007', name: '스포츠/레저', subCount: 32 },
  { catId: '50000008', name: '생활/건강', subCount: 34 },
  { catId: '50000009', name: '여가/생활편의', subCount: 10 },
  { catId: '50000010', name: '면세점', subCount: 7 },
  { catId: '50005542', name: '도서', subCount: 26 },
];

const bodyParams = (query: string) => ({
  query,
  category: '50000167',
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  timeUnit: 'date',
  device: '',
  gender: '',
  ages: [] as string[],
});

describe('shoppingCategories.json (R1 정적 코드표)', () => {
  it('배열 셰이프 — 각 노드는 catId/name 문자열이고 children은 재귀 셰이프를 따른다', () => {
    expect(Array.isArray(shoppingCategoriesJson)).toBe(true);
    const assertNode = (node: ShoppingCategoryNode) => {
      expect(typeof node.catId).toBe('string');
      expect(node.catId).toMatch(/^\d{8,9}$/);
      expect(typeof node.name).toBe('string');
      expect(node.name.length).toBeGreaterThan(0);
      node.children?.forEach(assertNode);
    };
    (shoppingCategoriesJson as ShoppingCategoryNode[]).forEach(assertNode);
  });

  it('같은 부모의 형제 노드끼리 cat_id 중복이 없다 (교차 등장은 허용)', () => {
    const assertSiblings = (nodes: ShoppingCategoryNode[]) => {
      const ids = new Set<string>();
      for (const n of nodes) {
        expect(ids.has(n.catId), `${n.catId} ${n.name} 형제 중복`).toBe(false);
        ids.add(n.catId);
      }
      return ids;
    };
    const walk = (nodes: ShoppingCategoryNode[]) => {
      assertSiblings(nodes);
      for (const n of nodes) {
        if (n.children) walk(n.children);
      }
    };
    walk(shoppingCategoriesJson as ShoppingCategoryNode[]);
  });

  it('공식 대분류 12종이 순서대로 존재하고 2분류 개수가 일치한다 (데이터랩 실측 코드표)', () => {
    const majors = shoppingCategoriesJson as ShoppingCategoryNode[];
    expect(majors).toHaveLength(KNOWN_MAJORS.length);
    majors.forEach((major, i) => {
      const known = KNOWN_MAJORS[i];
      expect(major.catId).toBe(known.catId);
      expect(major.name).toBe(known.name);
      expect(major.children, `${known.catId} children 누락`).toBeDefined();
      expect(major.children).toHaveLength(known.subCount);
    });
  });
});

describe('loadShoppingCategories (categories 라우트 소스)', () => {
  it('JSON 파일 내용을 그대로 노출한다', () => {
    expect(loadShoppingCategories()).toEqual(shoppingCategoriesJson);
  });

  it('모듈 레벨 캐시 — 호출마다 동일 참조(재로드/재파싱 없음)', () => {
    expect(loadShoppingCategories()).toBe(loadShoppingCategories());
  });
});

describe('buildShoppingBody keywords-device 분기 (R3)', () => {
  it('keyword를 문자열로 전송한다 — /category/keyword/device 계약', () => {
    const body = buildShoppingBody('keywords-device', bodyParams('여자 원피스'));
    expect(body.keyword).toBe('여자 원피스');
    expect(body.category).toBe('50000167');
    expect(body.startDate).toBe('2026-07-01');
    expect(body.endDate).toBe('2026-07-31');
    expect(body.timeUnit).toBe('date');
  });

  it('keywords-gender/keywords-ages와 동일 분기 — keyword 배열 형태가 아니다', () => {
    for (const criteria of ['keywords-gender', 'keywords-ages', 'keywords-device'] as const) {
      const body = buildShoppingBody(criteria, bodyParams('노트북'));
      expect(body.keyword).toBe('노트북');
      expect(Array.isArray(body.keyword)).toBe(false);
    }
  });

  it('선택적 필터는 값이 있을 때만 전송된다', () => {
    const body = buildShoppingBody('keywords-device', bodyParams('노트북'));
    expect('device' in body).toBe(false);
    expect('gender' in body).toBe(false);
    expect('ages' in body).toBe(false);
    const filtered = buildShoppingBody('keywords-device', {
      ...bodyParams('노트북'),
      device: 'pc',
      ages: ['20', '30'],
    });
    expect(filtered.device).toBe('pc');
    expect(filtered.ages).toEqual(['20', '30']);
    expect('gender' in filtered).toBe(false);
  });
});

describe('buildShoppingBody category 분기', () => {
  const catParams = {
    ...bodyParams(''),
    category: '50000000',
  };

  it('category를 [{name, param:[cat_id]}] 배열로 전송한다', () => {
    const body = buildShoppingBody('category', catParams);
    expect(body.category).toEqual([{ name: '50000000', param: ['50000000'] }]);
    expect('keyword' in body).toBe(false);
  });

  it('query가 있으면 name에 사용한다', () => {
    const body = buildShoppingBody('category', { ...catParams, query: '패션잡화' });
    expect(body.category).toEqual([{ name: '패션잡화', param: ['50000000'] }]);
  });

  it('query가 없으면 categoryName을 name으로 쓰고, 둘 다 없으면 cat_id로 대체한다', () => {
    const named = buildShoppingBody('category', { ...catParams, categoryName: '패션잡화' });
    expect(named.category).toEqual([{ name: '패션잡화', param: ['50000000'] }]);

    const unnamed = buildShoppingBody('category', { ...catParams, categoryName: '' });
    expect(unnamed.category).toEqual([{ name: '50000000', param: ['50000000'] }]);
  });
});
