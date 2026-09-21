import { describe, expect, it } from 'vitest';
import { isUsableAd, matchAds, normalizeKeyword } from '../../src/content/AdMatcher';
import type { AdItem } from '../../src/content/AdTypes';

/** 인벤토리 소재 팩토리 — 기본값은 active/미만료/사용 0회. */
const ad = (over: Partial<AdItem> = {}): AdItem => ({
  id: 'ad-1',
  source: 'manual',
  kind: 'product-link',
  productName: '트위드자켓',
  url: 'https://link.coupang.com/a/abc',
  keywords: ['트위드자켓'],
  status: 'active',
  usedCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

const NOW = new Date('2026-09-16T12:00:00.000Z');

describe('normalizeKeyword — 표기 변형 통일', () => {
  it('공백·특수문자·대소문자를 무시한다', () => {
    expect(normalizeKeyword('트위드 자켓')).toBe(normalizeKeyword('트위드자켓'));
    expect(normalizeKeyword('트위드-자켓')).toBe(normalizeKeyword('트위드자켓'));
    expect(normalizeKeyword(' Tweed Jacket ')).toBe('tweedjacket');
    expect(normalizeKeyword('')).toBe('');
  });
});

describe('matchAds — 점수와 정렬 (설계 §3-2)', () => {
  it('키워드 완전 일치가 100점이다', () => {
    const ranked = matchAds({ keyword: '트위드 자켓' }, [ad({ keywords: ['트위드자켓'] })], NOW);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].score).toBe(100);
    expect(ranked[0].matchedBy).toBe('keyword');
  });

  it('한쪽이 다른 쪽을 포함하면 70점이다', () => {
    const ranked = matchAds(
      { keyword: '가을 트위드자켓 코디' },
      [ad({ keywords: ['트위드자켓'] })],
      NOW,
    );
    expect(ranked[0].score).toBe(70);
  });

  it('카테고리 일치는 40점, 조상 카테고리 일치는 25점이다', () => {
    const inventory = [
      ad({ id: 'exact', keywords: [], categoryId: '50021279' }),
      ad({ id: 'ancestor', keywords: [], categoryId: '50000167' }),
    ];
    const ranked = matchAds(
      { keyword: '트위드자켓', categoryId: '50021279', categoryPath: ['50000000', '50000167'] },
      inventory,
      NOW,
    );
    expect(ranked.map((r) => [r.ad.id, r.score, r.matchedBy])).toEqual([
      ['exact', 40, 'category'],
      ['ancestor', 25, 'category'],
    ]);
  });

  it('점수가 0인 소재는 결과에서 제외한다(무관 상품 금지 — 이슈 #21)', () => {
    const ranked = matchAds(
      { keyword: '트위드자켓' },
      [ad({ id: 'irrelevant', keywords: ['화장지'], categoryId: 'other' })],
      NOW,
    );
    expect(ranked).toEqual([]);
  });

  it('active가 아니거나 만료된 소재는 제외한다', () => {
    const inventory = [
      ad({ id: 'active' }),
      ad({ id: 'dead', status: 'dead' }),
      ad({ id: 'expired', status: 'expired' }),
      ad({ id: 'removed', status: 'removed' }),
      ad({ id: 'stale', expiresAt: '2026-09-15T00:00:00.000Z' }),
      ad({ id: 'fresh', expiresAt: '2026-09-17T00:00:00.000Z' }),
    ];
    expect(matchAds({ keyword: '트위드자켓' }, inventory, NOW).map((r) => r.ad.id)).toEqual([
      'active',
      'fresh',
    ]);
    expect(isUsableAd(ad({ expiresAt: '2026-09-15T00:00:00.000Z' }), NOW)).toBe(false);
    expect(isUsableAd(ad({ expiresAt: '2026-09-17T00:00:00.000Z' }), NOW)).toBe(true);
  });

  it('동점이면 사용 횟수가 적은 순, 그다음 최근 생성 순이다', () => {
    const inventory = [
      ad({ id: 'used-twice', usedCount: 2, createdAt: '2026-09-10T00:00:00.000Z' }),
      ad({ id: 'fresh', usedCount: 0, createdAt: '2026-09-02T00:00:00.000Z' }),
      ad({ id: 'newest', usedCount: 0, createdAt: '2026-09-12T00:00:00.000Z' }),
      ad({ id: 'used-once', usedCount: 1, createdAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(matchAds({ keyword: '트위드자켓' }, inventory, NOW).map((r) => r.ad.id)).toEqual([
      'newest',
      'fresh',
      'used-once',
      'used-twice',
    ]);
  });

  it('점수가 높은 소재가 사용 횟수가 많아도 앞선다', () => {
    const inventory = [
      ad({ id: 'contains', keywords: ['트위드자켓 여성'], usedCount: 0 }),
      ad({ id: 'exact', keywords: ['트위드 자켓'], usedCount: 9 }),
    ];
    expect(matchAds({ keyword: '트위드자켓' }, inventory, NOW).map((r) => r.ad.id)).toEqual([
      'exact',
      'contains',
    ]);
  });
});
