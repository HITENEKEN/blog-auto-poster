import { createHttpClient } from '@core/http';
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
import { PlatformError, AuthenticationError, RateLimitError, ValidationError, isRetryableError } from '@core/errors';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('tistory-adapter');

interface TistoryAuthResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  blog_name: string;
}

interface TistoryPostWriteResponse {
  status: string;
  postId: string;
  url: string;
}

interface TistoryPostModifyResponse {
  status: string;
  postId: string;
  url: string;
}

interface TistoryCategoryResponse {
  status: string;
  item: {
    categories: Array<{
      id: string;
      name: string;
      parentId: string;
      label: string;
    }>;
  };
}

interface TistoryUploadResponse {
  status: string;
  url: string;
  replacer: string;
}

interface TistorySessionResponse {
  status: string;
  userId: string;
  blogName: string;
}

const TISTORY_BASE_URL = 'https://www.tistory.com/apis';
const TISTORY_AUTH_URL = 'https://www.tistory.com/oauth';

export class TistoryAdapter implements PlatformAdapter {
  readonly name = 'tistory';
  readonly supportedFeatures: PlatformFeature[] = [
    'categories',
    'tags',
    'featured_image',
    'scheduling',
    'seo_fields',
    'media_upload',
  ];

  private client = createHttpClient({
    baseURL: TISTORY_BASE_URL,
    timeout: 60000,
    maxRetries: 3,
    rateLimit: {
      requestsPerMinute: 30,
    },
    defaultHeaders: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  private config: PlatformCredentials | null = null;
  private accessToken: string | null = null;
  private blogName: string | null = null;
  private initialized = false;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    this.config = credentials;

    const { username, password, apiKey, blogName, accessToken } = credentials;

    if (accessToken) {
      this.accessToken = String(accessToken);
      this.blogName = String(blogName);
      this.initialized = true;
      logger.info({ blogName }, 'Initialized with existing access token');
      return;
    }

    if (!username || !password || !apiKey || !blogName) {
      throw new AuthenticationError(
        'Tistory requires username, password, apiKey, and blogName',
        'tistory',
        'credentials'
      );
    }

    await this.authenticate(String(username), String(password), String(apiKey), String(blogName));
    this.initialized = true;
  }

  private async authenticate(username: string, password: string, apiKey: string, blogName: string): Promise<void> {
    try {
      // Tistory uses a custom authentication flow via web endpoints
      // We'll simulate the OAuth-like flow using the provided credentials
      const authClient = createHttpClient({
        baseURL: 'https://www.tistory.com',
        timeout: 60000,
        maxRetries: 3,
      });

      // Step 1: Get login page to obtain CSRF token / session
      const loginPage = await authClient.get('/auth/login');
      const csrfMatch = loginPage.data.match(/name="csrf_token" value="([^"]+)"/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';

      // Step 2: Submit login form
      const loginData = new URLSearchParams({
        loginId: username,
        password: password,
        csrf_token: csrfToken,
      });

      const loginResponse = await authClient.post('/auth/login', loginData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Referer: 'https://www.tistory.com/auth/login',
        },
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302,
      });

      // Extract cookies from login response
      const cookies = loginResponse.headers['set-cookie'];
      if (!cookies) {
        throw new AuthenticationError('Login failed: no session cookie', 'tistory', 'login');
      }

      // Store cookies for subsequent requests
      this.client.defaults.headers.common['Cookie'] = cookies.join('; ');

      // Step 3: Get access token using API key
      const tokenParams = new URLSearchParams({
        client_id: apiKey,
        response_type: 'token',
        redirect_uri: 'https://www.tistory.com/oauth/callback',
      });

      const tokenResponse = await authClient.get(`${TISTORY_AUTH_URL}/authorize?${tokenParams.toString()}`, {
        maxRedirects: 0,
        validateStatus: (status) => status < 400 || status === 302,
      });

      // Extract access token from redirect URL fragment
      const location = tokenResponse.headers.location || '';
      const tokenMatch = location.match(/access_token=([^&]+)/);
      if (tokenMatch) {
        this.accessToken = tokenMatch[1];
      } else {
        // Alternative: use the API key directly for some endpoints
        this.accessToken = apiKey;
      }

