import { describe, expect, it } from 'vitest';
import {
  buildPublishPreviewHtml,
  rewriteLocalImageSrcsForWeb,
} from '../../src/content/PublishPreview';

const marker = (kind: string, props: Record<string, unknown>): string =>
  `<div data-coupang-widget="${kind}" data-widget-props="${encodeURIComponent(
    JSON.stringify(props),
  )}"></div>`;

describe('buildPublishPreviewHtml (#17) — 발행 변환 체인 모방', () => {
  it('위젯 마커를 실제 HTML로 확장한다', () => {
    const html = `${marker('product-link', {
      url: 'https://link.coupang.com/a/1',
      text: '구매하기',
    })}<p>본문</p>`;
    const out = buildPublishPreviewHtml(html, 'naver');
    expect(out).toContain('<a href="https://link.coupang.com/a/1"');
    expect(out).not.toContain('data-coupang-widget');
  });

  it('script 위젯은 naver 체인에서 제거된다(이슈 #20 원인 B — iframe도 100% 소실)', () => {
    const snippet = '<script>new PartnersCoupang.G({"id":1,"trackingCode":"AF"});</script>';
    const out = buildPublishPreviewHtml(marker('dynamic-banner', { snippet }), 'naver');
    // iframe 변환 경로는 폐기됐다 — 미리보기에서도 발행물과 동일한 체인을 쓴다.
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
  });

  it('naver 체인은 <style> 블록을 인라인 스타일로 바꾸고 heading을 평탄화한다', () => {
    // 실제 템플릿(naver-coupang-review.hbs)처럼 <style>이 컨테이너 div 안에 중첩된
    // 형태로 테스트한다(최상위 <style>은 cheerio body 추출 시 head로 이동되는
    // cheerio 특성이 있으며, 발행과 미리보기가 동일 체인이라 결과는 항상 일치).
    const html =
      '<div><style>p.se-title { font-size: 20px; }</style><h2>섹션 제목</h2><p class="se-title">본문</p></div>';
    const out = buildPublishPreviewHtml(html, 'naver');
    expect(out).not.toContain('<style>');
    expect(out).not.toContain('<h2>');
    // 인라인 스타일이 적용된다
    expect(out).toMatch(/font-size:\s*20px/);
    expect(out).toContain('섹션 제목');
  });

  it('naver가 아닌 플랫폼은 heading/style을 유지한다', () => {
    const html = '<div><style>p { color: red; }</style><h2>제목</h2></div>';
    const out = buildPublishPreviewHtml(html, 'tistory');
    expect(out).toContain('<h2>제목</h2>');
    expect(out).toContain('<style>');
  });

  it('발행 시점 스타일 정리(img max-width)가 적용된다', () => {
    const html = '<img src="https://example.com/a.png">';
    const out = buildPublishPreviewHtml(html, 'naver');
    expect(out).toMatch(/max-width:\s*100%/);
  });
});

describe('rewriteLocalImageSrcsForWeb (#17) — 로컬 이미지 웹 경로 치환', () => {
  it('output/ 상대경로를 /output/ 절대경로로 바꾼다', () => {
    const html = '<img src="output/images/a.png" alt="x">';
    expect(rewriteLocalImageSrcsForWeb(html)).toBe('<img src="/output/images/a.png" alt="x">');
  });

  it('http(s)/data URL은 그대로 둔다', () => {
    const html =
      '<img src="https://example.com/a.png"><img src="data:image/png;base64,AAA"><img src="//cdn.example.com/b.png">';
    expect(rewriteLocalImageSrcsForWeb(html)).toBe(html);
  });
});
