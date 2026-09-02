import { describe, expect, it } from 'vitest';
import {
  buildEventPreviewCard,
  buildProductPreviewCard,
  extractProductIdFromProductUrl,
  fetchLinkPreviewCards,
  resolveShortLink,
  stylePublishHtml,
  type HttpFetcher,
} from '../../src/content/CoupangPreview';

const marker = (kind: string, props: Record<string, unknown>): string =>
  `<div data-coupang-widget="${kind}" data-widget-props="${encodeURIComponent(
    JSON.stringify(props),
  )}"></div>`;

describe('extractProductIdFromProductUrl', () => {
  it('vp/products 경로에서 productId를 추출한다', () => {
    expect(
      extractProductIdFromProductUrl(
        'https://www.coupang.com/vp/products/68933481?itemId=123&vendorItemId=456&trackingCode=AF',
      ),
    ).toBe('68933481');
  });

  it('products 경로(vp 없음)도 지원한다', () => {
    expect(extractProductIdFromProductUrl('https://www.coupang.com/products/12345678')).toBe(
      '12345678',
    );
  });

  it('상품 URL이 아니면 null을 반환한다', () => {
    expect(extractProductIdFromProductUrl('https://event.coupang.com/1234')).toBeNull();
    expect(extractProductIdFromProductUrl('https://link.coupang.com/a/abc')).toBeNull();
    expect(extractProductIdFromProductUrl('')).toBeNull();
  });
});

describe('resolveShortLink — 단축 링크 해석(fetcher 주입)', () => {
  it('302 체인을 따라 최종 상품 URL에 도달한다', async () => {
    const fetcher: HttpFetcher = async (url) => {
      if (url === 'https://link.coupang.com/a/abc') {
        return { status: 302, location: 'https://link.coupang.com/m/abc' };
      }
      if (url === 'https://link.coupang.com/m/abc') {
        return { status: 302, location: 'https://www.coupang.com/vp/products/68933481' };
      }
      throw new Error('unexpected fetch: ' + url);
    };
    const final = await resolveShortLink('https://link.coupang.com/a/abc', fetcher);
    expect(final).toContain('/vp/products/68933481');
  });

  it('meta refresh 리다이렉트도 해석한다', async () => {
    const fetcher: HttpFetcher = async () => ({
      status: 200,
      body: '<html><head><meta http-equiv="refresh" content="0; url=https://www.coupang.com/vp/products/777"></head></html>',
    });
    const final = await resolveShortLink('https://link.coupang.com/a/xyz', fetcher);
    expect(final).toContain('/vp/products/777');
  });

  it('이미 상품 URL이면 fetch하지 않고 반환한다', async () => {
    let calls = 0;
    const fetcher: HttpFetcher = async () => {
      calls++;
      return { status: 200, body: '' };
    };
    const final = await resolveShortLink('https://www.coupang.com/vp/products/42', fetcher);
    expect(final).toContain('products/42');
    expect(calls).toBe(0);
  });
});

