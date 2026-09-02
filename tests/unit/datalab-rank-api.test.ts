import { describe, expect, it } from 'vitest';
import {
  buildRankFormParams,
  parseDatalabRankPayload,
  type DatalabRankQuery,
} from '../../src/intelligence/DatalabShoppingRank';

const baseQuery: DatalabRankQuery = {
  catId: '50000809',
  startDate: '2026-03-01',
  endDate: '2026-08-30',
  timeUnit: 'month',
};

describe('buildRankFormParams — 데이터랩 랭킹 form 파라미터(이슈 #14)', () => {
  it('필수 필드(cid/기간/timeUnit)를 채운다', () => {
    const p = buildRankFormParams(baseQuery);
    expect(p.get('cid')).toBe('50000809');
    expect(p.get('startDate')).toBe('2026-03-01');
    expect(p.get('endDate')).toBe('2026-08-30');
    expect(p.get('timeUnit')).toBe('month');
    expect(p.get('page')).toBe('1');
  });

  it('다중 연령을 콤마 조인한다(내부 API 스펙: age=20,30)', () => {
    const p = buildRankFormParams({ ...baseQuery, ages: ['20', '30'] });
    expect(p.get('age')).toBe('20,30');
  });

  it('미지정 필터는 빈 문자열로 전송한다(내부 API 스펙)', () => {
    const p = buildRankFormParams(baseQuery);
    expect(p.get('age')).toBe('');
    expect(p.get('gender')).toBe('');
    expect(p.get('device')).toBe('');
  });

  it('count는 1~20으로 클램프한다(페이지당 20개 상한)', () => {
    expect(buildRankFormParams({ ...baseQuery, count: 5 }).get('count')).toBe('5');
    expect(buildRankFormParams({ ...baseQuery, count: 100 }).get('count')).toBe('20');
    expect(buildRankFormParams({ ...baseQuery, count: 0 }).get('count')).toBe('1');
  });

  it('같은 조건이면 동일한 캐시 키(params 문자열)가 만들어진다', () => {
    const a = buildRankFormParams({ ...baseQuery, device: 'mo', ages: ['10'] });
    const b = buildRankFormParams({ ...baseQuery, device: 'mo', ages: ['10'] });
    expect(a.toString()).toBe(b.toString());
    const c = buildRankFormParams({ ...baseQuery, device: 'pc' });
    expect(a.toString()).not.toBe(c.toString());
  });
});

describe('parseDatalabRankPayload — 데이터랩 랭킹 응답 파서(이슈 #14)', () => {
  it('ranks 배열을 DatalabRankRow로 매핑한다', () => {
    const rows = parseDatalabRankPayload({
      statusCode: 200,
      returnCode: 0,
      range: '2026.03.01. ~ 2026.08.30.',
      ranks: [
        { rank: 1, keyword: '청바지', linkId: '청바지' },
        { rank: 2, keyword: '여자청반바지', linkId: '여자청반바지' },
      ],
    });
    expect(rows).toEqual([
      { rank: 1, keyword: '청바지', linkId: '청바지' },
      { rank: 2, keyword: '여자청반바지', linkId: '여자청반바지' },
    ]);
  });

  it('빈 ranks(무효 분야)는 빈 배열을 반환한다', () => {
    expect(parseDatalabRankPayload({ statusCode: 200, ranks: [] })).toEqual([]);
  });

  it('keyword가 없는/빈 항목은 건너뛰고 rank 누락은 순번으로 채운다', () => {
    const rows = parseDatalabRankPayload({
      statusCode: 200,
      ranks: [
        { rank: 1, keyword: '청바지' },
        { rank: 2, keyword: '' },
        { rank: 3 },
        { keyword: '게스청바지' },
      ],
    });
    expect(rows).toEqual([
      { rank: 1, keyword: '청바지' },
      { rank: 2, keyword: '게스청바지' },
    ]);
  });

  it('HTML 에러 페이지(개편/접속제한)는 throw한다', () => {
    expect(() => parseDatalabRankPayload('<!DOCTYPE html>페이지를 찾을 수 없습니다')).toThrow();
    expect(() => parseDatalabRankPayload(null)).toThrow();
  });

  it('statusCode가 200이 아니면 throw한다', () => {
    expect(() => parseDatalabRankPayload({ statusCode: 500, ranks: [] })).toThrow('statusCode 500');
  });
});
