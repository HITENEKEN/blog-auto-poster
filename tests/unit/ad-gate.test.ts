import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { checkAdGate, checkAdLinks, isCoupangHost } from '../../src/content/AdGate';
import { planAdSlots } from '../../src/content/AdPlacement';
import { ensureDisclosure } from '../../src/content/Disclosure';
import type { AdItem, AdSlot, RankedAd } from '../../src/content/AdTypes';

/**
 * 발행 전 광고 게이트 (설계 §3-6).
 *
 * 위반 코드마다 양성(위반을 잡는다)·음성(정상 배치는 통과한다) 케이스를 둔다.
 * 링크 검사는 fetcher 주입이라 실제 네트워크를 쓰지 않는다.
 */
const draft = readFileSync(
  fileURLToPath(new URL('../fixtures/post-25-draft.html', import.meta.url)),
  'utf8',
);

const ad = (id: string, over: Partial<AdItem> = {}): AdItem => ({
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
  ...over,
});

const IDS = ['ad-1', 'ad-2', 'ad-3', 'ad-4', 'ad-5'];
const inventory = IDS.map((id) => ad(id));
const ranked: RankedAd[] = inventory.map((item) => ({
  ad: item,
  score: 100,
  matchedBy: 'keyword' as const,
}));

/** 자동 배치 + 고지까지 끝난 정상 초안. */
function plannedDraft(): { html: string; slots: AdSlot[]; withoutDisclosure: string } {
  const plan = planAdSlots(draft, ranked);
  return {
    html: ensureDisclosure(plan.html, plan.slots.length > 0),
    slots: plan.slots,
    withoutDisclosure: ensureDisclosure(plan.html, false),
  };
}

const TOPIC = { keyword: '트위드자켓' };

/** 테스트용 마커 — 게이트가 보는 속성만 담는다. */
function marker(
  id: string,
  props: Record<string, string>,
  slotKind = 'single',
  extra = '',
): string {
  return `<div data-coupang-widget="product-link" data-ad-source="auto" data-ad-id="${id}" data-ad-slot-kind="${slotKind}" data-widget-props="${encodeURIComponent(JSON.stringify(props))}"${extra}></div>`;
}

const lead = '<p data-ad-source="auto" data-ad-bundle-lead="true">함께 비교해 볼 만한 상품</p>';
const disclosure =
  '<p data-ad-source="auto" data-ad-disclosure="true">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>';

describe('checkAdGate — 정상 배치', () => {
  it('#25 초안 배치 결과는 위반 0이다', () => {
    const { html, slots } = plannedDraft();
    expect(checkAdGate(html, { slots, inventory, topic: TOPIC })).toEqual([]);
  });
});

describe('checkAdGate — AD_COUNT', () => {
  it('계획한 블록 수와 실제가 다르면 위반', () => {
    const { html, slots } = plannedDraft();
    const codes = checkAdGate(html, {
      slots: slots.slice(0, 2),
      inventory,
      topic: TOPIC,
    }).map((v) => v.code);
    expect(codes).toContain('AD_COUNT');
  });

  it('상품 수가 최소 기준에 못 미치면 위반', () => {
    const html = `${disclosure}<div class="wrap"><p>본문</p>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}</div>`;
    const codes = checkAdGate(html, { slots: [], inventory, topic: TOPIC }).map((v) => v.code);
    expect(codes).toContain('AD_COUNT');
  });
});