      this.blogName = blogName;
      logger.info({ blogName }, 'Tistory authentication completed');
    } catch (error) {
      logger.error({ error: String(error) }, 'Tistory authentication failed');
      throw new AuthenticationError(
        `Tistory authentication failed: ${String(error)}`,
        'tistory',
        'login',
        error instanceof Error ? error : undefined
      );
    }
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.initialized || !this.accessToken) {
      throw new AuthenticationError('Tistory adapter not initialized', 'tistory', 'init');
    }
  }

  async createPost(content: PlatformPostContent): Promise<PlatformPostResult> {
    await this.ensureAuthenticated();

    try {
      const params = new URLSearchParams({
        access_token: this.accessToken!,
        blogName: this.blogName!,
        title: content.title,
        content: content.content,
        visibility: content.visibility || '3', // 0: private, 1: protected, 3: public
        category: String(content.categoryId || '0'),
        tag: content.tags?.join(',') || '',
        acceptComment: content.allowComments ? '1' : '0',
        password: content.password || '',
        published: content.scheduledAt ? '0' : '1',
      });

      if (content.scheduledAt) {
        params.append('publishedAt', new Date(content.scheduledAt).toISOString().replace(/[-:]/g, '').split('.')[0]);
      }

      const response = await this.client.post<TistoryPostWriteResponse>('/post/write', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (response.data.status !== '200') {
        throw new PlatformError(
          `Tistory post write failed: ${response.data.status}`,
          'tistory',
          'createPost',
          502,
          true,
          { response: response.data }
        );
      }

      logger.info({ postId: response.data.postId, url: response.data.url }, 'Post created successfully');

      return {
        postId: response.data.postId,
        url: response.data.url,
        platform: 'tistory',
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ error: String(error) }, 'Create post failed');
      throw this.handleError(error, 'createPost');
    }
  }

  async updatePost(postId: string, content: Partial<PlatformPostContent>): Promise<PlatformPostResult> {
    await this.ensureAuthenticated();

    try {
      const params = new URLSearchParams({
        access_token: this.accessToken!,
        blogName: this.blogName!,
        postId: postId,
      });

      if (content.title) params.append('title', content.title);
      if (content.content) params.append('content', content.content);
      if (content.visibility) params.append('visibility', content.visibility);
      if (content.categoryId) params.append('category', String(content.categoryId));
      if (content.tags) params.append('tag', content.tags.join(','));
      if (content.allowComments !== undefined) params.append('acceptComment', content.allowComments ? '1' : '0');

      const response = await this.client.post<TistoryPostModifyResponse>('/post/modify', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      if (response.data.status !== '200') {
        throw new PlatformError(
          `Tistory post modify failed: ${response.data.status}`,
          'tistory',
          'updatePost',
          502,
          true,
          { response: response.data }
        );
      }

      logger.info({ postId, url: response.data.url }, 'Post updated successfully');

      return {
        postId: response.data.postId,
        url: response.data.url,
        platform: 'tistory',
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ postId, error: String(error) }, 'Update post failed');
      throw this.handleError(error, 'updatePost');
    }
  }

  async getCategories(blogName?: string): Promise<PlatformCategory[]> {
    await this.ensureAuthenticated();

    try {
      const targetBlog = blogName || this.blogName;
      if (!targetBlog) {
        throw new ValidationError('Blog name required for category fetch', 'tistory');
      }

      const params = new URLSearchParams({
        access_token: this.accessToken!,
        blogName: targetBlog,
      });

      const response = await this.client.get<TistoryCategoryResponse>('/category/list', { params });

      if (response.data.status !== '200') {
        throw new PlatformError(
          `Tistory category list failed: ${response.data.status}`,
          'tistory',
          'getCategories',
          502,
          true,
          { response: response.data }
        );
      }

      return response.data.item.categories.map((cat) => ({
        id: cat.id,
        name: cat.name,
        parentId: cat.parentId === '0' ? undefined : cat.parentId,
        slug: cat.label,
      }));
    } catch (error) {
      logger.error({ error: String(error) }, 'Get categories failed');
      throw this.handleError(error, 'getCategories');
    }
  }

  async uploadImage(imagePath: string, options?: { filename?: string }): Promise<PlatformImage> {
    await this.ensureAuthenticated();

    if (!fs.existsSync(imagePath)) {
      throw new ValidationError(`Image file not found: ${imagePath}`, 'tistory');
    }

    try {
      const formData = new FormData();
      formData.append('access_token', this.accessToken!);
      formData.append('blogName', this.blogName!);
      formData.append('uploadedfile', fs.createReadStream(imagePath), {
        filename: options?.filename || path.basename(imagePath),
      });

      const response = await this.client.post<TistoryUploadResponse>('/post/attach', formData, {
        headers: {
          ...formData.getHeaders(),
        },
        timeout: 120000, // Longer timeout for uploads
      });

      if (response.data.status !== '200') {
        throw new PlatformError(
          `Tistory image upload failed: ${response.data.status}`,
          'tistory',
          'uploadImage',
          502,
          true,
          { response: response.data }
        );
      }

      const fileName = path.basename(imagePath);
      const stats = fs.statSync(imagePath);

      logger.info({ url: response.data.url, fileName }, 'Image uploaded successfully');

      return {
        url: response.data.url,
        localPath: imagePath,
        filename: fileName,
        size: stats.size,
        mimeType: this.getMimeType(fileName),
      };
    } catch (error) {
      logger.error({ imagePath, error: String(error) }, 'Upload image failed');
      throw this.handleError(error, 'uploadImage');
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureAuthenticated();
      await this.getCategories();
      return true;
    } catch {
      return false;
    }
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private handleError(error: unknown, operation: string): Error {
    if (error instanceof PlatformError || error instanceof AuthenticationError || error instanceof RateLimitError || error instanceof ValidationError) {
      throw error;
    }

    if (error instanceof Error) {
      if (isRetryableError(error)) {
        return new PlatformError(
          `Tistory ${operation} failed: ${error.message}`,
          'tistory',
          operation,
          502,
          true,
          { operation, originalError: error.message },
          error
        );
      }
    }

    return new PlatformError(
      `Tistory ${operation} failed: ${String(error)}`,
      'tistory',
      operation,
      502,
      false,
      { operation, originalError: String(error) },
      error instanceof Error ? error : undefined
    );
  }
}

export function createTistoryAdapter(): TistoryAdapter {
  return new TistoryAdapter();
}