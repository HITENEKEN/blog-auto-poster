import { describe, expect, it } from 'vitest';
import { COUPANG_WIDGET_KINDS, expandCoupangWidgets } from '../../src/content/CoupangWidgets';

const marker = (kind: string, props: Record<string, unknown>): string =>
  `<div data-coupang-widget="${kind}" data-widget-props="${encodeURIComponent(
    JSON.stringify(props),
  )}"></div>`;

describe('COUPANG_WIDGET_KINDS', () => {
  it('defines the 5 widget kinds', () => {
    expect(COUPANG_WIDGET_KINDS).toEqual([
      'product-link',
      'event-link',
      'dynamic-banner',
      'search-widget',
      'category-banner',
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

  it('removes link markers missing url or text', () => {
    const noUrl = expandCoupangWidgets(marker('product-link', { text: '링크' }));
    const noText = expandCoupangWidgets(marker('product-link', { url: 'https://x.com' }));
    expect(noUrl).not.toContain('data-coupang-widget');
    expect(noUrl).toBe('');
    expect(noText).not.toContain('data-coupang-widget');
    expect(noText).toBe('');
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
