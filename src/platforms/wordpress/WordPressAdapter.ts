import { createHttpClient, setAuthToken } from '@core/http';
import { getLogger } from '@core/logger';
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
  PlatformError,
  AuthenticationError,
  ValidationError,
  isRetryableError,
} from '@core/errors';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('wordpress-adapter');

interface WordPressPost {
  id: number;
  date: string;
  date_gmt: string;
  guid: { rendered: string };
  modified: string;
  modified_gmt: string;
  slug: string;
  status: string;
  type: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string; protected: boolean };
  excerpt: { rendered: string; protected: boolean };
  author: number;
  featured_media: number;
  comment_status: string;
  ping_status: string;
  sticky: boolean;
  template: string;
  format: string;
  meta: Record<string, unknown>;
  categories: number[];
  tags: number[];
  _links: Record<string, unknown>;
}

interface WordPressCategory {
  id: number;
  count: number;
  description: string;
  link: string;
  name: string;
  slug: string;
  taxonomy: string;
  parent: number;
  meta: Record<string, unknown>;
  _links: Record<string, unknown>;
}

interface WordPressTag {
  id: number;
  count: number;
  description: string;
  link: string;
  name: string;
  slug: string;
  taxonomy: string;
  meta: Record<string, unknown>;
  _links: Record<string, unknown>;
}

interface WordPressMedia {
  id: number;
  date: string;
  slug: string;
  type: string;
  link: string;
  title: { rendered: string };
  author: number;
  caption: { rendered: string };
  alt_text: string;
  media_type: string;
  mime_type: string;
  media_details: {
    width: number;
    height: number;
    file: string;
    sizes: Record<
      string,
      { file: string; width: number; height: number; mime_type: string; source_url: string }
    >;
  };
  source_url: string;
  _links: Record<string, unknown>;
}

export class WordPressAdapter implements PlatformAdapter {
  readonly name = 'wordpress';
  readonly supportedFeatures: PlatformFeature[] = [
    'categories',
    'tags',
    'featured_image',
    'custom_fields',
    'scheduling',
    'seo_fields',
    'media_upload',
    'revisions',
  ];

  private client = createHttpClient({
    baseURL: '',
    timeout: 60000,
    maxRetries: 3,
    rateLimit: {
      requestsPerMinute: 60,
    },
  });

  private config: PlatformCredentials | null = null;
  private initialized = false;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    this.config = credentials;

    const { url, username, appPassword } = credentials;

    if (!url || !username || !appPassword) {
      throw new AuthenticationError(
        'WordPress requires url, username, and appPassword',
        'wordpress',
        'api_key',
      );
    }

    this.client.defaults.baseURL = String(url).replace(/\/+$/, '') + '/wp-json/wp/v2';
    setAuthToken(
      this.client,
      Buffer.from(`${username}:${appPassword}`).toString('base64'),
      'api_key',
      'Authorization',
    );

    // Test connection
    try {
      await this.client.get('/users/me');
      this.initialized = true;
      logger.info({ url }, 'WordPress adapter initialized');
    } catch (error) {
      throw new AuthenticationError(
        `WordPress authentication failed: ${String(error)}`,
        'wordpress',
        'access',
        'AUTHENTICATION_FAILED',
        401,
        undefined,
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      throw new AuthenticationError('WordPress adapter not initialized', 'wordpress', 'access');
    }
  }

  async createPost(content: PlatformPostContent): Promise<PlatformPostResult> {
    await this.ensureInitialized();

    try {
      const postData: Record<string, unknown> = {
        title: content.title,
        content: content.content,
        status: content.scheduledAt
          ? 'future'
          : content.visibility === 'private'
            ? 'private'
            : 'publish',
        comment_status: content.allowComments ? 'open' : 'closed',
        ping_status: 'open',
        format: 'standard',
      };

      if (content.categoryId) {
        postData.categories = [Number(content.categoryId)];
      }
      if (content.tags && content.tags.length > 0) {
        // Create tags if they don't exist
        const tagIds = await this.ensureTagsExist(content.tags);
        postData.tags = tagIds;
      }
      if (content.scheduledAt) {
        postData.date = new Date(content.scheduledAt).toISOString();
      }
      if (content.excerpt) {
        postData.excerpt = content.excerpt;
      }
      if (content.meta) {
        postData.meta = content.meta;
      }

      const response = await this.client.post<WordPressPost>('/posts', postData);

      logger.info(
        { postId: response.data.id, url: response.data.link },
        'Post created successfully',
      );

      return {
        postId: String(response.data.id),
        url: response.data.link,
        publishedAt: new Date(response.data.date_gmt),
      };
    } catch (error) {
      logger.error({ error: String(error) }, 'Create post failed');
      throw this.handleError(error, 'createPost');
    }
  }

