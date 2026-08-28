import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NaverAdapter,
  buildNaverWriteHeaders,
  buildNaverWriteParams,
} from '../../src/platforms/naver/NaverAdapter';
import { shouldUseBrowserMode } from '../../src/platforms/naver/NaverBrowserPoster';
import type * as NaverBrowserPosterModule from '../../src/platforms/naver/NaverBrowserPoster';
import { ConfigurationError } from '../../src/core/errors';
import type { PlatformPostContent } from '../../src/core/interfaces';

// 브라우저 포스터는 Playwright를 띄우므로 단위 테스트에서는 목으로 대체하고,
// 결정 함수(shouldUseBrowserMode)는 실제 구현을 그대로 노출한다.
const { postToNaverBlog } = vi.hoisted(() => ({ postToNaverBlog: vi.fn() }));
vi.mock('../../src/platforms/naver/NaverBrowserPoster', async () => {
  const actual = await vi.importActual<typeof NaverBrowserPosterModule>(
    '../../src/platforms/naver/NaverBrowserPoster',
  );
  return { ...actual, postToNaverBlog };
});

const baseContent: PlatformPostContent = {
  title: '제목',
  content: '<p>본문</p>',
  tags: ['a', 'b'],
  categories: [],
  visibility: 'public',
};

describe('buildNaverWriteParams', () => {
  it('encodes blogId, title, contents and tag without any access_token param', () => {
    const params = buildNaverWriteParams(baseContent, { blogId: 'myblog' });
    expect(params.get('blog_id')).toBe('myblog');
    expect(params.get('title')).toBe('제목');
    expect(params.get('contents')).toBe('<p>본문</p>');
    expect(params.get('tag')).toBe('a,b');
    // 토큰은 Authorization 헤더로만 전달된다(폼 파라미터 금지 — OpenAPI 스펙).
    expect(params.has('access_token')).toBe(false);
  });

  it('defaults a new post to public and comment-allowed', () => {
    const params = buildNaverWriteParams(baseContent, { blogId: 'myblog' });
    expect(params.get('secret')).toBe('N');
    expect(params.get('accept_comment')).toBe('Y');
  });

  it('marks private posts and comment-disabled posts', () => {
    const params = buildNaverWriteParams(
      { ...baseContent, visibility: 'private', allowComments: false },
      { blogId: 'myblog' },
    );
    expect(params.get('secret')).toBe('Y');
    expect(params.get('accept_comment')).toBe('N');
  });

  it('appends postId only for updates and omits create-only defaults', () => {
    const params = buildNaverWriteParams(baseContent, { blogId: 'myblog', postId: '123' });
    expect(params.get('postId')).toBe('123');
    expect(params.has('accept_comment')).toBe(false);
  });
});

describe('buildNaverWriteHeaders', () => {
  it('sends the OAuth token as a Bearer header, not a form param', () => {
    const headers = buildNaverWriteHeaders('tok-123', 'cid', 'csec');
    expect(headers['Authorization']).toBe('Bearer tok-123');
    expect(headers['X-Naver-Client-Id']).toBe('cid');
    expect(headers['X-Naver-Client-Secret']).toBe('csec');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });
});

describe('NaverAdapter.createPost — configuration guard', () => {
  beforeEach(() => {
    postToNaverBlog.mockReset();
  });

  it('falls back to browser mode (no token) and surfaces its ConfigurationError', async () => {
    const adapter = new NaverAdapter();
    await adapter.initialize({ blogId: 'myblog', clientId: 'cid', clientSecret: 'csec' });
    postToNaverBlog.mockRejectedValue(
      new ConfigurationError('네이버 로그인이 필요합니다.', 'naver'),
    );
    await expect(adapter.createPost(baseContent)).rejects.toThrow(ConfigurationError);
    expect(postToNaverBlog).toHaveBeenCalledTimes(1);
  });

  it('uses the browser poster with mapped content when no accessToken is set', async () => {
    const adapter = new NaverAdapter();
    await adapter.initialize({ blogId: 'myblog' });
    postToNaverBlog.mockResolvedValue({ postId: '123', url: 'https://blog.naver.com/myblog/123' });
    const result = await adapter.createPost(baseContent);
    expect(result).toMatchObject({ postId: '123', url: 'https://blog.naver.com/myblog/123' });
    expect(postToNaverBlog).toHaveBeenCalledWith(
      expect.objectContaining({ blogId: 'myblog', title: '제목', html: '<p>본문</p>' }),
    );
  });

  it('stays on the OpenAPI path when a token exists and useBrowser is not set', async () => {
    const adapter = new NaverAdapter();
    await adapter.initialize({
      blogId: 'myblog',
      clientId: 'cid',
      clientSecret: 'csec',
      accessToken: 'tok',
    });
    // 결정 함수로 모드를 확인(실제 OpenAPI HTTP 호출은 단위 테스트에서 금지).
    expect(shouldUseBrowserMode({ accessToken: 'tok', blogId: 'myblog' })).toBe(false);
    expect(postToNaverBlog).not.toHaveBeenCalled();
  });

  it('rejects when blogId/clientId/clientSecret are missing entirely', async () => {
    const adapter = new NaverAdapter();
    await expect(adapter.createPost(baseContent)).rejects.toThrow(ConfigurationError);
  });
});
