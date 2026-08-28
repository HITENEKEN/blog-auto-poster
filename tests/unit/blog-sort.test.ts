import { describe, expect, it } from 'vitest';
import { sortByPostdateDesc } from '../../src/intelligence/NaverApiHubProvider';

type BlogItem = { title: string; postdate?: string };

describe('sortByPostdateDesc', () => {
  it('sorts valid postdates descending (newest first)', () => {
    const items: BlogItem[] = [
      { title: 'a', postdate: '20240101' },
      { title: 'b', postdate: '20250315' },
      { title: 'c', postdate: '20241231' },
    ];
    expect(sortByPostdateDesc(items).map((i) => i.title)).toEqual(['b', 'c', 'a']);
  });

  it('moves entries without a valid postdate to the end', () => {
    const items: BlogItem[] = [
      { title: 'no-date' },
      { title: 'empty', postdate: '' },
      { title: 'bad-format', postdate: '2024-01-01' },
      { title: 'valid', postdate: '20230601' },
    ];
    expect(sortByPostdateDesc(items).map((i) => i.title)).toEqual([
      'valid',
      'no-date',
      'empty',
      'bad-format',
    ]);
  });

  it('keeps relative order of invalid entries (stable sort)', () => {
    const items: BlogItem[] = [
      { title: 'first' },
      { title: 'valid', postdate: '20250101' },
      { title: 'second' },
      { title: 'third', postdate: undefined },
    ];
    expect(sortByPostdateDesc(items).map((i) => i.title)).toEqual([
      'valid',
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps relative order of entries sharing the same postdate', () => {
    const items: BlogItem[] = [
      { title: 'old-a', postdate: '20240101' },
      { title: 'same-b', postdate: '20240505' },
      { title: 'same-c', postdate: '20240505' },
    ];
    expect(sortByPostdateDesc(items).map((i) => i.title)).toEqual(['same-b', 'same-c', 'old-a']);
  });

  it('returns an empty array unchanged', () => {
    expect(sortByPostdateDesc([])).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const items: BlogItem[] = [
      { title: 'a', postdate: '20240101' },
      { title: 'b', postdate: '20250101' },
    ];
    const copy = [...items];
    sortByPostdateDesc(items);
    expect(items).toEqual(copy);
  });
});
