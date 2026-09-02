import { describe, expect, it } from 'vitest';
import {
  COUPANG_WIDGET_KINDS,
  buildPartnersIframeSnippet,
  expandCoupangWidgets,
  parsePartnersCoupangScript,
} from '../../src/content/CoupangWidgets';

const marker = (kind: string, props: Record<string, unknown>): string =>
  `<div data-coupang-widget="${kind}" data-widget-props="${encodeURIComponent(
    JSON.stringify(props),
  )}"></div>`;

describe('COUPANG_WIDGET_KINDS', () => {
  it('defines the 6 widget kinds', () => {
    expect(COUPANG_WIDGET_KINDS).toEqual([
      'product-link',
      'event-link',
      'dynamic-banner',
      'search-widget',
      'category-banner',
      'ad-banner',
    ]);
  });
});

describe('expandCoupangWidgets — link kinds', () => {
  it('expands product-link to an <a> with nofollow sponsored rel', () => {
    const html = `<p>시작</p>${marker('product-link', {
      url: 'https://link.coupang.com/a/abc',
      text: '쿠팡에서 보기',
    })}<p>끝</p>`;
    const out = expandCoupangWidgets(html);
    expect(out).toContain('<a href="https://link.coupang.com/a/abc"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="nofollow sponsored"');
    expect(out).toContain('>쿠팡에서 보기</a>');
    expect(out).toContain('<p>시작</p>');
    expect(out).toContain('<p>끝</p>');
    expect(out).not.toContain('data-coupang-widget');
  });

  it('expands event-link to an <a> with nofollow sponsored rel', () => {
    const html = marker('event-link', {
      url: 'https://event.coupang.com/1',
      text: '이벤트 보러가기',
    });
    const out = expandCoupangWidgets(html);
    expect(out).toContain('<a href="https://event.coupang.com/1"');
    expect(out).toContain('rel="nofollow sponsored"');
    expect(out).toContain('>이벤트 보러가기</a>');
    expect(out).not.toContain('data-coupang-widget');
  });

  it('빈 text는 유실되지 않게 기본 라벨로 발행한다(이슈 #10)', () => {
    // 사용자 재현 케이스: URL만 입력하고 표시 텍스트를 비운 위젯이 발행물에서 사라짐
    const product = expandCoupangWidgets(
      marker('product-link', { url: 'https://link.coupang.com/a/abc', text: '' }),
    );
    expect(product).toContain('<a href="https://link.coupang.com/a/abc"');
    expect(product).toContain('rel="nofollow sponsored"');
    expect(product).toContain('>상품 보기</a>');

    const event = expandCoupangWidgets(
      marker('event-link', { url: 'https://link.coupang.com/a/xyz', text: '' }),
    );
    expect(event).toContain('<a href="https://link.coupang.com/a/xyz"');
    expect(event).toContain('>이벤트 확인하기</a>');
  });

  it('url이 없는 링크 위젯은 제거한다', () => {
    const noUrl = expandCoupangWidgets(marker('product-link', { text: '링크' }));
    expect(noUrl).not.toContain('data-coupang-widget');
    expect(noUrl).toBe('');
  });
});

describe('expandCoupangWidgets — ad-banner', () => {
  it('expands ad-banner to a linked image with nofollow sponsored rel', () => {
    const html = `<p>시작</p>${marker('ad-banner', {
      url: 'https://link.coupang.com/a/banner1',
      imageUrl: 'https://image.example.com/banner.jpg',
      text: '광고 상품 배너',
    })}<p>끝</p>`;
    const out = expandCoupangWidgets(html);
    expect(out).toContain('<a href="https://link.coupang.com/a/banner1"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="nofollow sponsored"');
    expect(out).toMatch(
      /<img src="https:\/\/image\.example\.com\/banner\.jpg" alt="광고 상품 배너"/,
    );
    expect(out).toContain('<p>시작</p>');
    expect(out).toContain('<p>끝</p>');
    expect(out).not.toContain('data-coupang-widget');
  });

  it('adds a caption paragraph when text is provided', () => {
    const out = expandCoupangWidgets(
      marker('ad-banner', {
        url: 'https://link.coupang.com/a/b2',
        imageUrl: 'https://image.example.com/b.jpg',
        text: '파트너스 활동으로 수수료를 받습니다',
      }),
    );
    expect(out).toContain('<p>파트너스 활동으로 수수료를 받습니다</p>');
  });

  it('omits the caption paragraph when text is absent', () => {
    const out = expandCoupangWidgets(
      marker('ad-banner', {
        url: 'https://link.coupang.com/a/b3',
        imageUrl: 'https://image.example.com/b.jpg',
      }),
    );
    expect(out).toContain('<a href="https://link.coupang.com/a/b3"');
    expect(out).toMatch(/alt=""/);
    expect(out).not.toContain('<p>');
  });

  it('removes ad-banner markers missing url or imageUrl', () => {
    const noUrl = expandCoupangWidgets(
      marker('ad-banner', { imageUrl: 'https://image.example.com/b.jpg', text: '배너' }),
    );
    const noImage = expandCoupangWidgets(
      marker('ad-banner', { url: 'https://link.coupang.com/a/b4', text: '배너' }),
    );
    const empty = expandCoupangWidgets(marker('ad-banner', {}));
    expect(noUrl).toBe('');
    expect(noImage).toBe('');
    expect(empty).toBe('');
  });
});

