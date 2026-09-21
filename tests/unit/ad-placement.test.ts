import * as cheerio from 'cheerio';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planAdSlots, stripAutoAds } from '../../src/content/AdPlacement';
import type { AdItem, RankedAd } from '../../src/content/AdTypes';

/**
 * 섹션 경계 광고 배치 고정 (설계 §3-3).
 *
 * #25 초안 사본(`tests/fixtures/post-25-draft.html`, h2 10개)에 대한 결과를
 * 유닛 테스트 기대값으로 못박는다 — 알고리즘이 흔들리면 이 테스트가 먼저 깨진다.
 */
const draft = readFileSync(
  fileURLToPath(new URL('../fixtures/post-25-draft.html', import.meta.url)),
  'utf8',
);

const ad = (id: string): AdItem => ({
  id,
  source: 'manual',
  kind: 'product-link',
  productName: `트위드자켓 상품 ${id}`,
  url: `https://link.coupang.com/a/${id}`,
  imageUrl: `https://image8.coupangcdn.com/${id}.jpg`,
  keywords: ['트위드자켓'],
  status: 'active',
  usedCount: 0,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
});

const ranked = (ids: string[]): RankedAd[] =>
  ids.map((id) => ({ ad: ad(id), score: 100, matchedBy: 'keyword' as const }));

const IDS = ['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5', 'ad-6'];

const section = (title: string, body = '<p>본문 내용</p>'): string => `<h2>${title}</h2>${body}`;

describe('planAdSlots — #25 초안 고정 결과', () => {
  const plan = planAdSlots(draft, ranked(IDS));

  it('#3 뒤 단일 · #5 뒤 단일 · #9 뒤 묶음(3개)', () => {
    expect(plan.slots.map((s) => [s.kind, s.afterSection])).toEqual([
      ['single', 3],
      ['single', 5],
      ['bundle', 9],
    ]);
    expect(plan.slots[0].adIds).toEqual(['ad-1']);
    expect(plan.slots[1].adIds).toEqual(['ad-2']);
    expect(plan.slots[2].adIds).toEqual(['ad-3', 'ad-4', 'ad-5']);
    // §9 "구매 전 마지막 점검" 뒤, §10 "자주 묻는 질문" 앞
    expect(plan.slots[2].sectionTitle).toBe('구매 전 마지막 점검');
  });

  it('§6 참고 자료 섹션은 후보에서 빠진다', () => {
    expect(plan.notes.join('\n')).toContain('참고하면 좋은 공개 자료');
    expect(plan.slots.every((s) => s.sectionTitle !== '참고하면 좋은 공개 자료')).toBe(true);
  });

  it('마커가 다음 섹션 heading 직전에 들어간다(§3·§5·§9 끝)', () => {
    const $ = cheerio.load(plan.html);
    const single = (id: string) => $(`[data-ad-id="${id}"]`);
    // 단일 광고 1: §3 끝 = §4 "어떤 기준이 실패를 줄여주나" 직전
    expect(single('ad-1').attr('data-ad-slot-kind')).toBe('single');
    expect(single('ad-1').next().is('h2')).toBe(true);
    expect(single('ad-1').next().text()).toBe('어떤 기준이 실패를 줄여주나');
    // 단일 광고 2: §5 끝 = §6 "참고하면 좋은 공개 자료" 직전
    expect(single('ad-2').next().text()).toBe('참고하면 좋은 공개 자료');
    // 묶음: §9 "구매 전 마지막 점검" 뒤 · §10 FAQ 앞
    const bundleAds = $('[data-ad-slot-kind="bundle"]');
    expect(bundleAds).toHaveLength(3);
    expect($('[data-ad-bundle-lead="true"]').next().attr('data-ad-slot-kind')).toBe('bundle');
    expect(bundleAds.last().next().is('h2')).toBe(true);
    expect(bundleAds.last().next().text()).toBe('자주 묻는 질문');
  });

  it('두 번 적용해도 한 번 적용한 것과 같다(멱등)', () => {
    const again = planAdSlots(plan.html, ranked(IDS));
    expect(again.html).toBe(plan.html);
    expect(again.slots).toEqual(plan.slots);
  });

  it('묶음 앞에는 고정 문구 1줄만 둔다', () => {
    const lead = plan.html.match(/data-ad-bundle-lead="true"/g) ?? [];
    expect(lead).toHaveLength(1);
    expect(plan.html).toContain('함께 비교해 볼 만한 상품');
  });

  it('사용자가 직접 넣은 위젯 마커는 그대로 남는다', () => {
    const userMarker =
      '<div data-coupang-widget="event-link" data-widget-props="%7B%22url%22%3A%22https%3A%2F%2Flink.coupang.com%2Fa%2Fuser%22%7D"></div>';
    const html = `${userMarker}${draft}`;
    const placed = planAdSlots(html, ranked(IDS));
    expect(placed.html).toContain('data-coupang-widget="event-link"');
    expect(placed.html).toContain('link.coupang.com%2Fa%2Fuser');
    expect(stripAutoAds(placed.html)).toContain('data-coupang-widget="event-link"');
  });
});

