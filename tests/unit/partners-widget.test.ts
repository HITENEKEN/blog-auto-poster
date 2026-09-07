import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WIDGET_CARD_LIMIT,
  PARTNERS_WIDGETS_ENDPOINT,
  buildPartnersWidgetUrl,
  fetchPartnersWidgetCards,
  parsePartnersWidgetPayload,
} from '../../src/content/PartnersWidget';

/** 실측 fixtures — ads-partners.coupang.com/widgets.html 실제 응답(이슈 #20 T2) */
const FIXTURE = fs.readFileSync(
  fileURLToPath(new URL('../fixtures/partners-widget-carousel.html', import.meta.url)),
  'utf-8',
);

describe('parsePartnersWidgetPayload — 실측 위젯 페이로드 파싱(이슈 #20 T2)', () => {
  it('실제 응답에서 상품을 파싱한다(중첩 JSON도 잘리지 않는다)', () => {
    const items = parsePartnersWidgetPayload(FIXTURE);
    // 실측: 19개 아이템 중 15개가 productId를 가진다(나머지는 쿠팡 홈 광고)
    expect(items.length).toBe(15);
    expect(items.every((i) => typeof i.productId === 'number')).toBe(true);
  });

  it('productId가 없는 쿠팡 홈 광고 아이템은 제외한다', () => {
    const items = parsePartnersWidgetPayload(FIXTURE);
    // 첫 아이템은 "쿠팡은 로켓배송" 홈 광고(productId 없음) — 카드화 불가
    expect(items.some((i) => i.name === '쿠팡은 로켓배송')).toBe(false);
    expect(items.every((i) => i.name.length > 0)).toBe(true);
  });

  it('imageUrl은 페이로드의 coupangCdnBaseUrl로 조립한 절대 URL이다(하드코딩 금지)', () => {
    const items = parsePartnersWidgetPayload(FIXTURE);
    const base = /"coupangCdnBaseUrl":\s*"([^"]+)"/.exec(FIXTURE)?.[1] ?? '';
    expect(base).not.toBe('');
    for (const item of items) {
      expect(item.imageUrl.startsWith(base)).toBe(true);
      expect(item.imageUrl).toMatch(/^https?:\/\//);
      expect(item.imageUrl).not.toContain('//image/');
    }
  });

  it('가격/할인율/랜딩 URL을 그대로 실어 파트너스 트래킹을 보존한다', () => {
    const items = parsePartnersWidgetPayload(FIXTURE);
    const priced = items.find((i) => typeof i.salesPrice === 'number');
    expect(priced).toBeDefined();
    expect(priced!.landingUrl).toContain('lptag=');
    expect(priced!.landingUrl).toMatch(/^https:\/\/link\.coupang\.com\//);
    expect(priced!.salesPrice).toBeGreaterThan(0);
  });

  it('형식이 맞지 않거나 빈 입력은 []를 반환한다(던지지 않는다)', () => {
    expect(parsePartnersWidgetPayload('')).toEqual([]);
    expect(parsePartnersWidgetPayload('<html><body>no widget</body></html>')).toEqual([]);
    expect(
      parsePartnersWidgetPayload('new PartnersCoupang.Carousel("#container", {broken'),
    ).toEqual([]);
    expect(parsePartnersWidgetPayload('new PartnersCoupang.Carousel("#container")')).toEqual([]);
  });

  it('문자열 리터럴 안의 중괄호에 속지 않는다', () => {
    const html =
      '<script>new PartnersCoupang.Carousel("#container", {"items":[{"productId":7,"name":"a{b}c","imagePath":"p.png","landingUrl":"https://l"}],"config":{"coupangCdnBaseUrl":"https://cdn.example.com/"}});</script>';
    const items = parsePartnersWidgetPayload(html);
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('a{b}c');
    expect(items[0].imageUrl).toBe('https://cdn.example.com/p.png');
  });

  it('config.coupangCdnBaseUrl이 없어도 상품을 반환한다(imageUrl은 상대경로)', () => {
    const html =
      'new PartnersCoupang.Carousel("#container", {"items":[{"productId":1,"name":"x","imagePath":"img/a.png","landingUrl":"https://l"}]});';
    const items = parsePartnersWidgetPayload(html);
    expect(items).toHaveLength(1);
    expect(items[0].imageUrl).toBe('/img/a.png');
  });
});

describe('buildPartnersWidgetUrl — 위젯 문서 URL 조립(이슈 #20 T2)', () => {
  it('id/trackingCode/subId/template/width/height를 쿼리로 싣는다', () => {
    const url = buildPartnersWidgetUrl({
      id: 1022164,
      trackingCode: 'AF8963794',
      subId: 'sub1',
      template: 'carousel',
      width: 680,
      height: 140,
    });
    expect(url).toBe(
      `${PARTNERS_WIDGETS_ENDPOINT}?id=1022164&trackingCode=AF8963794&subId=sub1&template=carousel&width=680&height=140`,
    );
  });

  it('subId가 null/빈 문자열이면 생략한다', () => {
    expect(buildPartnersWidgetUrl({ id: 1, trackingCode: 'AF', subId: null })).toBe(
      `${PARTNERS_WIDGETS_ENDPOINT}?id=1&trackingCode=AF`,
    );
    expect(buildPartnersWidgetUrl({ id: 1, trackingCode: 'AF', subId: '' })).toBe(
      `${PARTNERS_WIDGETS_ENDPOINT}?id=1&trackingCode=AF`,
    );
    expect(buildPartnersWidgetUrl({ id: 1, trackingCode: 'AF', subId: 'null' })).toBe(
      `${PARTNERS_WIDGETS_ENDPOINT}?id=1&trackingCode=AF`,
    );
  });

  it('id/trackingCode가 없으면 null을 반환한다', () => {
    expect(buildPartnersWidgetUrl({ trackingCode: 'AF' })).toBeNull();
    expect(buildPartnersWidgetUrl({ id: 1 })).toBeNull();
    expect(buildPartnersWidgetUrl({})).toBeNull();
    expect(buildPartnersWidgetUrl({ id: '', trackingCode: 'AF' })).toBeNull();
  });
});

