import { describe, it, expect } from 'vitest';
import { scopeCss } from '@shared/cssScope';

describe('scopeCss', () => {
  it('단일 규칙의 셀렉터를 스코프 하위로 재작성한다', () => {
    const css = '.ncr-wrap{max-width:760px;line-height:2.0}';
    expect(scopeCss(css)).toBe('.ProseMirror .ncr-wrap{max-width:760px;line-height:2.0}');
  });

  it('쉼표 다중 셀렉터를 각각 스코핑한다', () => {
    const css = 'h1, h2{margin:0 0 8px}';
    expect(scopeCss(css)).toBe('.ProseMirror h1, .ProseMirror h2{margin:0 0 8px}');
  });

  it('하위 조합 셀렉터도 그대로 보존하며 스코핑한다', () => {
    const css = '.ncr-section p{margin:0 0 16px}';
    expect(scopeCss(css)).toBe('.ProseMirror .ncr-section p{margin:0 0 16px}');
  });

  it('html/body/:root 셀렉터는 스코프 자체로 치환한다', () => {
    const css = 'body{color:#333} :root{font-size:16px}';
    expect(scopeCss(css)).toBe('.ProseMirror{color:#333}.ProseMirror{font-size:16px}');
  });

  it('CSS 주석을 제거한다', () => {
    const css = '/* header */ .a{color:red}';
    expect(scopeCss(css)).toBe('.ProseMirror .a{color:red}');
  });

  it('@media 내부 규칙을 재귀적으로 스코핑한다', () => {
    const css = '@media (max-width:600px){.ncr-wrap{padding:8px}}';
    expect(scopeCss(css)).toBe('@media (max-width:600px){.ProseMirror .ncr-wrap{padding:8px}}');
  });

  it('@keyframes 내부 셀렉터는 스코핑하지 않는다', () => {
    const css = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}';
    expect(scopeCss(css)).toBe('@keyframes fadeIn{from{opacity:0}to{opacity:1}}');
  });

  it('커스텀 스코프를 지정할 수 있다', () => {
    const css = '.x{a:b}';
    expect(scopeCss(css, '.editor')).toBe('.editor .x{a:b}');
  });

  it('빈/널 입력은 빈 문자열을 반환한다', () => {
    expect(scopeCss('')).toBe('');
    expect(scopeCss(undefined as unknown as string)).toBe('');
  });

  it('실제 템플릿 스타일 블록 형태를 스코핑한다', () => {
    const css = [
      '.ncr-wrap{max-width:760px;margin:0 auto;line-height:2.0;color:#333;padding:16px}',
      '.ncr-section p{margin:0 0 16px}',
      '.ncr-header h1{font-size:1.5rem;line-height:1.4}',
    ].join('\n');
    const out = scopeCss(css);
    expect(out).toContain('.ProseMirror .ncr-wrap{');
    expect(out).toContain('.ProseMirror .ncr-section p{');
    expect(out).toContain('.ProseMirror .ncr-header h1{');
    // 원래 선언부는 훼손되지 않는다
    expect(out).toContain('line-height:2.0');
    expect(out).toContain('margin:0 0 16px');
  });
});
