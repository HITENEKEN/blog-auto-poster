import { describe, expect, it } from 'vitest';
import {
  classifyTrend,
  isShoppingKeyword,
  peakRatio,
  pickShoppingCategory,
  scaleVolume,
  AGE_OPTIONS,
  resolvePresetRange,
  DEFAULT_SHOPPING_SIGNALS,
  daysInMonth,
  parseDateParts,
  toDateString,
  validateDateRange,
  monthRange,
  type TrendSeries,
} from '../../src/intelligence/TrendAnalysis';

const range = (from: number, to: number): number[] => {
  const out: number[] = [];
  for (let i = from; i <= to; i++) out.push(i);
  return out;
};

const series = (ratios: number[]): TrendSeries =>
  ratios.map((ratio, i) => ({ period: `2026-01-${String(i + 1).padStart(2, '0')}`, ratio }));

describe('classifyTrend', () => {
  it('classifies a rising series (recent 3 avg > +20% of older 9)', () => {
    expect(classifyTrend(series([...range(1, 9).map(() => 10), 50, 75, 100]))).toBe('rising');
  });

  it('classifies a falling series (recent 3 avg < -20% of older 9)', () => {
    expect(classifyTrend(series([100, 75, 50, ...range(1, 9).map(() => 10)]))).toBe('falling');
  });

  it('classifies a flat series as stable', () => {
    expect(classifyTrend(series(range(1, 12).map(() => 50)))).toBe('stable');
  });

  it('treats a series shorter than 4 points as stable', () => {
    expect(classifyTrend(series([1, 2, 3]))).toBe('stable');
  });

  it('treats older-all-zero with recent activity as rising', () => {
    expect(classifyTrend(series([...range(1, 9).map(() => 0), 10, 20, 30]))).toBe('rising');
  });
});

describe('scaleVolume', () => {
  it('scales the keyword peak against the anchor peak', () => {
    expect(scaleVolume(50, 100)).toBe(500);
  });

  it('gives the anchor itself a score of 1000', () => {
    expect(scaleVolume(100, 100)).toBe(1000);
  });

  it('falls back to peak×1000 when the anchor has no data', () => {
    expect(scaleVolume(42, 0)).toBe(42_000);
  });
});

describe('isShoppingKeyword', () => {
  it('matches default shopping signals', () => {
    expect(isShoppingKeyword('무선청소기 추천')).toBe(true);
    expect(isShoppingKeyword('다이슨 최저가')).toBe(true);
  });

  it('rejects non-shopping keywords', () => {
    expect(isShoppingKeyword('무선청소기')).toBe(false);
    expect(isShoppingKeyword('청소기 청소 방법')).toBe(false);
    expect(isShoppingKeyword('')).toBe(false);
  });

  it('honors custom signal lists', () => {
    expect(isShoppingKeyword('무선청소기', ['세제'])).toBe(false);
    expect(isShoppingKeyword('무선세제', ['세제'])).toBe(true);
    expect(DEFAULT_SHOPPING_SIGNALS.length).toBeGreaterThan(0);
  });
});

describe('pickShoppingCategory', () => {
  it('picks the category with the highest observed ratio', () => {
    expect(
      pickShoppingCategory([
        { name: 'a', category: '10000001', peakRatio: 12 },
        { name: 'b', category: '10000002', peakRatio: 88 },
        { name: 'c', category: '10000003', peakRatio: 40 },
      ]),
    ).toEqual({ name: 'b', category: '10000002', shoppingRatio: 88 });
  });

  it('returns null when no observation has data (graceful skip)', () => {
    expect(pickShoppingCategory([])).toBeNull();
    expect(
      pickShoppingCategory([
        { name: 'a', category: '1', peakRatio: 0 },
        { name: 'b', category: '2', peakRatio: 0 },
      ]),
    ).toBeNull();
  });
});

describe('peakRatio', () => {
  it('returns the max ratio and 0 for an empty series', () => {
    expect(peakRatio(series([3, 9, 1]))).toBe(9);
    expect(peakRatio([])).toBe(0);
  });
});

describe('AGE_OPTIONS', () => {
  it('has the 11 NAVER DataLab age codes with correct labels', () => {
    expect(AGE_OPTIONS).toHaveLength(11);
    expect(AGE_OPTIONS.map((o) => o.code)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
    ]);
    expect(AGE_OPTIONS.map((o) => o.label)).toEqual([
      '0-12세',
      '13-18세',
      '19-24세',
      '25-29세',
      '30-34세',
      '35-39세',
      '40-44세',
      '45-49세',
      '50-54세',
      '55-59세',
      '60세이상',
    ]);
  });
});