  async updatePost(
    postId: string,
    content: Partial<PlatformPostContent>,
  ): Promise<PlatformPostResult> {
    await this.ensureInitialized();

    try {
      const postData: Record<string, unknown> = {};

      if (content.title) postData.title = content.title;
      if (content.content) postData.content = content.content;
      if (content.visibility) {
        postData.status = content.visibility === 'private' ? 'private' : 'publish';
      }
      if (content.allowComments !== undefined) {
        postData.comment_status = content.allowComments ? 'open' : 'closed';
      }
      if (content.categoryId) {
        postData.categories = [Number(content.categoryId)];
      }
      if (content.tags) {
        const tagIds = await this.ensureTagsExist(content.tags);
        postData.tags = tagIds;
      }
      if (content.scheduledAt) {
        postData.date = new Date(content.scheduledAt).toISOString();
        postData.status = 'future';
      }
      if (content.excerpt) {
        postData.excerpt = content.excerpt;
      }
      if (content.meta) {
        postData.meta = content.meta;
      }

      const response = await this.client.post<WordPressPost>(`/posts/${postId}`, postData);

      logger.info({ postId, url: response.data.link }, 'Post updated successfully');

      return {
        postId: String(response.data.id),
        url: response.data.link,
        publishedAt: new Date(response.data.date_gmt),
      };
    } catch (error) {
      logger.error({ postId, error: String(error) }, 'Update post failed');
      throw this.handleError(error, 'updatePost');
    }
  }

  async getCategories(_blogName?: string): Promise<PlatformCategory[]> {
    await this.ensureInitialized();

    try {
      const response = await this.client.get<WordPressCategory[]>('/categories', {
        params: { per_page: 100, orderby: 'name', order: 'asc' },
      });

      return response.data.map((cat) => ({
        id: String(cat.id),
        name: cat.name,
        parentId: cat.parent > 0 ? String(cat.parent) : undefined,
        slug: cat.slug,
      }));
    } catch (error) {
      logger.error({ error: String(error) }, 'Get categories failed');
      throw this.handleError(error, 'getCategories');
    }
  }

  async getTags(search?: string): Promise<PlatformCategory[]> {
    await this.ensureInitialized();

    try {
      const params: Record<string, unknown> = { per_page: 100, orderby: 'count', order: 'desc' };
      if (search) params.search = search;

      const response = await this.client.get<WordPressTag[]>('/tags', { params });

      return response.data.map((tag) => ({
        id: String(tag.id),
        name: tag.name,
        slug: tag.slug,
      }));
    } catch (error) {
      logger.error({ error: String(error) }, 'Get tags failed');
      throw this.handleError(error, 'getTags');
    }
  }

  async uploadImage(
    imagePath: string,
    options?: { filename?: string; alt?: string; caption?: string },
  ): Promise<PlatformImage> {
    await this.ensureInitialized();

    if (!fs.existsSync(imagePath)) {
      throw new ValidationError(`Image file not found: ${imagePath}`, 'wordpress', undefined, []);
    }

    try {
      const formData = new FormData();
      formData.append('file', fs.createReadStream(imagePath), {
        filename: options?.filename || path.basename(imagePath),
      });

      if (options?.alt) formData.append('alt_text', options.alt);
      if (options?.caption) formData.append('caption', options.caption);

      const response = await this.client.post<WordPressMedia>('/media', formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 120000,
      });

      logger.info(
        { mediaId: response.data.id, url: response.data.source_url },
        'Image uploaded successfully',
      );

      return {
        localPath: imagePath,
        url: response.data.source_url,
        altText: options?.alt || '',
        caption: options?.caption,
      };
    } catch (error) {
      logger.error({ imagePath, error: String(error) }, 'Upload image failed');
      throw this.handleError(error, 'uploadImage');
    }
  }

  async uploadMedia(
    filePath: string,
    options?: { filename?: string; alt?: string; caption?: string },
  ): Promise<PlatformImage> {
    return this.uploadImage(filePath, options);
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureInitialized();
      await this.client.get('/users/me');
      return true;
    } catch {
      return false;
    }
  }

  private async ensureTagsExist(tagNames: string[]): Promise<number[]> {
    const existingTags = await this.getTags();
    const existingTagMap = new Map(existingTags.map((t) => [t.name.toLowerCase(), Number(t.id)]));
    const tagIds: number[] = [];

    for (const tagName of tagNames) {
      const lowerName = tagName.toLowerCase();
      if (existingTagMap.has(lowerName)) {
        tagIds.push(existingTagMap.get(lowerName)!);
      } else {
        try {
          const response = await this.client.post<WordPressTag>('/tags', { name: tagName });
          tagIds.push(response.data.id);
          existingTagMap.set(lowerName, response.data.id);
        } catch (error) {
          logger.warn({ tagName, error: String(error) }, 'Failed to create tag, skipping');
        }
      }
    }

    return tagIds;
  }

  private handleError(error: unknown, operation: string): Error {
    if (
      error instanceof PlatformError ||
      error instanceof AuthenticationError ||
      error instanceof ValidationError
    ) {
      throw error;
    }

    if (error instanceof Error) {
      if (isRetryableError(error)) {
        return new PlatformError(
          `WordPress ${operation} failed: ${error.message}`,
          'wordpress',
          operation,
          502,
          true,
          { operation, originalError: error.message },
          error,
        );
      }
    }

    return new PlatformError(
      `WordPress ${operation} failed: ${String(error)}`,
      'wordpress',
      operation,
      502,
      false,
      { operation, originalError: String(error) },
      error instanceof Error ? error : undefined,
    );
  }
}

export function createWordPressAdapter(): WordPressAdapter {
  return new WordPressAdapter();
}
