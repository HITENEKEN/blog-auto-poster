import { describe, expect, it } from 'vitest';
import {
  COUPANG_WIDGET_KINDS,
  expandCoupangWidgets,
  expandCoupangWidgetsReport,
  normalizeLinkWidgetProps,
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

describe('expandCoupangWidgets — platform: naver (script/iframe 제거, 이슈 #20 원인 B)', () => {
  // 사용자 실제 스니펫(2026-08 저장본) — PartnersCoupang.G script 위젯
  const userSnippet = [
    '<script src="https://ads-partners.coupang.com/g.js"></script>',
    '<script>',
    '  new PartnersCoupang.G({"id":1022164,"trackingCode":"AF8963794","subId":null,"template":"carousel","width":"680","height":"140"});',
    '</script>',
  ].join('\n');

  it('script 전용 snippet은 naver에서 발행 불가 — iframe으로 변환하지 않고 drop 기록', () => {
    // 원인 B: 네이버는 iframe을 100% 제거한다. iframe 변환은 매 발행마다 무결성
    // 실패를 유발했으므로 폐기했다. 카드가 없으면 위젯 자리를 비우고 리포트한다.
    const report = expandCoupangWidgetsReport(marker('dynamic-banner', { snippet: userSnippet }), {
      platform: 'naver',
    });
    expect(report.html).not.toContain('<script');
    expect(report.html).not.toContain('<iframe');
    expect(report.expanded).toBe(0);
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0].kind).toBe('dynamic-banner');
  });

  it('iframe snippet도 naver에서는 제거된다(네이버가 100% 제거하므로 발행하지 않는다)', () => {
    const snippet = '<iframe src="https://coupa.ng/co9ktA" width="100%" height="75"></iframe>';
    const report = expandCoupangWidgetsReport(marker('search-widget', { snippet }), {
      platform: 'naver',
    });
    expect(report.html).not.toContain('<iframe');
    expect(report.dropped).toHaveLength(1);
  });

  it('script와 안전 콘텐츠가 섞여 있으면 script만 걷어내고 나머지는 발행한다', () => {
    const snippet =
      '<script>new PartnersCoupang.G({"id":1});</script>' +
      '<a href="https://link.coupang.com/a/x" target="_blank"><img src="https://ads-partners.coupang.com/banners/1" alt=""></a>';
    const out = expandCoupangWidgets(marker('dynamic-banner', { snippet }), {
      platform: 'naver',
    });
    expect(out).not.toContain('<script');
    expect(out).toContain('https://link.coupang.com/a/x');
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

describe('parsePartnersCoupangScript — 위젯 파라미터 추출', () => {
  it('PartnersCoupang.G script에서 파라미터를 추출한다', () => {
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

  it('PartnersCoupang.Carousel(서버 렌더) 형태는 logParams/config에서 복원한다', () => {
    const params = parsePartnersCoupangScript(
      'new PartnersCoupang.Carousel("#container", {"items":[{"name":"(1개)"}],' +
        '"config":{"width":"680","height":"140"},' +
        '"logParams":{"id":1022164,"widgetName":"carousel","trackingCode":"AF8963794"}});',
    );
    expect(params).toEqual({
      id: 1022164,
      trackingCode: 'AF8963794',
      subId: undefined,
      template: 'carousel',
      width: '680',
      height: '140',
    });
  });

  it('상품명에 괄호가 섞여 있어도 객체 범위를 정확히 자른다', () => {
    const params = parsePartnersCoupangScript(
      'new PartnersCoupang.Carousel("#container", {"items":[{"name":"곰곰 쌀 (2kg) 1개"}],' +
        '"logParams":{"id":7,"trackingCode":"AF"}});',
    );
    expect(params?.id).toBe(7);
    expect(params?.trackingCode).toBe('AF');
  });

  it('형식이 맞지 않으면 null을 반환한다', () => {
    expect(parsePartnersCoupangScript('<script>foo();</script>')).toBeNull();
    expect(parsePartnersCoupangScript('')).toBeNull();
    expect(parsePartnersCoupangScript('<script>new PartnersCoupang.G({broken</script>')).toBeNull();
  });

  it('id/trackingCode를 복원할 수 없으면 null을 반환한다', () => {
    expect(
      parsePartnersCoupangScript('new PartnersCoupang.Carousel("#c", {"items":[]});'),
    ).toBeNull();
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

describe('expandCoupangWidgetsReport (#15) — 위젯 유실 리포트', () => {
  it('정상 확장 시 dropped는 비어 있고 expanded는 마커 수', () => {
    const html = [
      marker('product-link', { url: 'https://link.coupang.com/a/1', text: '구매' }),
      marker('ad-banner', {
        url: 'https://link.coupang.com/a/b',
        imageUrl: 'https://image.example.com/b.jpg',
      }),
    ].join('');
    const report = expandCoupangWidgetsReport(html);
    expect(report.expanded).toBe(2);
    expect(report.dropped).toEqual([]);
  });

  it('props 누락 마커는 dropped에 사유와 함께 기록된다', () => {
    const html = marker('product-link', { text: '링크' });
    const report = expandCoupangWidgetsReport(html);
    expect(report.dropped).toEqual([
      { kind: 'product-link', reason: 'url prop missing or not a publishable http(s) link' },
    ]);
    expect(report.expanded).toBe(0);
  });

  it('ad-banner의 url/imageUrl 누락도 기록된다', () => {
    const report = expandCoupangWidgetsReport(marker('ad-banner', { url: 'https://x.com' }));
    expect(report.dropped).toEqual([{ kind: 'ad-banner', reason: 'url/imageUrl prop missing' }]);
  });

  it('naver에서 카드 없는 script/iframe snippet은 사유를 기록한다(이슈 #20 원인 B)', () => {
    const report = expandCoupangWidgetsReport(
      marker('dynamic-banner', { snippet: '<script>alert(1)</script>' }),
      { platform: 'naver' },
    );
    expect(report.dropped).toEqual([
      {
        kind: 'dynamic-banner',
        reason: 'naver cannot publish this widget (script/iframe removed, no card)',
      },
    ]);
  });

  it('알 수 없는 kind도 기록한다', () => {
    const report = expandCoupangWidgetsReport(marker('alien-widget', {}));
    expect(report.dropped).toEqual([{ kind: 'alien-widget', reason: 'unknown widget kind' }]);
  });
});

describe('normalizeLinkWidgetProps — URL 칸 입력 정규화 (logNo 224404059950)', () => {
  const BANNER =
    '<a href="https://link.coupang.com/a/gQTJxrccNM" target="_blank" referrerpolicy="unsafe-url">' +
    '<img src="https://img4a.coupangcdn.com/image/affiliate/banner/14fa.jpg" ' +
    'alt="[백화점 정품] Guess 게스 여성 롱 와이드 데님 청바지" width="120" height="240"></a>';

  it('평범한 URL은 그대로 두고 기본 라벨을 채운다', () => {
    expect(
      normalizeLinkWidgetProps('product-link', { url: 'https://link.coupang.com/a/p1' }),
    ).toEqual({ url: 'https://link.coupang.com/a/p1', text: '상품 보기' });
  });

  it('배너 스니펫이면 href/이미지/상품명을 회수한다', () => {
    // 에디터가 자동으로 넣은 기본 라벨('상품 보기')은 배너 alt(실제 상품명)로 대체한다.
    expect(normalizeLinkWidgetProps('product-link', { url: BANNER, text: '상품 보기' })).toEqual({
      url: 'https://link.coupang.com/a/gQTJxrccNM',
      text: '[백화점 정품] Guess 게스 여성 롱 와이드 데님 청바지',
      imageUrl: 'https://img4a.coupangcdn.com/image/affiliate/banner/14fa.jpg',
    });
  });

  it('사용자가 직접 쓴 텍스트는 배너 alt보다 우선한다', () => {
    expect(
      normalizeLinkWidgetProps('product-link', { url: BANNER, text: '내가 쓴 문구' })?.text,
    ).toBe('내가 쓴 문구');
  });

  it('발행 후 살아남지 못하는 URL은 null (죽은 평문을 남기지 않는다)', () => {
    expect(normalizeLinkWidgetProps('product-link', { url: '#' })).toBeNull();
    expect(normalizeLinkWidgetProps('product-link', { url: '/relative/path' })).toBeNull();
    expect(normalizeLinkWidgetProps('product-link', {})).toBeNull();
  });
});

describe('expandCoupangWidgets — URL 칸에 배너 스니펫이 들어온 마커 (logNo 224404059950)', () => {
  const BANNER =
    '<a href="https://link.coupang.com/a/gQTJxrccNM"><img src="https://img4a.coupangcdn.com/b.jpg" ' +
    'alt="Guess 게스 여성 롱 와이드 데님 청바지"></a>';

  it('죽은 평문 대신 이미지 링크로 발행한다', () => {
    const html = expandCoupangWidgets(marker('product-link', { url: BANNER, text: '상품 보기' }), {
      platform: 'naver',
    });
    expect(html).toContain('href="https://link.coupang.com/a/gQTJxrccNM"');
    expect(html).toContain('src="https://img4a.coupangcdn.com/b.jpg"');
    expect(html).toContain('alt="Guess 게스 여성 롱 와이드 데님 청바지"');
    // 스니펫 문자열이 href 값으로 새어 들어가지 않는다.
    expect(html).not.toContain('href="<a');
  });

  it('http(s)가 아닌 URL 마커는 사유와 함께 제거된다', () => {
    const report = expandCoupangWidgetsReport(marker('product-link', { url: '#', text: '보기' }), {
      platform: 'naver',
    });
    expect(report.expanded).toBe(0);
    expect(report.dropped).toEqual([
      { kind: 'product-link', reason: 'url prop missing or not a publishable http(s) link' },
    ]);
    expect(report.html).not.toContain('보기');
  });
});
