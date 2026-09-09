import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  collectRemoteImageUrls,
  downloadRemoteImages,
  imageExtensionFor,
  loadRemoteImageCache,
  pickReusableCachedImages,
  rememberRemoteImages,
  remoteImageCacheKey,
  replaceImageSrcs,
} from '../../src/platforms/naver/RemoteImages';

describe('collectRemoteImageUrls — 네이버가 호스팅하지 않는 이미지 수집', () => {
  it('외부 이미지만 문서 순서로 모으고 네이버 이미지는 건너뛴다', () => {
    const html = [
      '<img src="https://blogfiles.pstatic.net/a.png">',
      '<img src="https://img1a.coupangcdn.com/image/affiliate/widget/a.jpeg">',
      '<img src="https://postfiles.pstatic.net/b.png?type=w1">',
      '<img src="https://img4a.coupangcdn.com/image/affiliate/banner/b@2x.jpg">',
    ].join('');
    expect(collectRemoteImageUrls(html)).toEqual([
      'https://img1a.coupangcdn.com/image/affiliate/widget/a.jpeg',
      'https://img4a.coupangcdn.com/image/affiliate/banner/b@2x.jpg',
    ]);
  });

  it('중복 주소는 한 번만 센다', () => {
    const img = '<img src="https://cdn.example.com/a.jpg">';
    expect(collectRemoteImageUrls(img + img)).toHaveLength(1);
  });

  it('프로토콜 상대 주소는 https로 정규화하고, 로컬 경로는 무시한다', () => {
    const html = '<img src="//cdn.example.com/a.jpg"><img src="output/images/local.png">';
    expect(collectRemoteImageUrls(html)).toEqual(['https://cdn.example.com/a.jpg']);
  });

  it('src의 &amp;를 되돌려 실제 주소로 모은다', () => {
    expect(collectRemoteImageUrls('<img src="https://cdn.example.com/a.jpg?x=1&amp;y=2">')).toEqual(
      ['https://cdn.example.com/a.jpg?x=1&y=2'],
    );
  });
});

describe('imageExtensionFor', () => {
  it('content-type을 우선한다', () => {
    expect(imageExtensionFor('https://c/x', 'image/png; charset=binary')).toBe('.png');
  });

  it('content-type이 없으면 경로 확장자를 쓴다 (.jpeg는 .jpg로)', () => {
    expect(imageExtensionFor('https://c/a@2x.jpg')).toBe('.jpg');
    expect(imageExtensionFor('https://c/a.jpeg')).toBe('.jpg');
  });

  it('업로드할 수 없는 형식이면 null — 원래 주소를 유지한다', () => {
    expect(imageExtensionFor('https://c/a.webp')).toBeNull();
    expect(imageExtensionFor('https://c/noext')).toBeNull();
  });
});

describe('replaceImageSrcs', () => {
  it('매핑된 이미지만 치환하고 나머지는 그대로 둔다', () => {
    const html =
      '<img src="https://cdn.example.com/a.jpg" alt="상품"><img src="https://cdn.example.com/b.jpg">';
    const out = replaceImageSrcs(
      html,
      new Map([['https://cdn.example.com/a.jpg', 'https://postfiles.pstatic.net/x.jpg']]),
    );
    expect(out).toContain('src="https://postfiles.pstatic.net/x.jpg" alt="상품"');
    expect(out).toContain('src="https://cdn.example.com/b.jpg"');
  });

  it('URL에 $가 있어도 치환 패턴으로 해석되지 않는다', () => {
    const out = replaceImageSrcs(
      '<img src="https://cdn.example.com/a.jpg">',
      new Map([['https://cdn.example.com/a.jpg', 'https://postfiles.pstatic.net/$&x.jpg']]),
    );
    expect(out).toContain('src="https://postfiles.pstatic.net/$&x.jpg"');
  });

  it('매핑이 비면 원본을 그대로 반환한다', () => {
    const html = '<img src="https://cdn.example.com/a.jpg">';
    expect(replaceImageSrcs(html, new Map())).toBe(html);
  });
});

