import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createJobQueue } from '../../src/scheduler/JobQueue';
import type { JobQueueImpl } from '../../src/scheduler/JobQueue';

/**
 * 이슈 #24 2-1·2-3: published_posts 조회/삭제.
 * 인메모리 sqlite(:memory:)로 검증한다 — 파일 DB를 건드리지 않는다.
 */
describe('JobQueue.getPublishedPosts — 제목/날짜/페이지네이션', () => {
  let q: JobQueueImpl;

  const seed = (
    postId: string,
    title: string,
    publishedAt: string,
    extra: Partial<Parameters<JobQueueImpl['recordPublishedPost']>[0]> = {},
  ) =>
    q.recordPublishedPost({
      platform: 'naver',
      postId,
      url: `https://blog.naver.com/${postId}`,
      title,
      status: 'published',
      publishedAt,
      ...extra,
    });

  beforeEach(() => {
    q = createJobQueue(':memory:');
    seed('p1', '무선청소기 추천 후기', '2026-01-01T00:00:00.000Z');
    seed('p2', '로봇청소기 비교', '2026-02-01T00:00:00.000Z');
    seed('p3', 'AIR PURIFIER 리뷰', '2026-03-01T00:00:00.000Z');
    seed('p4', '커피머신 총정리', '2026-04-01T00:00:00.000Z');
    seed('p5', '무선 청소기 2탄', '2026-05-01T00:00:00.000Z');
  });

  afterEach(() => q.close());

  it('title 미지정 시 전체를 published_at 내림차순으로 반환한다', () => {
    const rows = q.getPublishedPosts();
    expect(rows.map((r) => r.post_id)).toEqual(['p5', 'p4', 'p3', 'p2', 'p1']);
  });

  it('title 부분일치 (한글)', () => {
    const rows = q.getPublishedPosts({ title: '청소기' });
    expect(rows.map((r) => r.post_id).sort()).toEqual(['p1', 'p2', 'p5']);
  });

  it('title 부분일치 (영문 대소문자는 sqlite LIKE 기본 규칙을 따른다 — ASCII는 대소문자 무시)', () => {
    expect(q.getPublishedPosts({ title: 'air purifier' }).map((r) => r.post_id)).toEqual(['p3']);
    expect(q.getPublishedPosts({ title: 'AIR' }).map((r) => r.post_id)).toEqual(['p3']);
  });

  it('fromDate/toDate 경계값을 포함한다 (>= / <=)', () => {
    const rows = q.getPublishedPosts({
      fromDate: '2026-02-01T00:00:00.000Z',
      toDate: '2026-04-01T00:00:00.000Z',
    });
    expect(rows.map((r) => r.post_id).sort()).toEqual(['p2', 'p3', 'p4']);
  });

  it('offset + limit 조합에서 2페이지가 1페이지와 다른 행을 돌려준다 (회귀)', () => {
    const page1 = q.getPublishedPosts({ limit: 2, offset: 0 });
    const page2 = q.getPublishedPosts({ limit: 2, offset: 2 });
    expect(page1.map((r) => r.post_id)).toEqual(['p5', 'p4']);
    expect(page2.map((r) => r.post_id)).toEqual(['p3', 'p2']);
    // 겹치는 행이 없어야 한다
    const overlap = page1.filter((r) => page2.some((x) => x.id === r.id));
    expect(overlap).toHaveLength(0);
  });

  it('deletePublishedPost는 해당 행만 지우고 나머지는 남긴다', () => {
    const target = q.getPublishedPostById('pub-naver-p3');
    expect(target).not.toBeNull();
    expect(q.deletePublishedPost('pub-naver-p3')).toBe(1);
    expect(q.getPublishedPostById('pub-naver-p3')).toBeNull();
    expect(
      q
        .getPublishedPosts()
        .map((r) => r.post_id)
        .sort(),
    ).toEqual(['p1', 'p2', 'p4', 'p5']);
    // 없는 id는 0
    expect(q.deletePublishedPost('pub-naver-nope')).toBe(0);
  });
});