describe('expandCoupangWidgets — embed kinds', () => {
  it('substitutes dynamic-banner snippet verbatim', () => {
    const snippet =
      '<script src="https://ads-partners.coupang.com/g.js"></script><iframe src="//ads-partners.coupang.com/banner?a=1"></iframe>';
    const out = expandCoupangWidgets(marker('dynamic-banner', { snippet }));
    expect(out).toBe(snippet);
  });

  it('substitutes search-widget snippet verbatim', () => {
    const snippet = '<div id="coupang-search-widget"></div>';
    const out = expandCoupangWidgets(marker('search-widget', { snippet }));
    expect(out).toBe(snippet);
  });

  it('substitutes category-banner snippet verbatim', () => {
    const snippet = '<script>console.log("category banner")</script>';
    const out = expandCoupangWidgets(marker('category-banner', { snippet }));
    expect(out).toBe(snippet);
  });

  it('removes embed markers missing snippet', () => {
    const out = expandCoupangWidgets(marker('dynamic-banner', {}));
    expect(out).not.toContain('data-coupang-widget');
    expect(out).toBe('');
  });
});

describe('expandCoupangWidgets — robustness', () => {
  it('removes markers with malformed props JSON', () => {
    const html = '<div data-coupang-widget="product-link" data-widget-props="%7Bnot-json"></div>';
    expect(expandCoupangWidgets(html)).not.toContain('data-coupang-widget');
  });

  it('removes markers with unknown kind', () => {
    expect(expandCoupangWidgets(marker('alien-widget', { url: 'https://x.com' }))).toBe('');
  });

  it('expands multiple markers of different kinds in one document', () => {
    const html = [
      '<h2>제목</h2>',
      marker('product-link', { url: 'https://link.coupang.com/a/1', text: '구매하기' }),
      marker('dynamic-banner', { snippet: '<div class="banner"></div>' }),
      marker('search-widget', {}),
    ].join('');
    const out = expandCoupangWidgets(html);
    expect(out).toContain('<h2>제목</h2>');
    expect(out).toContain('rel="nofollow sponsored"');
    expect(out).toContain('<div class="banner"></div>');
    expect(out).not.toContain('data-coupang-widget');
  });
});

describe('expandCoupangWidgets — platform: naver (script → iframe 변환)', () => {
  // 사용자 실제 스니펫(2026-08 저장본) — PartnersCoupang.G script 위젯
  const userSnippet = [
    '<script src="https://ads-partners.coupang.com/g.js"></script>',
    '<script>',
    '  new PartnersCoupang.G({"id":1022164,"trackingCode":"AF8963794","subId":null,"template":"carousel","width":"680","height":"140"});',
    '</script>',
  ].join('\n');

  it('naver 발행 시 PartnersCoupang.G script를 파트너스 iframe 위젯으로 변환한다', () => {
    const out = expandCoupangWidgets(marker('dynamic-banner', { snippet: userSnippet }), {
      platform: 'naver',
    });
    expect(out).not.toContain('<script');
    expect(out).toContain('<iframe');
    expect(out).toContain('https://ads-partners.coupang.com/widgets.html?');
    expect(out).toContain('id=1022164');
    expect(out).toContain('trackingCode=AF8963794');
    expect(out).toContain('template=carousel');
    expect(out).toContain('width=680');
    expect(out).toContain('height=140');
  });

  it('iframe이 포함된 snippet은 naver에서도 유지된다(발행 시 컨테이너 래핑)', () => {
    const snippet = '<iframe src="https://coupa.ng/co9ktA" width="100%" height="75"></iframe>';
    const out = expandCoupangWidgets(marker('search-widget', { snippet }), {
      platform: 'naver',
    });
    expect(out).toContain(snippet);
    expect(out).toContain('text-align:center');
  });

  it('다른 플랫폼은 script snippet을 기존대로 그대로 사용한다', () => {
    const out = expandCoupangWidgets(marker('dynamic-banner', { snippet: userSnippet }), {
      platform: 'wordpress',
    });
    expect(out).toContain('PartnersCoupang.G');
  });

  it('naver에서 변환 불가한 script snippet은 제거한다', () => {
    const out = expandCoupangWidgets(
      marker('dynamic-banner', { snippet: '<script>alert(1)</script>' }),
      { platform: 'naver' },
    );
    expect(out).toBe('');
  });

  it('script 없이 앵커+이미지로만 구성된 snippet(카테고리 배너)은 naver에서도 유지한다', () => {
    const snippet =
      '<a href="https://link.coupang.com/a/gFgVnwJkke" target="_blank" referrerpolicy="unsafe-url"><img src="https://ads-partners.coupang.com/banners/1024029" alt=""></a>';
    const out = expandCoupangWidgets(marker('category-banner', { snippet }), {
      platform: 'naver',
    });
    expect(out).toContain(snippet);
    expect(out).toContain('text-align:center');
  });
});