describe('checkAdGate — DISCLOSURE_COUNT', () => {
  it('광고가 있는데 고지가 없으면 위반', () => {
    const { withoutDisclosure, slots } = plannedDraft();
    expect(
      checkAdGate(withoutDisclosure, { slots, inventory, topic: TOPIC }).map((v) => v.code),
    ).toContain('DISCLOSURE_COUNT');
  });

  it('광고가 있는데 고지가 2회면 위반', () => {
    const { html, slots } = plannedDraft();
    expect(
      checkAdGate(html + disclosure, { slots, inventory, topic: TOPIC }).map((v) => v.code),
    ).toContain('DISCLOSURE_COUNT');
  });

  it('광고가 없는데 고지가 있으면 위반', () => {
    const html = `${disclosure}<div class="wrap"><p>본문</p></div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).toContain(
      'DISCLOSURE_COUNT',
    );
  });
});

describe('checkAdGate — DISCLOSURE_POSITION', () => {
  it('고지가 네 번째 블록이면 위반', () => {
    const html = `<div class="wrap"><p>1</p><p>2</p><p>3</p>${disclosure}${lead}${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}${marker('ad-2', { url: 'https://link.coupang.com/a/ad-2', text: '상품' }, 'bundle')}</div>`;
    expect(checkAdGate(html, { slots: [], inventory, topic: TOPIC }).map((v) => v.code)).toContain(
      'DISCLOSURE_POSITION',
    );
  });

  it('고지가 첫 블록이면 위반이 아니다', () => {
    const { html, slots } = plannedDraft();
    expect(checkAdGate(html, { slots, inventory, topic: TOPIC }).map((v) => v.code)).not.toContain(
      'DISCLOSURE_POSITION',
    );
  });
});

describe('checkAdGate — AD_IN_TRAP / AD_AFTER_IMAGE / AD_ADJACENT', () => {
  it('마커가 li 안에 갇히면 위반', () => {
    const html = `<div class="wrap">${disclosure}<ul><li>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' }, 'bundle')}${marker('ad-2', { url: 'https://link.coupang.com/a/ad-2', text: '상품' }, 'bundle')}</li></ul></div>`;
    expect(checkAdGate(html, { slots: [], inventory, topic: TOPIC }).map((v) => v.code)).toContain(
      'AD_IN_TRAP',
    );
  });

  it('마커가 최상위 형제면 위반이 아니다', () => {
    const { html, slots } = plannedDraft();
    expect(checkAdGate(html, { slots, inventory, topic: TOPIC }).map((v) => v.code)).not.toContain(
      'AD_IN_TRAP',
    );
  });

  it('광고 바로 앞이 이미지면 위반', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2><figure><img src="x.png"></figure>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory, topic: TOPIC }).map((v) => v.code)).toContain(
      'AD_AFTER_IMAGE',
    );
  });

  it('블록 사이에 섹션 제목이 없으면 연속 광고로 본다', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2><p>본문</p>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}${marker('ad-2', { url: 'https://link.coupang.com/a/ad-2', text: '상품' })}<h2>다음</h2></div>`;
    expect(checkAdGate(html, { slots: [], inventory, topic: TOPIC }).map((v) => v.code)).toContain(
      'AD_ADJACENT',
    );
  });

  it('묶음 슬롯의 연속 마커는 연속 광고가 아니다', () => {
    const { html, slots } = plannedDraft();
    expect(slots.filter((s) => s.kind === 'bundle')[0].adIds.length).toBeGreaterThan(1);
    expect(checkAdGate(html, { slots, inventory, topic: TOPIC }).map((v) => v.code)).not.toContain(
      'AD_ADJACENT',
    );
  });
});

describe('checkAdGate — AD_URL_HOST / AD_IMAGE_URL / AD_UNKNOWN_ID / AD_IRRELEVANT', () => {
  it('허용되지 않은 링크 형식은 위반', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://example.com/a/1', text: '상품' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).toContain('AD_URL_HOST');
  });

  it('쿠팡 상품 URL과 파트너스 단축 링크는 통과한다', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://www.coupang.com/vp/products/123', text: '상품' })}${marker('ad-2', { url: 'https://link.coupang.com/a/ad-2', text: '상품' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).not.toContain(
      'AD_URL_HOST',
    );
  });

  it('이미지 URL이 http면 위반', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품', imageUrl: 'http://image8.coupangcdn.com/a.jpg' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).toContain(
      'AD_IMAGE_URL',
    );
  });

  it('인벤토리에 없는 소재 id는 위반', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-ghost', { url: 'https://link.coupang.com/a/ghost', text: '상품' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).toContain(
      'AD_UNKNOWN_ID',
    );
  });

  it('active가 아닌 소재는 위반', () => {
    const dead = [ad('ad-1', { status: 'dead' })];
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory: dead }).map((v) => v.code)).toContain(
      'AD_UNKNOWN_ID',
    );
  });

  it('주제와 무관한 소재가 배치되면 위반(관련성 게이트 §3-5)', () => {
    const unrelated = [ad('ad-1', { keywords: ['화장지'] })];
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}</div>`;
    expect(
      checkAdGate(html, { slots: [], inventory: unrelated, topic: TOPIC }).map((v) => v.code),
    ).toContain('AD_IRRELEVANT');
  });
});

