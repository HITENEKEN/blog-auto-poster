import { describe, expect, it } from 'vitest';
import { isSurvivableHref, prepareNaverHtml } from '../../src/content/NaverHtml';

describe('prepareNaverHtml — 네이버 발행용 정규화(이슈 #10)', () => {
  it('script 태그를 제거한다', () => {
    const html = '<p>본문</p><script>alert(1)</script><p>뒤</p>';
    const out = prepareNaverHtml(html);
    expect(out).not.toContain('<script');
    expect(out).toContain('<p>본문</p>');
    expect(out).toContain('<p>뒤</p>');
  });

  it('남아 있는 style 태그도 제거한다', () => {
    const out = prepareNaverHtml('<style>.a{color:red}</style><p class="a">x</p>');
    expect(out).not.toContain('<style');
    expect(out).toContain('<p class="a">x</p>');
  });

  it('h1~h6를 인라인 스타일이 적용된 <p>로 변환해 글자 크기 계층을 유지한다', () => {
    const out = prepareNaverHtml('<h1>대제목</h1><h2>중제목</h2><h3>소제목</h3>');
    expect(out).not.toMatch(/<h[1-6]/);
    expect(out).toMatch(/<p style="[^"]*font-size: 1\.45rem[^"]*">대제목<\/p>/);
    expect(out).toMatch(/<p style="[^"]*font-size: 1\.25rem[^"]*">중제목<\/p>/);
    expect(out).toMatch(/<p style="[^"]*font-size: 1\.1rem[^"]*">소제목<\/p>/);
    expect(out).toMatch(/font-weight: 700/);
  });

  it('기존 인라인 style(StyleInliner 산출)을 최우선으로 유지하면서 병합한다', () => {
    const out = prepareNaverHtml('<h2 style="font-size: 1.3rem; color: #212529">제목</h2>');
    expect(out).toContain('font-size: 1.3rem');
    expect(out).toContain('color: #212529');
    // 기본 스타일에서 아직 없는 속성(font-weight, margin)은 보강된다
    expect(out).toContain('font-weight: 700');
    expect(out).toContain('margin: 24px 0 10px');
  });

  it('body 조각을 반환한다(문서 래핑 없음)', () => {
    const out = prepareNaverHtml('<h2>제목</h2>');
    expect(out.startsWith('<html')).toBe(false);
    expect(out.includes('<body')).toBe(false);
  });

  it('빈 문자열은 그대로 반환한다', () => {
    expect(prepareNaverHtml('')).toBe('');
  });

  describe('prepareNaverHtml — iframe 제거(이슈 #20 원인 B)', () => {
    it('iframe 요소를 완전히 제거한다', () => {
      const out = prepareNaverHtml(
        '<p>앞</p><iframe src="https://ads-partners.coupang.com/widgets.html?id=1"></iframe><p>뒤</p>',
      );
      expect(out).not.toContain('<iframe');
      expect(out).not.toContain('ads-partners.coupang.com');
      expect(out).toContain('<p>앞</p>');
      expect(out).toContain('<p>뒤</p>');
    });

    it('iframe 내부 콘텐츠(fallback 텍스트)도 함께 제거된다 — 소실될 것이므로', () => {
      const out = prepareNaverHtml('<iframe src="https://x.com/w"><p>폴백</p></iframe>');
      expect(out).not.toContain('폴백');
    });

    it('여러 iframe을 모두 제거한다', () => {
      const out = prepareNaverHtml(
        '<iframe src="https://a"></iframe><p>x</p><iframe src="https://b"></iframe>',
      );
      expect(out.match(/<iframe/g)).toBeNull();
      expect(out).toContain('<p>x</p>');
    });
  });

  describe('prepareNaverHtml — 비-http 앵커 언래핑(이슈 #20 원인 C)', () => {
    it('href="#" 앵커를 벗겨 내부 텍스트만 남긴다(죽은 버튼 방지)', () => {
      const out = prepareNaverHtml('<a href="#" class="ncr-cta">🛒 가격 확인하기</a>');
      expect(out).not.toContain('<a ');
      expect(out).not.toContain('href="#"');
      expect(out).toContain('🛒 가격 확인하기');
    });

    it('href가 없거나 빈 앵커도 벗긴다', () => {
      const out = prepareNaverHtml('<a>텍스트</a><a href="">빈값</a>');
      expect(out).not.toContain('<a');
      expect(out).toContain('텍스트');
      expect(out).toContain('빈값');
    });

    it('javascript:/상대경로 href도 벗긴다', () => {
      const out = prepareNaverHtml(
        '<a href="javascript:void(0)">js</a><a href="/local">상대</a><a href="foo/bar">상대2</a>',
      );
      expect(out).not.toContain('<a');
      expect(out).toContain('js');
      expect(out).toContain('상대');
      expect(out).toContain('상대2');
    });

    it('실제 https 링크는 그대로 보존한다', () => {
      const html =
        '<a href="https://link.coupang.com/re/AFF?lptag=AF1" rel="nofollow sponsored">바로가기</a>';
      const out = prepareNaverHtml(html);
      expect(out).toContain('href="https://link.coupang.com/re/AFF?lptag=AF1"');
      expect(out).toContain('rel="nofollow sponsored"');
      expect(out).toContain('바로가기');
    });

    it('이미지를 감싼 죽은 앵커는 벗기되 이미지는 남긴다', () => {
      const out = prepareNaverHtml(
        '<a href="#"><img src="https://img1a.coupangcdn.com/banner.jpg" alt="배너" /></a>',
      );
      expect(out).not.toContain('<a');
      expect(out).toContain('<img src="https://img1a.coupangcdn.com/banner.jpg"');
    });

    it('실제 링크와 죽은 링크가 섞여 있으면 죽은 링크만 벗긴다', () => {
      const out = prepareNaverHtml(
        '<p><a href="https://a.com">살아있는</a></p><p><a href="#">죽은</a></p>',
      );
      expect(out).toContain('<a href="https://a.com">살아있는</a>');
      expect(out).not.toContain('href="#"');
      expect(out).toContain('죽은');
    });
  });

  describe('isSurvivableHref — SE가 href를 유지하는 스킴 판정(이슈 #20 원인 C)', () => {
    it('http/https/mailto/tel은 살아남는다', () => {
      expect(isSurvivableHref('http://a.com')).toBe(true);
      expect(isSurvivableHref('https://a.com')).toBe(true);
      expect(isSurvivableHref('mailto:a@b.com')).toBe(true);
      expect(isSurvivableHref('tel:01012345678')).toBe(true);
    });

    it('빈 값/#/javascript:/상대경로/undefined는 죽은 링크다', () => {
      expect(isSurvivableHref('')).toBe(false);
      expect(isSurvivableHref('   ')).toBe(false);
      expect(isSurvivableHref('#')).toBe(false);
      expect(isSurvivableHref('#top')).toBe(false);
      expect(isSurvivableHref('javascript:void(0)')).toBe(false);
      expect(isSurvivableHref('/relative')).toBe(false);
      expect(isSurvivableHref('foo/bar')).toBe(false);
      expect(isSurvivableHref(undefined)).toBe(false);
    });
  });
});