describe('PartnersCoupang.G 파싱/iframe URL 빌더', () => {
  it('script에서 파라미터를 추출한다', () => {
    const params = parsePartnersCoupangScript(
      '<script>new PartnersCoupang.G({"id":1022164,"trackingCode":"AF8963794","subId":null,"template":"carousel"});</script>',
    );
    expect(params).toEqual({
      id: 1022164,
      trackingCode: 'AF8963794',
      subId: null,
      template: 'carousel',
    });
  });

  it('형식이 맞지 않으면 null을 반환한다', () => {
    expect(parsePartnersCoupangScript('<script>foo();</script>')).toBeNull();
    expect(parsePartnersCoupangScript('')).toBeNull();
    expect(parsePartnersCoupangScript('<script>new PartnersCoupang.G({broken</script>')).toBeNull();
  });

  it('subId null/빈 값은 URL에서 생략한다', () => {
    const snippet = buildPartnersIframeSnippet({
      id: 1,
      trackingCode: 'AF',
      subId: null,
      template: 'carousel',
      width: '680',
      height: '140',
    })!;
    expect(snippet).toContain('id=1');
    expect(snippet).toContain('trackingCode=AF');
    expect(snippet).not.toContain('subId');
    expect(snippet).toContain('width="680"');
    expect(snippet).toContain('height="140"');
  });

  it('id/trackingCode가 없으면 null을 반환한다', () => {
    expect(buildPartnersIframeSnippet({ template: 'carousel' })).toBeNull();
  });
});

describe('expandCoupangWidgets — previewCards(미리보기 카드, 이슈 #12)', () => {
  const cardHtml =
    '<div style="max-width:640px"><a href="https://link.coupang.com/a/p1" rel="nofollow sponsored">상품 카드</a></div>';

  it('product-link 마커를 인덱스에 맞는 미리보기 카드로 치환한다', () => {
    const html = [
      '<p>a</p>',
      marker('product-link', { url: 'https://link.coupang.com/a/p1', text: '' }),
      '<p>b</p>',
      marker('product-link', { url: 'https://link.coupang.com/a/p2', text: '링크' }),
    ].join('');
    const out = expandCoupangWidgets(html, {
      previewCards: new Map([[0, cardHtml]]),
    });
    expect(out).toContain('상품 카드');
    // 카드가 없는 인덱스는 기존대로 텍스트 링크
    expect(out).toContain('>링크</a>');
    expect(out).not.toContain('data-coupang-widget');
  });

  it('발행 시점(platform 지정)에는 임베드 위젯이 중앙 정렬 컨테이너로 감싸진다', () => {
    const out = expandCoupangWidgets(
      marker('search-widget', { snippet: '<iframe src="https://coupa.ng/x"></iframe>' }),
      { platform: 'tistory' },
    );
    expect(out).toContain('text-align:center');
    expect(out).toContain('<iframe src="https://coupa.ng/x">');
  });

  it('발행 시점(platform 지정)에는 광고배너가 중앙 정렬 컨테이너로 감싸진다', () => {
    const out = expandCoupangWidgets(
      marker('ad-banner', {
        url: 'https://link.coupang.com/a/b1',
        imageUrl: 'https://image.example.com/b.jpg',
      }),
      { platform: 'naver' },
    );
    expect(out).toContain('text-align:center');
    expect(out).toContain('rel="nofollow sponsored"');
  });
});
