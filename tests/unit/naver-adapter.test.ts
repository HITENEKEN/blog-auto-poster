import { describe, expect, it } from 'vitest';
import {
  NaverAdapter,
  buildNaverWriteHeaders,
  buildNaverWriteParams,
} from '../../src/platforms/naver/NaverAdapter';
import { ConfigurationError } from '../../src/core/errors';
import type { PlatformPostContent } from '../../src/core/interfaces';

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
  it('rejects with ConfigurationError mentioning accessToken when the token is missing', async () => {
    const adapter = new NaverAdapter();
    await adapter.initialize({ blogId: 'myblog', clientId: 'cid', clientSecret: 'csec' });
    await expect(adapter.createPost(baseContent)).rejects.toThrow(ConfigurationError);
    await expect(adapter.createPost(baseContent)).rejects.toThrow(/accessToken/);
  });

  it('rejects when blogId/clientId/clientSecret are missing entirely', async () => {
    const adapter = new NaverAdapter();
    await expect(adapter.createPost(baseContent)).rejects.toThrow(ConfigurationError);
  });
});