describe('downloadRemoteImages', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  it('받은 이미지를 파일로 저장하고 주소→경로 매핑을 준다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-img-test-'));
    try {
      const result = await downloadRemoteImages(
        ['https://cdn.example.com/a.jpg'],
        dir,
        async () => ({ status: 200, contentType: 'image/png', data: png }),
      );
      const file = result.localByUrl.get('https://cdn.example.com/a.jpg');
      expect(file).toBeTruthy();
      expect(readFileSync(file!)).toEqual(png);
      expect(result.failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('실패는 격리하고 나머지는 계속 받는다 (못 받은 건 원래 주소로 발행)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-img-test-'));
    try {
      const result = await downloadRemoteImages(
        ['https://cdn.example.com/bad.jpg', 'https://cdn.example.com/ok.jpg'],
        dir,
        async (url) =>
          url.includes('bad')
            ? { status: 404, contentType: '', data: Buffer.alloc(0) }
            : { status: 200, contentType: 'image/png', data: png },
      );
      expect(result.localByUrl.has('https://cdn.example.com/ok.jpg')).toBe(true);
      expect(result.localByUrl.has('https://cdn.example.com/bad.jpg')).toBe(false);
      expect(result.failures.join(' ')).toContain('status 404');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('상한을 넘는 이미지는 건너뛰고 사유를 남긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-img-test-'));
    try {
      const urls = ['https://c/1.jpg', 'https://c/2.jpg', 'https://c/3.jpg'];
      const result = await downloadRemoteImages(
        urls,
        dir,
        async () => ({ status: 200, contentType: 'image/png', data: png }),
        2,
      );
      expect(result.localByUrl.size).toBe(2);
      expect(result.failures.join(' ')).toContain('상한(2)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('업로드 캐시 — 같은 광고 이미지는 한 번만 올린다', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const cacheFile = () => join(mkdtempSync(join(tmpdir(), 'img-cache-')), 'cache.json');

  it('저장한 매핑을 다시 읽는다', () => {
    const file = cacheFile();
    rememberRemoteImages(
      new Map([['https://cdn.example.com/a.jpg', 'https://blogfiles.pstatic.net/a.jpg']]),
      file,
    );
    expect(
      loadRemoteImageCache(file).get(remoteImageCacheKey('https://cdn.example.com/a.jpg')),
    ).toBe('https://blogfiles.pstatic.net/a.jpg');
  });

  it('여러 번 저장해도 기존 매핑을 잃지 않는다', () => {
    const file = cacheFile();
    rememberRemoteImages(
      new Map([['https://c/a.jpg', 'https://blogfiles.pstatic.net/a.jpg']]),
      file,
    );
    rememberRemoteImages(
      new Map([['https://c/b.jpg', 'https://blogfiles.pstatic.net/b.jpg']]),
      file,
    );
    expect(loadRemoteImageCache(file).size).toBe(2);
  });

  it('파일이 없거나 깨졌으면 빈 캐시로 시작한다', () => {
    expect(loadRemoteImageCache(join(tmpdir(), 'nope-does-not-exist.json')).size).toBe(0);
  });

  it('캐시에 있고 아직 살아 있으면 재사용한다 (업로드 대상에서 빠진다)', async () => {
    const cache = new Map([
      [remoteImageCacheKey('https://c/a.jpg'), 'https://blogfiles.pstatic.net/a.jpg'],
    ]);
    const picked = await pickReusableCachedImages(['https://c/a.jpg'], cache, async () => ({
      status: 200,
      contentType: 'image/jpeg',
      data: png,
    }));
    expect(picked.reusable.get('https://c/a.jpg')).toBe('https://blogfiles.pstatic.net/a.jpg');
    expect(picked.missing).toEqual([]);
  });

  it('캐시된 네이버 파일이 사라졌으면 다시 올릴 대상으로 넘긴다', async () => {
    const cache = new Map([
      [remoteImageCacheKey('https://c/a.jpg'), 'https://blogfiles.pstatic.net/gone.jpg'],
    ]);
    const picked = await pickReusableCachedImages(['https://c/a.jpg'], cache, async () => ({
      status: 404,
      contentType: '',
      data: Buffer.alloc(0),
    }));
    expect(picked.reusable.size).toBe(0);
    expect(picked.missing).toEqual(['https://c/a.jpg']);
  });

  it('캐시에 없는 주소는 그대로 업로드 대상이다', async () => {
    const picked = await pickReusableCachedImages(['https://c/new.jpg'], new Map(), async () => {
      throw new Error('확인 요청이 일어나선 안 된다');
    });
    expect(picked.missing).toEqual(['https://c/new.jpg']);
  });
});

describe('remoteImageCacheKey — 샤딩 CDN 호스트 무시 (2026-09-08 실측)', () => {
  it('쿠팡은 같은 파일을 여러 호스트로 주므로 경로로 식별한다', () => {
    // 실측: 1시간 안에 같은 이미지가 img1a → image8 로 호스트가 바뀌었다.
    // 전체 URL을 키로 쓰면 매번 빗나가 같은 이미지를 계속 재업로드한다.
    const a = remoteImageCacheKey(
      'https://img1a.coupangcdn.com/image/affiliate/widget/manual/2019/02/15/624c98ed.jpeg',
    );
    const b = remoteImageCacheKey(
      'https://image8.coupangcdn.com/image/affiliate/widget/manual/2019/02/15/624c98ed.jpeg',
    );
    expect(a).toBe(b);
    expect(a).toBe('coupangcdn.com/image/affiliate/widget/manual/2019/02/15/624c98ed.jpeg');
  });

  it('경로가 다르면 다른 키다', () => {
    expect(remoteImageCacheKey('https://img1a.coupangcdn.com/a.jpg')).not.toBe(
      remoteImageCacheKey('https://img1a.coupangcdn.com/b.jpg'),
    );
  });

  it('샤딩 CDN이 아니면 호스트를 유지한다', () => {
    expect(remoteImageCacheKey('https://cdn.example.com/a.jpg?v=2')).toBe(
      'cdn.example.com/a.jpg?v=2',
    );
    expect(remoteImageCacheKey('https://other.example.com/a.jpg?v=2')).not.toBe(
      'cdn.example.com/a.jpg?v=2',
    );
  });

  it('호스트가 달라도 캐시가 적중한다', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'img-cache-')), 'cache.json');
    rememberRemoteImages(
      new Map([
        [
          'https://img1a.coupangcdn.com/image/affiliate/a.jpeg',
          'https://blogfiles.pstatic.net/a.jpg',
        ],
      ]),
      file,
    );
    const picked = await pickReusableCachedImages(
      ['https://image8.coupangcdn.com/image/affiliate/a.jpeg'],
      loadRemoteImageCache(file),
      async () => ({ status: 200, contentType: 'image/jpeg', data: Buffer.from([1]) }),
    );
    expect(picked.missing).toEqual([]);
    expect(picked.reusable.size).toBe(1);
  });
});
