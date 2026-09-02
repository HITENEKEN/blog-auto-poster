import { describe, expect, it } from 'vitest';
import {
  extractNaverPostId,
  filterExistingImagePaths,
  findRecentlyPublishedRssItem,
  parseNaverRss,
  resolveNaverProfileDir,
  shouldUseBrowserMode,
  stripLocalImageTags,
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
