import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolvePostImagePaths } from '../../src/content/postStorage';

// resolvePostImagePaths는 상대경로를 process.cwd() 기준으로 치환하므로
// 테스트마다 임시 디렉터리로 cwd를 옮겨 검증한다.
beforeEach(() => {
  process.chdir(mkdtempSync(join(tmpdir(), 'postimg-')));
});

describe('resolvePostImagePaths (#7) — 발행 이미지 경로 수집', () => {
  it('meta.images 문자열 배열을 절대경로로 치환해 반환한다', () => {
    writeFileSync('img1.png', 'x');
    const paths = resolvePostImagePaths(['img1.png', 'missing.png'], '');
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith('img1.png')).toBe(true);
  });

  it('meta.images의 {localPath} 객체 배열도 지원한다', () => {
    writeFileSync('img2.png', 'x');
    const paths = resolvePostImagePaths([{ localPath: 'img2.png', altText: '' }], '');
    expect(paths).toHaveLength(1);
  });

  it('meta.images가 없으면 post.html의 로컬 <img src>에서 수집한다', () => {
    mkdirSync(join('output', 'images'), { recursive: true });
    writeFileSync(join('output', 'images', 'a.png'), 'x');
    const html = '<p>앞</p><img src="output/images/a.png" /><p>뒤</p>';
    const paths = resolvePostImagePaths(undefined, html);
    expect(paths).toHaveLength(1);
    expect(paths[0].endsWith('a.png')).toBe(true);
  });

  it('http(s)/data URL은 수집하지 않는다', () => {
    const html =
      '<img src="https://cdn.example.com/x.png" /><img src="data:image/png;base64,AAA" />';
    expect(resolvePostImagePaths(undefined, html)).toEqual([]);
  });

  it('중복 경로는 하나만 반환한다', () => {
    writeFileSync('img3.png', 'x');
    const paths = resolvePostImagePaths(['img3.png', './img3.png', 'img3.png'], '');
    expect(paths).toHaveLength(1);
  });
});