describe('checkAdGate — LEFTOVER_MARKER / FORBIDDEN_TEXT', () => {
  it('채우지 못한 템플릿 슬롯·iframe·script 잔존은 위반', () => {
    const base = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '상품' })}</div>`;
    expect(
      checkAdGate(`${base}<div data-ad-slot="mid"></div>`, { slots: [], inventory }).map(
        (v) => v.code,
      ),
    ).toContain('LEFTOVER_MARKER');
    expect(
      checkAdGate(`${base}<iframe src="x"></iframe>`, { slots: [], inventory }).map((v) => v.code),
    ).toContain('LEFTOVER_MARKER');
    expect(
      checkAdGate(`${base}<script>new PartnersCoupang.G({})</script>`, {
        slots: [],
        inventory,
      }).map((v) => v.code),
    ).toContain('LEFTOVER_MARKER');
  });

  it('자동 문구에 1인칭 체험 표현이 있으면 위반', () => {
    const html = `<div class="wrap">${disclosure}<h2>섹션</h2>${marker('ad-1', { url: 'https://link.coupang.com/a/ad-1', text: '제가 직접 써봤어요' })}</div>`;
    expect(checkAdGate(html, { slots: [], inventory }).map((v) => v.code)).toContain(
      'FORBIDDEN_TEXT',
    );
  });

  it('상품명만 있는 자동 문구는 통과한다', () => {
    const { html, slots } = plannedDraft();
    expect(checkAdGate(html, { slots, inventory, topic: TOPIC }).map((v) => v.code)).not.toContain(
      'FORBIDDEN_TEXT',
    );
  });
});

describe('checkAdLinks — fetcher 주입 (설계 §3-7)', () => {
  it('첫 리다이렉트가 쿠팡이면 통과한다', async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      calls.push(url);
      return { status: 302, location: 'https://www.coupang.com/vp/products/123?itemId=9' };
    });
    const [check] = await checkAdLinks([ad('ad-1')], fetcher);
    expect(check).toMatchObject({ id: 'ad-1', ok: true, status: 302 });
    // 광고 1개당 요청 1회 — 상품 페이지까지 따라가지 않는다
    expect(calls).toEqual(['https://link.coupang.com/a/ad-1']);
  });

  it('쿠팡 밖으로 리다이렉트하면 실패한다', async () => {
    const [check] = await checkAdLinks([ad('ad-1')], async () => ({
      status: 302,
      location: 'https://example.com/not-coupang',
    }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('쿠팡 밖');
  });

  it('리다이렉트가 없으면 실패한다(봇 차단 페이지 등)', async () => {
    const [check] = await checkAdLinks([ad('ad-1')], async () => ({ status: 200 }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('리다이렉트');
  });

  it('4xx는 실패한다', async () => {
    const [check] = await checkAdLinks([ad('ad-1')], async () => ({ status: 404 }));
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('404');
  });

  it('요청이 던지면 실패로 기록한다', async () => {
    const [check] = await checkAdLinks([ad('ad-1')], async () => {
      throw new Error('ECONNRESET');
    });
    expect(check).toMatchObject({ ok: false, status: null });
    expect(check.reason).toContain('ECONNRESET');
  });

  it('쿠팡 서브도메인만 인정한다', () => {
    expect(isCoupangHost('https://www.coupang.com/vp/products/1')).toBe(true);
    expect(isCoupangHost('https://link.coupang.com/a/x')).toBe(true);
    expect(isCoupangHost('https://coupang.com.evil.io/x')).toBe(false);
    expect(isCoupangHost('not a url')).toBe(false);
  });
});