describe('fetchPartnersWidgetCards — 실제 상품 카드 생성(이슈 #20 T2)', () => {
  const params = { id: 1022164, trackingCode: 'AF8963794', template: 'carousel' };

  it('기본 3장(DEFAULT_WIDGET_CARD_LIMIT)의 상품 카드를 만든다', async () => {
    expect(DEFAULT_WIDGET_CARD_LIMIT).toBe(3);
    const cards = await fetchPartnersWidgetCards(params, undefined, async () => FIXTURE);
    expect(cards).toHaveLength(DEFAULT_WIDGET_CARD_LIMIT);
  });

  it('카드는 인라인 스타일 상품 카드(buildProductPreviewCard 산출)다 — iframe/script 없음', async () => {
    const cards = await fetchPartnersWidgetCards(params, 2, async () => FIXTURE);
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toContain('<div style=');
      expect(card).not.toContain('<iframe');
      expect(card).not.toContain('<script');
      expect(card).toContain('rel="nofollow sponsored"');
    }
  });

  it('카드 링크는 위젯 아이템의 landingUrl이라 파트너스 트래킹이 보존된다', async () => {
    const items = parsePartnersWidgetPayload(FIXTURE).slice(0, 1);
    const cards = await fetchPartnersWidgetCards(params, 1, async () => FIXTURE);
    // buildProductPreviewCard는 href의 &를 &amp;로 이스케이프한다(정상 동작)
    const escaped = items[0].landingUrl.replace(/&/g, '&amp;');
    expect(cards[0]).toContain(`href="${escaped}"`);
    expect(cards[0]).toContain('lptag=AF8963794');
    // productId/pageKey까지 실려 상품 지향 트래킹이 유지된다
    expect(cards[0]).toContain(`pageKey=${items[0].productId}`);
  });

  it('상품명/가격/할인율을 카드에 담는다', async () => {
    const items = parsePartnersWidgetPayload(FIXTURE)[0];
    const cards = await fetchPartnersWidgetCards(params, 1, async () => FIXTURE);
    expect(cards[0]).toContain(items.name);
    expect(cards[0]).toContain(items.imageUrl);
    if (items.salesPrice != null) {
      expect(cards[0]).toContain(`${items.salesPrice.toLocaleString('ko-KR')}원`);
    }
  });

  it('limit을 넘기면 그 수만큼만 반환한다', async () => {
    expect(await fetchPartnersWidgetCards(params, 5, async () => FIXTURE)).toHaveLength(5);
    expect(await fetchPartnersWidgetCards(params, 1, async () => FIXTURE)).toHaveLength(1);
  });

  it('payload에 상품이 없으면 []를 반환한다(홈 광고만 있는 위젯)', async () => {
    const onlyHomeAd =
      'new PartnersCoupang.Carousel("#container", {"items":[{"name":"쿠팡은 로켓배송","imagePath":"a.png","landingUrl":"https://l"}],"config":{"coupangCdnBaseUrl":"https://c/"}});';
    expect(await fetchPartnersWidgetCards(params, undefined, async () => onlyHomeAd)).toEqual([]);
  });

  it('네트워크 실패 시 []를 반환한다 — 발행이 막히지 않는다', async () => {
    const cards = await fetchPartnersWidgetCards(params, undefined, async () => {
      throw new Error('ETIMEDOUT');
    });
    expect(cards).toEqual([]);
  });

  it('빈 응답/깨진 응답에서도 []를 반환한다', async () => {
    expect(await fetchPartnersWidgetCards(params, undefined, async () => '')).toEqual([]);
    expect(
      await fetchPartnersWidgetCards(params, undefined, async () => '<html>404</html>'),
    ).toEqual([]);
  });

  it('id/trackingCode가 없으면 네트워크를 호출하지 않고 []를 반환한다', async () => {
    let called = false;
    const cards = await fetchPartnersWidgetCards({ id: 1 }, undefined, async () => {
      called = true;
      return FIXTURE;
    });
    expect(cards).toEqual([]);
    expect(called).toBe(false);
  });

  it('fetcher에는 조립된 위젯 문서 URL이 전달된다', async () => {
    let seenUrl = '';
    await fetchPartnersWidgetCards(
      { id: 1022164, trackingCode: 'AF8963794', subId: 'blog', template: 'carousel' },
      1,
      async (url) => {
        seenUrl = url;
        return FIXTURE;
      },
    );
    expect(seenUrl).toBe(
      `${PARTNERS_WIDGETS_ENDPOINT}?id=1022164&trackingCode=AF8963794&subId=blog&template=carousel`,
    );
  });

  it('limit이 0/음수/NaN이면 기본값으로 폴백한다', async () => {
    expect(await fetchPartnersWidgetCards(params, 0, async () => FIXTURE)).toHaveLength(
      DEFAULT_WIDGET_CARD_LIMIT,
    );
    expect(await fetchPartnersWidgetCards(params, -1, async () => FIXTURE)).toHaveLength(
      DEFAULT_WIDGET_CARD_LIMIT,
    );
  });
});