describe('buildProductPreviewCard / buildEventPreviewCard', () => {
  const data = {
    imageUrl: 'https://image.example.com/p.jpg',
    title: '무선 청소기 V9',
    price: 298000,
    originalPrice: 450000,
    discountRate: 33,
    rating: 4.8,
    reviewCount: 1234,
    source: 'api' as const,
  };

  it('상품 카드는 이미지·가격·할인·평점·CTA·파트너스 고지를 담는다', () => {
    const card = buildProductPreviewCard('https://link.coupang.com/a/abc', data);
    expect(card).toContain('<img src="https://image.example.com/p.jpg"');
    expect(card).toContain('298,000원');
    expect(card).toContain('450,000원');
    expect(card).toContain('33%↓');
    expect(card).toContain('⭐ 4.8 (1,234개 리뷰)');
    expect(card).toContain('href="https://link.coupang.com/a/abc"');
    expect(card).toContain('rel="nofollow sponsored"');
    expect(card).toContain('쿠팡 파트너스 링크를 포함합니다');
    expect(card).toContain('🛒 쿠팡에서 보기');
  });

  it('이미지가 없으면 이모지 플레이스홀더로 카드를 만든다', () => {
    const card = buildProductPreviewCard('https://link.coupang.com/a/abc', {
      ...data,
      imageUrl: undefined,
    });
    expect(card).not.toContain('<img');
    expect(card).toContain('🛍️');
  });

  it('제목의 HTML 특수문자를 이스케이프한다', () => {
    const card = buildProductPreviewCard('https://link.coupang.com/a/abc', {
      ...data,
      title: '<script>alert("x")</script>',
    });
    expect(card).not.toContain('<script>alert');
    expect(card).toContain('&lt;script&gt;');
  });

  it('이벤트 카드는 EVENT 배지와 이벤트 CTA를 담는다', () => {
    const card = buildEventPreviewCard('https://event.coupang.com/1', {
      title: '로켓와우데이',
      source: 'og',
    });
    expect(card).toContain('EVENT');
    expect(card).toContain('로켓와우데이');
    expect(card).toContain('이벤트 확인하기');
    expect(card).toContain('href="https://event.coupang.com/1"');
  });
});

describe('fetchLinkPreviewCards — 마커 인덱스 기반 카드 수집', () => {
  it('product-link/event-link만 API 데이터로 카드를 만들고 인덱스를 매긴다', async () => {
    const html = [
      '<p>본문</p>',
      marker('product-link', { url: 'https://link.coupang.com/a/p1', text: '' }),
      marker('dynamic-banner', { snippet: '<script>1</script>' }),
      marker('event-link', { url: 'https://link.coupang.com/a/e1', text: '이벤트' }),
    ].join('');
    const adapter = {
      getProductDetails: async (productId: string) => ({
        id: productId,
        name: `상품-${productId}`,
        price: 10000,
        currency: 'KRW',
        productUrl: 'https://www.coupang.com/vp/products/' + productId,
        categoryId: '1',
        categoryName: '테스트',
        availability: 'in_stock' as const,
        imageUrl: 'https://image.example.com/x.jpg',
      }),
    };
    // 단축 링크/OG 요청이 실제 네트워크로 나가지 않게 fetcher를 주입한다.
    const fetcher: HttpFetcher = async (url) => {
      if (url.includes('/a/p1')) {
        return { status: 302, location: 'https://www.coupang.com/vp/products/1000001' };
      }
      return { status: 403, body: '' };
    };
    const cards = await fetchLinkPreviewCards(html, adapter, fetcher);
    expect(cards.size).toBe(2);
    expect(cards.get(0)).toContain('상품-');
    // 이벤트 링크는 데이터 수집 실패 시에도 기본 타이틀 카드로 발행된다(이슈 #12).
    expect(cards.get(2)).toContain('이벤트 확인하기');
  });

  it('위젯이 없으면 빈 맵을 반환한다', async () => {
    const cards = await fetchLinkPreviewCards('<p>위젯 없음</p>', undefined);
    expect(cards.size).toBe(0);
  });
});

describe('stylePublishHtml — 발행 시점 스타일 정리(이슈 #12)', () => {
  it('style이 없는 img에 반응형 max-width를 부여한다', () => {
    const out = stylePublishHtml('<p>a</p><img src="https://x.com/b.jpg" alt="b"><p>c</p>');
    expect(out).toContain('max-width: 100%');
  });

  it('이미 max-width가 있으면 건드리지 않는다', () => {
    const html = '<img src="https://x.com/b.jpg" style="width:110px;max-width:100%">';
    expect(stylePublishHtml(html)).toBe(html);
  });

  it('빈 문자열은 그대로 반환한다', () => {
    expect(stylePublishHtml('')).toBe('');
  });
});
