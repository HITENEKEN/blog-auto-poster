import { describe, expect, it } from 'vitest';
import { inlineStyleBlocks } from '../../src/content/StyleInliner';

describe('inlineStyleBlocks — 네이버 발행용 스타일 인라인화', () => {
  it('클래스 규칙을 요소 style 속성으로 변환하고 <style> 태그를 제거한다', () => {
    const html =
      '<style>.wrap{line-height:2.0;color:#333}.wrap p{margin:0 0 16px}</style>' +
      '<div class="wrap"><p>본문</p></div>';
    const out = inlineStyleBlocks(html);
    expect(out).not.toContain('<style');
    expect(out).toContain('line-height: 2.0');
    expect(out).toContain('margin: 0 0 16px');
    expect(out).toContain('본문');
  });

  it('후손 셀렉터가 올바른 요소에만 적용된다', () => {
    const html =
      '<style>.section p{margin:0 0 16px}</style>' +
      '<div class="section"><p>안</p></div><p>밖</p>';
    const out = inlineStyleBlocks(html);
    expect(out).toContain('<p style="margin: 0 0 16px">안</p>');
    expect(out).toContain('<p>밖</p>');
  });

  it('기존 인라인 style이 규칙보다 우선한다', () => {
    const html = '<style>.a{color:red}</style><p class="a" style="color:blue">x</p>';
    const out = inlineStyleBlocks(html);
    expect(out).toContain('color: blue');
    expect(out).not.toContain('color: red');
  });

  it('@media 내부 규칙을 평탄화해 적용한다', () => {
    const html =
      '<style>@media (max-width:600px){.wrap{padding:8px}}</style><div class="wrap">x</div>';
    expect(inlineStyleBlocks(html)).toContain('style="padding: 8px"');
  });

  it('@keyframes 블록은 폐기하고 오류 없이 통과한다', () => {
    const html =
      '<style>@keyframes spin{from{opacity:0}to{opacity:1}}.a{color:red}</style><p class="a">x</p>';
    const out = inlineStyleBlocks(html);
    expect(out).toContain('color: red');
    expect(out).not.toContain('@keyframes');
  });

  it(':hover 같은 의사 클래스 셀렉터는 건너뛴다', () => {
    const html =
      '<style>.a:hover{color:red}.b{color:blue}</style><p class="a">x</p><p class="b">y</p>';
    const out = inlineStyleBlocks(html);
    expect(out).toContain('color: blue');
  });

  it('여러 규칙이 같은 요소에 적용되면 선언이 병합된다', () => {
    const html = '<style>.p{color:red}.p{margin:8px}</style><p class="p">x</p>';
    const out = inlineStyleBlocks(html);
    expect(out).toContain('color: red');
    expect(out).toContain('margin:8px'.replace('margin:8px', 'margin: 8px'));
  });

  it('style 블록이 없으면 입력을 그대로 반환한다', () => {
    const html = '<p>텍스트만</p>';
    expect(inlineStyleBlocks(html)).toBe(html);
  });

  it('문서 전체(<html><body>)가 아닌 body 조각을 반환한다(이슈 #10)', () => {
    // 네이버 SmartEditor 붙여넣기에 문서 전체가 들어가면 마크업이 망가진다.
    const html =
      '<style>.wrap{color:#333}.wrap h2{font-size:1.3rem}</style><div class="wrap"><h2>제목</h2><p>본문</p></div>';
    const out = inlineStyleBlocks(html);
    expect(out.startsWith('<html')).toBe(false);
    expect(out.includes('<body')).toBe(false);
    expect(out.includes('<head')).toBe(false);
    expect(out).toContain('<h2');
    expect(out).toContain('font-size: 1.3rem');
  });
});