describe('planAdSlots — 경계 조건', () => {
  it('소재가 2개면 단일 광고 없이 묶음만 만든다', () => {
    const plan = planAdSlots(draft, ranked(['ad-1', 'ad-2']));
    expect(plan.slots.map((s) => [s.kind, s.afterSection])).toEqual([['bundle', 9]]);
    expect(plan.slots[0].adIds).toEqual(['ad-1', 'ad-2']);
    expect(plan.html).not.toContain('data-ad-slot-kind="single"');
  });

  it('소재가 없으면 아무것도 배치하지 않는다', () => {
    const plan = planAdSlots(draft, []);
    expect(plan.slots).toEqual([]);
    expect(plan.html).toBe(draft);
  });

  it('h2가 없으면 본문 끝에 묶음 1개만 둔다', () => {
    const html = '<div class="wrap"><p>본문 1</p><p>본문 2</p></div>';
    const plan = planAdSlots(html, ranked(['ad-1', 'ad-2', 'ad-3', 'ad-4']));
    expect(plan.slots.map((s) => [s.kind, s.afterSection])).toEqual([['bundle', 0]]);
    expect(plan.slots[0].adIds).toEqual(['ad-1', 'ad-2', 'ad-3']);
    expect(plan.html).toContain('함께 비교해 볼 만한 상품');
    // 래퍼 안쪽, 문서 끝에 붙는다
    expect(plan.html.indexOf('data-ad-id="ad-1"')).toBeLessThan(plan.html.lastIndexOf('</div>'));
  });

  it('마지막 블록이 이미지인 섹션은 후보에서 빠진다', () => {
    const html = [
      section('첫 섹션'),
      section('이미지로 끝나는 섹션', '<figure><img src="x.png"></figure>'),
      section('마지막 섹션'),
    ].join('');
    const plan = planAdSlots(html, ranked(['ad-1', 'ad-2', 'ad-3']));
    expect(plan.notes.join('\n')).toContain('이미지로 끝나는 섹션');
    expect(plan.slots.map((s) => s.kind)).toEqual(['bundle']);
    expect(plan.slots[0].afterSection).toBe(3);
  });

  it('참고/출처 섹션은 후보에서 빠지고 다음 후보가 선택된다', () => {
    const html = [
      section('도입'),
      section('참고 자료'),
      section('본문 A'),
      section('본문 B'),
      section('본문 C'),
      section('마무리'),
    ].join('');
    const plan = planAdSlots(html, ranked(['ad-1', 'ad-2', 'ad-3']));
    expect(plan.notes.join('\n')).toContain('참고 자료');
    // 참고 섹션이 후보에 남아 있었다면 §3이 선택된다 — §4가 선택되어야 한다.
    expect(plan.slots[0].afterSection).toBe(4);
  });

  it('광고 간격이 모자라면 단일 광고를 버리고 상품을 묶음으로 넘긴다', () => {
    // 6개 섹션: 후보는 §2~§5뿐이고, minSectionGap=2를 만족하려면 서로 2칸 이상 떨어져야 한다.
    const html = [
      section('도입'),
      section('본문 A'),
      section('본문 B'),
      section('본문 C'),
      section('자주 묻는 질문'),
      section('본문 D'),
    ].join('');
    const plan = planAdSlots(html, ranked(IDS));
    const singles = plan.slots.filter((s) => s.kind === 'single');
    for (let i = 1; i < singles.length; i += 1) {
      expect(singles[i].afterSection - singles[i - 1].afterSection).toBeGreaterThanOrEqual(2);
    }
    // 안전 여유(앵커는 FAQ 직전 §0 → §4)
    expect(plan.slots[plan.slots.length - 1].kind).toBe('bundle');
  });

  it('같은 소재를 두 번 넣지 않는다', () => {
    const duplicated = [...ranked(['ad-1', 'ad-1']), ...ranked(['ad-2', 'ad-3'])];
    const plan = planAdSlots(draft, duplicated);
    const placed = plan.slots.flatMap((s) => s.adIds);
    expect(new Set(placed).size).toBe(placed.length);
  });
});
