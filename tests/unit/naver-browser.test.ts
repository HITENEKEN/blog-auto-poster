import { describe, expect, it } from 'vitest';
import {
  extractNaverPostId,
  filterExistingImagePaths,
  findRecentlyPublishedRssItem,
  parseNaverRss,
  resolveNaverProfileDir,
  shouldUseBrowserMode,
  stripLocalImageTags,
  verifyPastedContentIntegrity,
  rewriteLocalImageSrcs,
} from '../../src/platforms/naver/NaverBrowserPoster';

describe('shouldUseBrowserMode', () => {
  it('returns true when useBrowser is explicitly set, even with a token', () => {
    expect(shouldUseBrowserMode({ useBrowser: true })).toBe(true);
    expect(shouldUseBrowserMode({ useBrowser: true, accessToken: 'tok' })).toBe(true);
  });

  it('returns false when a token exists and useBrowser is not true', () => {
    expect(shouldUseBrowserMode({ accessToken: 'tok' })).toBe(false);
    expect(shouldUseBrowserMode({ accessToken: 'tok', useBrowser: false })).toBe(false);
    expect(shouldUseBrowserMode({ accessToken: 'tok', useBrowser: 'yes' })).toBe(false);
  });

  it('returns true when no accessToken is configured (OpenAPI path cannot work)', () => {
    expect(shouldUseBrowserMode({})).toBe(true);
    expect(shouldUseBrowserMode({ blogId: 'myblog', clientId: 'c', clientSecret: 's' })).toBe(true);
    expect(shouldUseBrowserMode({ accessToken: '' })).toBe(true);
  });
});

describe('resolveNaverProfileDir', () => {
  it('resolves to data/browser-profiles/naver under the given cwd', () => {
    expect(resolveNaverProfileDir('/srv/app')).toBe('/srv/app/data/browser-profiles/naver');
  });
});

describe('extractNaverPostId', () => {
  it('extracts logNo from a published post URL', () => {
    expect(extractNaverPostId('https://blog.naver.com/myblog/223456789012')).toBe('223456789012');
    expect(
      extractNaverPostId('https://blog.naver.com/myblog/223456789012?Redirect=Write&afterWrite=1'),
    ).toBe('223456789012');
  });

  it('extracts logNo from the PostView.naver redirect form', () => {
    expect(
      extractNaverPostId(
        'https://blog.naver.com/PostView.naver?blogId=myblog&Redirect=View&logNo=224394017200&categoryNo=1&isAfterWrite=true',
      ),
    ).toBe('224394017200');
  });

  it('returns null for non-post URLs', () => {
    expect(extractNaverPostId('https://blog.naver.com/myblog/postwrite')).toBeNull();
    expect(extractNaverPostId('https://blog.naver.com/myblog')).toBeNull();
    expect(extractNaverPostId('https://nid.naver.com/nidlogin.login')).toBeNull();
    expect(extractNaverPostId('not a url')).toBeNull();
  });
});

describe('stripLocalImageTags (#7) — 로컬 경로 img 태그 제거', () => {
  it('output/images 상대경로 img 태그를 제거한다', () => {
    const html = '<p>본문</p><img src="output/images/a.png" alt="x" /><p>뒤</p>';
    expect(stripLocalImageTags(html)).toBe('<p>본문</p><p>뒤</p>');
  });

  it('http(s)/data URL img 태그는 유지한다', () => {
    const html =
      '<img src="https://example.com/a.png" /><img src="data:image/png;base64,AAA" /><img src="//cdn.example.com/b.png" />';
    expect(stripLocalImageTags(html)).toBe(html);
  });

  it('빈 문자열은 그대로 반환한다', () => {
    expect(stripLocalImageTags('')).toBe('');
  });
});

describe('filterExistingImagePaths (#7) — 업로드 대상 필터', () => {
  it('존재하지 않는 파일과 중복을 제외하고 순서를 유지한다', () => {
    const exists = (p: string) => p === '/a.png' || p === '/b.png';
    expect(
      filterExistingImagePaths(['/a.png', '/missing.png', '/b.png', '/a.png'], exists),
    ).toEqual(['/a.png', '/b.png']);
  });

  it('undefined/빈 배열이면 빈 배열을 반환한다', () => {
    expect(filterExistingImagePaths(undefined)).toEqual([]);
    expect(filterExistingImagePaths([])).toEqual([]);
  });
});

