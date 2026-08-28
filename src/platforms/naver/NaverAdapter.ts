import { createHttpClient } from '@core/http';
import { getLogger } from '@core/logger';
import { getConfigManager } from '@core/config';
import {
  PlatformAdapter,
  PlatformCredentials,
  PlatformPostContent,
  PlatformPostResult,
  PlatformCategory,
  PlatformImage,
  PlatformFeature,
} from '@core/interfaces';
import {
  ConfigurationError,
  PlatformError,
  AuthenticationError,
  ValidationError,
} from '@core/errors';

const logger = getLogger('naver-adapter');

const NAVER_OPENAPI_BASE = 'https://openapi.naver.com';

interface NaverWriteResponse {
  result?: string;
  reason?: string;
  postId?: string;
  postUrl?: string;
}

interface NaverCategoryResponse {
  result?: string;
  reason?: string;
  categories?: Array<{ no: number; name: string; parent?: number }>;
  defaultCategory?: string;
}

/**
 * Full Naver Blog posting adapter using the Naver Blog Open API
 * (https://developers.naver.com/docs/blog/blog-openapi/).
 *
 * Auth model:
 *  - Application credentials: clientId / clientSecret (Naver Developers app, blog write scope)
 *  - User credential: accessToken (Naver Login OAuth token granted with blog write scope),
 *    sent as the `Authorization: Bearer {accessToken}` header per the OpenAPI spec
 *  - Target: blogId (the Naver blog id to post to)
 *
 * Credentials are read from `configManager.getPlatformConfig('naver')` so the
 * adapter works both when initialized at startup and when called directly from
 * routes (e.g. /api/blogs, /api/posts/:id/publish) without a prior initialize().
 */

/**
 * Assemble the form body for the Naver Blog OpenAPI write endpoint
 * (POST /blog/writePost.json). Pure function so the param shape can be unit-tested.
 *
 * Auth is carried entirely in headers (see buildNaverWriteHeaders) — the
 * access token is deliberately NOT a form param.
 */
export function buildNaverWriteParams(
  content: Partial<PlatformPostContent>,
  opts: { blogId: string; postId?: string },
): URLSearchParams {
  const params = new URLSearchParams();
  params.append('blog_id', opts.blogId);
  if (opts.postId != null) params.append('postId', opts.postId);
  if (content.title) params.append('title', content.title);
  if (content.content) params.append('contents', content.content);
  if (content.categoryId) params.append('category', String(content.categoryId));
  if (content.tags && content.tags.length > 0) {
    params.append('tag', content.tags.join(','));
  }
  if (content.visibility != null || opts.postId == null) {
    params.append('secret', content.visibility === 'private' ? 'Y' : 'N');
  }
  if (opts.postId == null) {
    params.append('accept_comment', content.allowComments === false ? 'N' : 'Y');
  }
  return params;
}

/**
 * Headers for the Naver Blog OpenAPI write endpoint. The OAuth access token
 * goes in the Authorization Bearer header, alongside the static application
 * credentials.
 */
export function buildNaverWriteHeaders(
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'X-Naver-Client-Id': clientId,
    'X-Naver-Client-Secret': clientSecret,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
}

export class NaverAdapter implements PlatformAdapter {
  readonly name = 'naver';
  readonly supportedFeatures: PlatformFeature[] = ['categories', 'tags', 'seo_fields'];

  private client = createHttpClient({
    baseURL: NAVER_OPENAPI_BASE,
    timeout: 60000,
    maxRetries: 2,
    rateLimit: {
      requestsPerMinute: 30,
    },
  });

