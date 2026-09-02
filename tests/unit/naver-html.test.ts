import { describe, expect, it } from 'vitest';
import { prepareNaverHtml } from '../../src/content/NaverHtml';

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
});