// 네이버 블로그 RSS 실제 구조(2026-08 기준)를 축소한 샘플
const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:activity="http://activitystrea.ms/spec/1.0/" version="2.0">
  <channel>
    <title><![CDATA[HITENEKEN]]></title>
    <link><![CDATA[https://blog.naver.com/myblog?fromRss=true&trackingCode=rss]]></link>
    <item>
      <author>myblog</author>
      <category><![CDATA[게시판]]></category>
      <title><![CDATA[아디다스져지 직접 써본 솔직 후기 - 장단점과 사용기]]></title>
      <link><![CDATA[https://blog.naver.com/myblog/224396487090?fromRss=true&trackingCode=rss]]></link>
      <guid>https://blog.naver.com/myblog/224396487090</guid>
      <description><![CDATA[본문 요약]]></description>
      <pubDate>Mon, 31 Aug 2026 21:00:18 +0900</pubDate>
    </item>
    <item>
      <title><![CDATA[코웰패션 고르는 법 - 초보를 위한 완벽 가이드 2026]]></title>
      <link><![CDATA[https://blog.naver.com/myblog/224396480331?fromRss=true&trackingCode=rss]]></link>
      <pubDate>Mon, 31 Aug 2026 20:53:34 +0900</pubDate>
    </item>
  </channel>
</rss>`;

describe('parseNaverRss — RSS 재검증 파싱(이슈 #10)', () => {
  it('item의 제목/링크/logNo/pubDate를 파싱한다', () => {
    const items = parseNaverRss(RSS_SAMPLE);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('아디다스져지 직접 써본 솔직 후기 - 장단점과 사용기');
    expect(items[0].logNo).toBe('224396487090');
    expect(items[0].pubDate?.getUTCDate()).toBe(new Date('2026-08-31T12:00:18Z').getUTCDate());
  });

  it('빈/형식이 틀린 XML은 빈 배열을 반환한다', () => {
    expect(parseNaverRss('')).toEqual([]);
    expect(parseNaverRss('<rss><channel></channel></rss>')).toEqual([]);
  });
});

describe('findRecentlyPublishedRssItem — 발행 오판 방지(이슈 #10)', () => {
  const now = new Date('2026-08-31T21:10:00+09:00'); // 첫 item 발행 10분 후

  it('최근 30분 내 동일 제목 게시물을 찾아 logNo를 반환한다', () => {
    const item = findRecentlyPublishedRssItem(
      RSS_SAMPLE,
      '아디다스져지 직접 써본 솔직 후기 - 장단점과 사용기',
      now,
    );
    expect(item?.logNo).toBe('224396487090');
  });

  it('공백 차이는 무시하고 제목을 비교한다', () => {
    const item = findRecentlyPublishedRssItem(
      RSS_SAMPLE,
      '아디다스져지  직접 써본  솔직 후기 - 장단점과 사용기',
      now,
    );
    expect(item?.logNo).toBe('224396487090');
  });

  it('30분 이전에 발행된 게시물은 실패로 판정한다(null)', () => {
    const later = new Date('2026-09-01T05:00:00+09:00');
    const item = findRecentlyPublishedRssItem(
      RSS_SAMPLE,
      '아디다스져지 직접 써본 솔직 후기 - 장단점과 사용기',
      later,
    );
    expect(item).toBeNull();
  });

  it('다른 제목이면 null을 반환한다', () => {
    const item = findRecentlyPublishedRssItem(RSS_SAMPLE, '전혀 다른 제목의 포스트', now);
    expect(item).toBeNull();
  });

  it('빈 XML이면 null을 반환한다', () => {
    expect(findRecentlyPublishedRssItem('', '제목', now)).toBeNull();
  });
});

describe('verifyPastedContentIntegrity (#15/#20) — 붙여넣기 무결성 검증', () => {
  const richHtml = [
    '<p>본문</p>',
    '<a href="https://link.coupang.com/a/1" target="_blank">구매하기</a>',
    '<a href="https://event.coupang.com/1">이벤트</a>',
    '<img src="https://example.com/a.png" />',
  ].join('');

  it('모든 임베드 요소가 살아있으면 ok=true', () => {
    expect(verifyPastedContentIntegrity(richHtml, richHtml).ok).toBe(true);
  });

  it('iframe은 기대하지 않는다 — 유실돼도 ok=true (이슈 #20 원인 B)', () => {
    // 네이버는 iframe을 100% 제거한다. iframe을 기대값에 넣으면 정상 발행도 항상
    // 실패로 판정됐고, 그 실패가 파괴적 폴백을 트리거해 본문을 망가뜨렸다.
    const withIframe = `${richHtml}<iframe src="https://coupa.ng/x"></iframe>`;
    const integrity = verifyPastedContentIntegrity(withIframe, richHtml);
    expect(integrity.ok).toBe(true);
    expect(integrity.links).toEqual({ expected: 2, found: 2 });
  });

  it('링크가 유실되면 ok=false', () => {
    const pasted = richHtml.replace(/<a\b[^>]*>[^<]*<\/a>/g, '');
    const integrity = verifyPastedContentIntegrity(richHtml, pasted);
    expect(integrity.links).toEqual({ expected: 2, found: 0 });
    expect(integrity.ok).toBe(false);
  });

  it('부분 링크 유실(1/2)도 감지한다', () => {
    const pasted = richHtml.replace('<a href="https://event.coupang.com/1">이벤트</a>', '');
    const integrity = verifyPastedContentIntegrity(richHtml, pasted);
    expect(integrity.links).toEqual({ expected: 2, found: 1 });
    expect(integrity.ok).toBe(false);
  });

  it('붙여넣기 결과가 비어 있으면 ok=false', () => {
    const integrity = verifyPastedContentIntegrity(richHtml, '');
    expect(integrity.ok).toBe(false);
  });

  it('원본에 임베드 요소가 없으면 빈 결과여도 ok=true (순수 텍스트 발행)', () => {
    const textOnly = '<p>텍스트만 있는 본문</p>';
    expect(verifyPastedContentIntegrity(textOnly, '').ok).toBe(true);
  });

  it('SE가 이미지에 붙이는 se-module-image-link 앵커는 링크로 세지 않는다 (원인 E)', () => {
    // SE는 이미지마다 <a href="#" class="se-module-image-link">를 감싼다.
    // 이걸 세면 링크 수가 부풀어 정상 발행이 실패로 판정된다.
    const published = [
      '<a href="#" class="se-module-image-link"><img src="https://postfiles.pstatic.net/a.png"></a>',
      '<a href="https://link.coupang.com/a/1">구매하기</a>',
    ].join('');
    const integrity = verifyPastedContentIntegrity(published, published);
    expect(integrity.links).toEqual({ expected: 1, found: 1 });
    expect(integrity.images).toEqual({ expected: 1, found: 1 });
    expect(integrity.ok).toBe(true);
  });

  it('href가 http(s)가 아닌 앵커는 세지 않는다 — SE가 버리는 링크 (원인 C)', () => {
    const html = '<a href="#">가격 확인하기</a><a href="/local">로컬</a><p>본문</p>';
    const integrity = verifyPastedContentIntegrity(html, '<p>본문</p>');
    expect(integrity.links).toEqual({ expected: 0, found: 0 });
    expect(integrity.ok).toBe(true);
  });

  it('src가 없는 img는 이미지로 세지 않는다', () => {
    const html = '<img alt="빈 이미지"><img src="https://example.com/a.png">';
    expect(verifyPastedContentIntegrity(html, html).images).toEqual({ expected: 1, found: 1 });
  });

  it('이미지가 유실되면 ok=false', () => {
    const integrity = verifyPastedContentIntegrity(richHtml, '<p>본문</p>');
    expect(integrity.images).toEqual({ expected: 1, found: 0 });
    expect(integrity.ok).toBe(false);
  });
});

describe('findRecentlyPublishedRssItem — 제목 접두사 매칭(이슈 #16)', () => {
  // 네이버 RSS가 긴 제목을 잘라내는 상황을 재현한 샘플
  const TRUNCATED_RSS = `<?xml version="1.0" encoding="UTF-8"?>
  <rss version="2.0"><channel>
    <item>
      <title><![CDATA[아디다스져지 직접 써본 솔직 후기 - 장단점과 사용...]]></title>
      <link><![CDATA[https://blog.naver.com/myblog/224396487090]]></link>
      <pubDate>Mon, 31 Aug 2026 21:00:18 +0900</pubDate>
    </item>
  </channel></rss>`;
  const now = new Date('2026-08-31T21:10:00+09:00');
  const fullTitle = '아디다스져지 직접 써본 솔직 후기 - 장단점과 사용기 2026 총정리';

  it('RSS 제목이 잘려 있어도 접두사 일치로 발행 게시물을 찾는다', () => {
    const item = findRecentlyPublishedRssItem(TRUNCATED_RSS, fullTitle, now);
    expect(item?.logNo).toBe('224396487090');
  });

  it('반대로 입력 제목이 잘려 있어도 찾는다', () => {
    const item = findRecentlyPublishedRssItem(
      TRUNCATED_RSS,
      '아디다스져지 직접 써본 솔직 후기',
      now,
    );
    expect(item?.logNo).toBe('224396487090');
  });

  it('짧은 제목(10자 미만)은 접두사 매칭을 적용하지 않는다 — 오탐 방지', () => {
    const item = findRecentlyPublishedRssItem(TRUNCATED_RSS, '아디다스', now);
    expect(item).toBeNull();
  });

  it('10자 이상이어도 공통 접두사가 없으면 매칭하지 않는다', () => {
    const item = findRecentlyPublishedRssItem(
      TRUNCATED_RSS,
      '완전히 다른 제목의 포스트입니다',
      now,
    );
    expect(item).toBeNull();
  });
});

describe('rewriteLocalImageSrcs (이슈 #20 T1) — 업로드 URL을 본문 제자리에 되돌리기', () => {
  const NAVER_A = 'https://postfiles.pstatic.net/a.png?type=w808';
  const NAVER_B = 'https://postfiles.pstatic.net/b.png?type=w808';

  it('로컬 img src를 업로드 회수 URL로 치환하고 본문 순서를 보존한다', () => {
    const html = [
      '<p>도입</p>',
      '<img src="output/images/a.png">',
      '<p>중간</p>',
      '<img src="output/images/b.png">',
      '<p>끝</p>',
    ].join('');
    const { html: out, unresolved } = rewriteLocalImageSrcs(
      html,
      new Map([
        ['output/images/a.png', NAVER_A],
        ['output/images/b.png', NAVER_B],
      ]),
    );
    expect(out).toContain(`src="${NAVER_A}"`);
    expect(out).toContain(`src="${NAVER_B}"`);
    expect(out).toContain('<p>중간</p>');
    // 이미지가 원본 위치(섹션 사이)를 그대로 지킨다 — 원인 A 해소.
    expect(out.indexOf(NAVER_A)).toBeLessThan(out.indexOf('중간'));
    expect(out.indexOf('중간')).toBeLessThan(out.indexOf(NAVER_B));
    expect(unresolved).toEqual([]);
  });

  it('매핑이 없는 로컬 img는 제거하고 unresolved에 기록한다', () => {
    const { html: out, unresolved } = rewriteLocalImageSrcs(
      '<p>본문</p><img src="output/images/missing.png">',
      new Map(),
    );
    expect(out).toBe('<p>본문</p>');
    expect(unresolved).toEqual(['output/images/missing.png']);
  });

  it('경로 형식이 달라도 basename으로 매칭한다', () => {
    const { html: out } = rewriteLocalImageSrcs(
      '<img src="images/a.png">',
      new Map([['output/images/a.png', NAVER_A]]),
    );
    expect(out).toContain(NAVER_A);
  });

  it('백슬래시(윈도우) 경로도 basename으로 매칭한다', () => {
    const { html: out } = rewriteLocalImageSrcs(
      '<img src="output\\images\\a.png">',
      new Map([['output/images/a.png', NAVER_A]]),
    );
    expect(out).toContain(NAVER_A);
  });

  it('http(s) / 프로토콜 상대 / data URL 이미지는 건드리지 않는다', () => {
    const html =
      '<img src="https://x.com/a.png"><img src="//cdn.x.com/b.png"><img src="data:image/png;base64,AAA">';
    const { html: out, unresolved } = rewriteLocalImageSrcs(html, new Map());
    expect(out).toBe(html);
    expect(unresolved).toEqual([]);
  });

  it('같은 로컬 파일을 여러 번 참조하면 첫 번째만 치환하고 나머지는 제거한다', () => {
    const html =
      '<img src="output/images/a.png"><img src="https://x.com/keep.png">' +
      '<img src="output/images/a.png">';
    const { html: out, unresolved } = rewriteLocalImageSrcs(
      html,
      new Map([['output/images/a.png', NAVER_A]]),
    );
    expect(out.match(new RegExp(NAVER_A.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toHaveLength(
      1,
    );
    expect(out).toContain('https://x.com/keep.png');
    // 중복 제거 사유는 한 번만 기록한다.
    expect(unresolved).toEqual(['output/images/a.png']);
  });

  it('URL에 $가 섞여 있어도 치환 패턴으로 해석되지 않는다', () => {
    const tricky = 'https://postfiles.pstatic.net/a$&$1.png';
    const { html: out } = rewriteLocalImageSrcs(
      '<img src="images/a.png">',
      new Map([['images/a.png', tricky]]),
    );
    expect(out).toContain(tricky);
  });

  it('빈 문자열은 그대로 반환한다', () => {
    expect(rewriteLocalImageSrcs('', new Map())).toEqual({ html: '', unresolved: [] });
  });
});