  private config: PlatformCredentials | null = null;
  private initialized = false;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    this.config = credentials;
    this.initialized = true;
    logger.info('Naver adapter initialized');
  }

  /**
   * Resolve effective credentials: prefer an explicit initialize() payload,
   * otherwise fall back to the persisted platform config (so the adapter is
   * usable from routes that don't pre-initialize it).
   */
  private resolveConfig(): PlatformCredentials {
    if (this.config && Object.keys(this.config).length > 0) {
      return this.config;
    }
    try {
      const cm = getConfigManager();
      return cm.getPlatformConfig('naver') || {};
    } catch {
      return {};
    }
  }

  /**
   * Validate that the static application credentials are configured.
   * The runtime OAuth accessToken is required only at post time (see createPost),
   * so it is intentionally NOT part of this static-config check.
   */
  async validateCredentials(): Promise<boolean> {
    const cfg = this.resolveConfig();
    const { blogId, clientId, clientSecret } = cfg as Record<string, unknown>;
    return Boolean(blogId && clientId && clientSecret);
  }

  async createPost(content: PlatformPostContent): Promise<PlatformPostResult> {
    const cfg = this.resolveConfig() as Record<string, unknown>;
    const blogId = String(cfg.blogId ?? '');
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const accessToken = cfg.accessToken != null ? String(cfg.accessToken) : '';

    if (!blogId || !clientId || !clientSecret) {
      throw new ConfigurationError(
        'Naver blog posting is not configured. Set platforms.naver.blogId, clientId, and clientSecret in Settings.',
        'naver',
      );
    }
    if (!accessToken) {
      throw new ConfigurationError(
        'Naver blog posting requires an access token (Naver Login OAuth with blog-write scope). ' +
          'Set platforms.naver.accessToken.',
        'naver',
      );
    }

    const params = buildNaverWriteParams(content, { blogId });
    try {
      const response = await this.client.post<NaverWriteResponse>(
        '/blog/writePost.json',
        params.toString(),
        {
          headers: buildNaverWriteHeaders(accessToken, clientId, clientSecret),
        },
      );

      const data = response.data;
      if (!data || data.result !== 'ok' || !data.postId) {
        const reason = data?.reason || 'unknown error';
        logger.error({ reason }, 'Naver blog write failed');
        throw new PlatformError(
          `Naver blog write failed: ${reason}`,
          'naver',
          'createPost',
          502,
          false,
          { response: data },
        );
      }

      const postId = String(data.postId);
      const url = data.postUrl || `https://blog.naver.com/${blogId}/${postId}`;
      logger.info({ postId, url }, 'Naver post created successfully');

      return {
        postId,
        url,
        publishedAt: new Date(),
      };
    } catch (error) {
      if (
        error instanceof ConfigurationError ||
        error instanceof PlatformError ||
        error instanceof AuthenticationError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      logger.error({ error: String(error) }, 'Naver createPost failed');
      throw new PlatformError(
        `Naver createPost failed: ${String(error)}`,
        'naver',
        'createPost',
        502,
        false,
        { originalError: String(error) },
      );
    }
  }

  async updatePost(
    postId: string,
    content: Partial<PlatformPostContent>,
  ): Promise<PlatformPostResult> {
    const cfg = this.resolveConfig() as Record<string, unknown>;
    const blogId = String(cfg.blogId ?? '');
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const accessToken = cfg.accessToken != null ? String(cfg.accessToken) : '';

    if (!blogId || !clientId || !clientSecret || !accessToken) {
      throw new ConfigurationError(
        'Naver blog update requires blogId, clientId, clientSecret, and accessToken.',
        'naver',
      );
    }

    const params = buildNaverWriteParams(content, { blogId, postId });
    try {
      const response = await this.client.post<NaverWriteResponse>(
        '/blog/writePost.json',
        params.toString(),
        {
          headers: buildNaverWriteHeaders(accessToken, clientId, clientSecret),
        },
      );
      const data = response.data;
      if (!data || data.result !== 'ok' || !data.postId) {
        throw new PlatformError(
          `Naver blog update failed: ${data?.reason || 'unknown error'}`,
          'naver',
          'updatePost',
          502,
          false,
          { response: data },
        );
      }
      const id = String(data.postId);
      const url = data.postUrl || `https://blog.naver.com/${blogId}/${id}`;
      return {
        postId: id,
        url,
        publishedAt: new Date(),
      };
    } catch (error) {
      if (
        error instanceof ConfigurationError ||
        error instanceof PlatformError ||
        error instanceof AuthenticationError ||
        error instanceof ValidationError
      ) {
        throw error;
      }
      throw new PlatformError(
        `Naver updatePost failed: ${String(error)}`,
        'naver',
        'updatePost',
        502,
        false,
        { originalError: String(error) },
      );
    }
  }

  async getCategories(blogName?: string): Promise<PlatformCategory[]> {
    const cfg = this.resolveConfig() as Record<string, unknown>;
    const blogId = blogName ? String(blogName) : String(cfg.blogId ?? '');
    const clientId = String(cfg.clientId ?? '');
    const clientSecret = String(cfg.clientSecret ?? '');
    const accessToken = cfg.accessToken != null ? String(cfg.accessToken) : '';

    // Without full credentials we cannot query the API — return a safe default
    // so callers (e.g. /api/blogs) never break.
    if (!blogId || !clientId || !clientSecret || !accessToken) {
      return this.defaultCategories();
    }

    try {
      const response = await this.client.get<NaverCategoryResponse>('/blog/category', {
        headers: {
          'X-Naver-Client-Id': clientId,
          'X-Naver-Client-Secret': clientSecret,
        },
        params: {
          access_token: accessToken,
          blog_id: blogId,
        },
      });

      const data = response.data;
      if (data?.result === 'ok' && Array.isArray(data.categories)) {
        return data.categories.map((c) => ({
          id: String(c.no),
          name: c.name,
          parentId: c.parent && c.parent !== 0 ? String(c.parent) : undefined,
          slug: c.name,
        }));
      }
      return this.defaultCategories();
    } catch (error) {
      logger.warn({ error: String(error) }, 'Naver getCategories failed; returning default list');
      return this.defaultCategories();
    }
  }

  async uploadImage(
    _imagePath: string,
    _options?: { filename?: string; alt?: string; caption?: string },
  ): Promise<PlatformImage> {
    // Naver Blog Open API does not expose a simple image-upload endpoint in this
    // adapter; callers should embed image URLs directly in the post HTML.
    throw new ConfigurationError(
      'Naver image upload is not supported by this adapter. Embed image URLs directly in the post content.',
      'naver',
    );
  }

  private defaultCategories(): PlatformCategory[] {
    return [{ id: '0', name: '미분류 (기본)', slug: 'uncategorized' }];
  }
}