describe('resolvePresetRange', () => {
  // 고정 now: 2026-08-29 (토, 로컬 시간 기준)
  const now = new Date(2026, 7, 29, 15, 30, 0);

  it('today returns the same day for start and end', () => {
    expect(resolvePresetRange('today', now)).toEqual({
      startDate: '2026-08-29',
      endDate: '2026-08-29',
    });
  });

  it('yesterday returns the previous day only', () => {
    expect(resolvePresetRange('yesterday', now)).toEqual({
      startDate: '2026-08-28',
      endDate: '2026-08-28',
    });
  });

  it('last-7d spans today-6 through today', () => {
    expect(resolvePresetRange('last-7d', now)).toEqual({
      startDate: '2026-08-23',
      endDate: '2026-08-29',
    });
  });

  it('last-30d spans today-29 through today', () => {
    expect(resolvePresetRange('last-30d', now)).toEqual({
      startDate: '2026-07-31',
      endDate: '2026-08-29',
    });
  });

  it('crosses month and year boundaries correctly', () => {
    const newYear = new Date(2026, 0, 1, 0, 0, 0);
    expect(resolvePresetRange('last-7d', newYear)).toEqual({
      startDate: '2025-12-26',
      endDate: '2026-01-01',
    });
    expect(resolvePresetRange('yesterday', newYear)).toEqual({
      startDate: '2025-12-31',
      endDate: '2025-12-31',
    });
  });
});

describe('daysInMonth', () => {
  it('returns 29 for leap-year February', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29); // 400-year leap
  });

  it('returns 28 for non-leap February including century non-leap', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28); // 100-year non-leap
  });

  it('returns 30/31 for regular months', () => {
    expect(daysInMonth(2026, 1)).toBe(31);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });
});

describe('parseDateParts', () => {
  it('parses a valid yyyy-mm-dd string', () => {
    expect(parseDateParts('2026-08-29')).toEqual({ y: 2026, m: 8, d: 29 });
  });

  it('accepts leap-year Feb 29 and rejects Feb 30', () => {
    expect(parseDateParts('2024-02-29')).toEqual({ y: 2024, m: 2, d: 29 });
    expect(parseDateParts('2026-02-29')).toBeNull();
    expect(parseDateParts('2026-02-30')).toBeNull();
  });

  it('rejects month/day out of range', () => {
    expect(parseDateParts('2026-13-01')).toBeNull();
    expect(parseDateParts('2026-00-10')).toBeNull();
    expect(parseDateParts('2026-08-00')).toBeNull();
    expect(parseDateParts('2026-08-32')).toBeNull();
  });

  it('rejects malformed formats (leading zeros, separators, empty)', () => {
    expect(parseDateParts('2026-8-9')).toBeNull();
    expect(parseDateParts('2026/08/29')).toBeNull();
    expect(parseDateParts('20260829')).toBeNull();
    expect(parseDateParts('')).toBeNull();
  });
});

describe('toDateString', () => {
  it('rebuilds a zero-padded yyyy-mm-dd string', () => {
    expect(toDateString({ y: 2026, m: 8, d: 29 })).toBe('2026-08-29');
    expect(toDateString({ y: 2026, m: 1, d: 5 })).toBe('2026-01-05');
  });

  it('round-trips with parseDateParts', () => {
    expect(toDateString(parseDateParts('2024-02-29')!)).toBe('2024-02-29');
  });
});

describe('validateDateRange', () => {
  it('accepts ordered and equal dates', () => {
    expect(validateDateRange('2026-08-01', '2026-08-29')).toBe(true);
    expect(validateDateRange('2026-08-29', '2026-08-29')).toBe(true);
  });

  it('rejects reversed order', () => {
    expect(validateDateRange('2026-08-29', '2026-08-01')).toBe(false);
    expect(validateDateRange('2027-01-01', '2026-12-31')).toBe(false);
  });

  it('rejects invalid formats or impossible dates on either side', () => {
    expect(validateDateRange('2026-02-30', '2026-08-29')).toBe(false);
    expect(validateDateRange('2026-08-01', 'not-a-date')).toBe(false);
    expect(validateDateRange('', '')).toBe(false);
  });
});

describe('monthRange', () => {
  it('returns a zero-padded yyyy-mm-dd window of N months', () => {
    expect(monthRange(12, new Date(2026, 7, 29))).toEqual({
      startDate: '2025-08-29',
      endDate: '2026-08-29',
    });
    expect(monthRange(1, new Date(2026, 2, 31))).toEqual({
      // 3/31 - 1개월 = 2/31 → Date가 3/3으로 넘어가는 JS 동작을 그대로 반영한다
      startDate: '2026-03-03',
      endDate: '2026-03-31',
    });
  });

  it('defaults `now` to the current date', () => {
    const { startDate, endDate } = monthRange(12);
    expect(parseDateParts(endDate)).not.toBeNull();
    expect(parseDateParts(startDate)).not.toBeNull();
    expect(startDate < endDate).toBe(true);
  });
});
