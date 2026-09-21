import { describe, expect, it } from 'vitest';
import {
  findSectionBoundaries,
  hasWidgetMarkers,
  liftWidgetMarkers,
  resolveCtaAffiliateUrl,
} from '../../src/content/WidgetPlacement';
import { fillCtaAffiliateUrl } from '../../src/content/WidgetPlacement';

/**
 * 본문 위젯 마커 유틸.
 *
 * 예전 `placePresetsInContent`(등록 프리셋을 모든 글에 균등 분산)는 폐기됐다 —
 * 배치는 주제 매칭 기반 `AdPlacement.ts`가 맡는다(설계 §3-3).
 */
const sampleBody = [
  '<p>도입</p>',
  '<h2>첫 섹션</h2><p>내용1</p>',
  '<h2>둘째 섹션</h2><p>내용2</p>',
  '<h2>셋째 섹션</h2><p>내용3</p>',
  '<p>맺음</p>',
].join('');

const marker = (kind: string, props: Record<string, string>): string =>
  `<div data-coupang-widget="${kind}" data-widget-props="${encodeURIComponent(
    JSON.stringify(props),
  )}"></div>`;

describe('hasWidgetMarkers', () => {
  it('마커 존재 여부를 판정한다', () => {
    expect(hasWidgetMarkers('<div data-coupang-widget="ad-banner"></div>')).toBe(true);
    expect(hasWidgetMarkers('<p>본문</p>')).toBe(false);
  });
});

describe('findSectionBoundaries', () => {
  it('h2/h3 섹션 경계를 찾는다', () => {
    const sections = findSectionBoundaries(sampleBody);
    expect(sections).toHaveLength(3);
    expect(sampleBody.slice(sections[0].start, sections[0].start + 20)).toContain('<p>내용1</p>');
    expect(sections[2].end).toBe(sampleBody.length);
  });

  it('heading이 없으면 빈 배열', () => {
    expect(findSectionBoundaries('<p>본문만</p>')).toEqual([]);
  });
});

describe('liftWidgetMarkers (#17)', () => {
  it('<figure> 안에 갇힌 마커를 블록 최상위로 끌어올린다', () => {
    const html =
      '<figure class="section-image"><img src="a.png"><div data-coupang-widget="product-link" data-widget-props="%7B%7D"></div></figure><p>본문</p>';
    const lifted = liftWidgetMarkers(html);
    expect(lifted.indexOf('data-coupang-widget')).toBeGreaterThan(lifted.indexOf('</figure>'));
  });

  it('옮길 마커가 없으면 원본 문자열을 그대로 돌려준다', () => {
    const html = `<div>${marker('product-link', { url: 'https://link.coupang.com/a/1' })}</div>`;
    expect(liftWidgetMarkers(html)).toBe(html);
  });
});

describe('CTA 제휴 URL 채우기 (#20)', () => {
  it('죽은 CTA 앵커(href ""/"#")를 실제 링크로 채운다', () => {
    const html = '<p><a class="cbg-cta-sm" href="#">가격 확인하기</a></p>';
    const filled = fillCtaAffiliateUrl(html, 'https://link.coupang.com/a/9');
    expect(filled).toContain('href="https://link.coupang.com/a/9"');
  });

  it('이미 실제 링크가 있으면 그대로 둔다', () => {
    const html = '<p><a class="cbg-cta-sm" href="https://link.coupang.com/a/keep">보기</a></p>';
    expect(fillCtaAffiliateUrl(html, 'https://link.coupang.com/a/9')).toBe(html);
  });

  it('본문의 첫 product-link 마커에서 URL을 얻는다', () => {
    const html = marker('product-link', {
      url: 'https://link.coupang.com/a/first',
      text: '상품',
    });
    expect(resolveCtaAffiliateUrl(html)).toBe('https://link.coupang.com/a/first');
  });

  it('마커가 없으면 글 메타 URL로 폴백하고, 그것도 없으면 빈 값', () => {
    expect(resolveCtaAffiliateUrl('<p>본문</p>', 'https://link.coupang.com/a/meta')).toBe(
      'https://link.coupang.com/a/meta',
    );
    expect(resolveCtaAffiliateUrl('<p>본문</p>')).toBe('');
  });
});
