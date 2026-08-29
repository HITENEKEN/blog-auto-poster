import { describe, expect, it } from 'vitest';
import {
  extractNaverPostId,
  resolveNaverProfileDir,
  shouldUseBrowserMode,
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
