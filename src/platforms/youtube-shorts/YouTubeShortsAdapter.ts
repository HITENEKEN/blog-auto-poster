import { createHttpClient, setAuthToken, clearAuthToken } from '@core/http';
import { getLogger } from '@core/logger';
import {
  PlatformAdapter,
  PlatformCredentials,
  PlatformPostContent,
  PlatformPostResult,
  PlatformImage,
  PlatformFeature,
} from '@core/interfaces';
import { PlatformError, AuthenticationError, ValidationError, RateLimitError, isRetryableError } from '@core/errors';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('youtube-shorts-adapter');

interface YouTubeTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface YouTubeVideoResource {
  id: string;
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    defaultLanguage: string;
    localized: { title: string; description: string };
    publishedAt: string;
  };
  status: {
    uploadStatus: string;
    privacyStatus: string;
    license: string;
    embeddable: boolean;
    publicStatsViewable: boolean;
    madeForKids: boolean;
  };
  contentDetails: {
    duration: string;
    dimension: string;
    definition: string;
    caption: string;
    licensedContent: boolean;
    regionRestriction?: { allowed?: string[]; blocked?: string[] };
  };
  statistics?: {
    viewCount: string;
    likeCount: string;
    commentCount: string;
  };
}

interface YouTubeUploadResponse {
  id: string;
  snippet: {
    title: string;
    description: string;
  };
  status: {
    uploadStatus: string;
  };
}

interface YouTubeThumbnailResponse {
  items: Array<{
    default: { url: string; width: number; height: number };
    medium: { url: string; width: number; height: number };
    high: { url: string; width: number; height: number };
  }>;
}

const YOUTUBE_BASE_URL = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_AUTH_URL = 'https://oauth2.googleapis.com/token';
const YOUTUBE_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3';

export class YouTubeShortsAdapter implements PlatformAdapter {
  readonly name = 'youtube-shorts';
  readonly supportedFeatures: PlatformFeature[] = [
    'tags',
    'featured_image',
    'scheduling',
    'seo_fields',
    'media_upload',
  ];

  private client = createHttpClient({
    baseURL: YOUTUBE_BASE_URL,
    timeout: 300000, // 5 minutes for uploads
    maxRetries: 3,
    rateLimit: {
      requestsPerMinute: 50,
    },
  });

  private uploadClient = createHttpClient({
    baseURL: YOUTUBE_UPLOAD_URL,
    timeout: 600000, // 10 minutes for resumable uploads
    maxRetries: 3,
  });

  private authClient = createHttpClient({
    baseURL: 'https://oauth2.googleapis.com',
    timeout: 30000,
    maxRetries: 3,
  });

  private config: PlatformCredentials | null = null;
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private clientId: string | null = null;
  private clientSecret: string | null = null;
  private initialized = false;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    this.config = credentials;

    const { clientId, clientSecret, refreshToken, accessToken, channelId } = credentials;

    this.clientId = String(clientId || '');
    this.clientSecret = String(clientSecret || '');
    this.refreshToken = String(refreshToken || '');
    this.accessToken = String(accessToken || '');

    if (!this.clientId || !this.clientSecret) {
      throw new AuthenticationError(
        'YouTube requires clientId and clientSecret',
        'youtube-shorts',
        'credentials'
      );
    }

    if (this.accessToken) {
      setAuthToken(this.client, this.accessToken);
      setAuthToken(this.uploadClient, this.accessToken);
      this.initialized = true;
      logger.info('Initialized with existing access token');
      return;
    }

    if (this.refreshToken) {
      await this.refreshAccessToken();
      this.initialized = true;
      return;
    }

    throw new AuthenticationError(
      'YouTube requires either accessToken or refreshToken for initial setup',
      'youtube-shorts',
      'credentials'
    );
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken || !this.clientId || !this.clientSecret) {
      throw new AuthenticationError('Missing credentials for token refresh', 'youtube-shorts', 'refresh');
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        refresh_token: this.refreshToken,
      });

      const response = await this.authClient.post<YouTubeTokenResponse>('/token', params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      this.accessToken = response.data.access_token;
      if (response.data.refresh_token) {
        this.refreshToken = response.data.refresh_token;
      }

      setAuthToken(this.client, this.accessToken);
      setAuthToken(this.uploadClient, this.accessToken);

      // Update config
      if (this.config) {
        this.config.accessToken = this.accessToken;
        this.config.refreshToken = this.refreshToken;
        this.config.tokenExpiresAt = Date.now() + response.data.expires_in * 1000;
      }

      logger.info('YouTube access token refreshed');
    } catch (error) {
      logger.error({ error: String(error) }, 'Token refresh failed');
      throw new AuthenticationError(
        `YouTube token refresh failed: ${String(error)}`,
        'youtube-shorts',
        'refresh',
        error instanceof Error ? error : undefined
      );
    }
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.initialized || !this.accessToken) {
      throw new AuthenticationError('YouTube adapter not initialized', 'youtube-shorts', 'init');
    }

    // Check if token is near expiry (within 5 minutes)
    const expiresAt = this.config?.tokenExpiresAt || 0;
    if (expiresAt > 0 && expiresAt <= Date.now() + 300000) {
      if (this.refreshToken) {
        await this.refreshAccessToken();
      }
    }
  }

  async createPost(content: PlatformPostContent): Promise<PlatformPostResult> {
    await this.ensureValidToken();

    if (!content.videoPath) {
      throw new ValidationError('videoPath is required for YouTube Shorts', 'youtube-shorts');
    }

    if (!fs.existsSync(content.videoPath)) {
      throw new ValidationError(`Video file not found: ${content.videoPath}`, 'youtube-shorts');
    }

    try {
      // Step 1: Initialize resumable upload
      const metadata = {
        snippet: {
          title: content.title,
          description: content.description || content.content,
          tags: content.tags || [],
          categoryId: content.categoryId || '22', // People & Blogs
          defaultLanguage: 'ko',
        },
        status: {
          privacyStatus: content.visibility === 'private' ? 'private' : 'public',
          madeForKids: false,
          selfDeclaredMadeForKids: false,
        },
      };

      // Check if it's a Short (under 60 seconds)
      // We'll add #Shorts tag if not present
      const tags = [...(content.tags || [])];
      if (!tags.some(t => t.toLowerCase() === 'shorts')) {
        tags.push('Shorts');
      }
      metadata.snippet.tags = tags;

      const initResponse = await this.uploadClient.post<YouTubeUploadResponse>(
        '/videos?uploadType=resumable&part=snippet,status',
        metadata,
        {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'X-Upload-Content-Type': 'video/*',
            'X-Upload-Content-Length': String(fs.statSync(content.videoPath).size),
          },
        }
      );

      const uploadUrl = initResponse.headers.location;
      if (!uploadUrl) {
        throw new PlatformError('Failed to get upload URL', 'youtube-shorts', 'createPost', 502);
      }

      // Step 2: Upload video file
      const videoStream = fs.createReadStream(content.videoPath);
      const uploadResponse = await this.uploadClient.put<YouTubeUploadResponse>(uploadUrl, videoStream, {
        headers: {
          'Content-Type': 'video/*',
        },
        timeout: 600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });

      const videoId = uploadResponse.data.id;
      const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const shortsUrl = `https://www.youtube.com/shorts/${videoId}`;

      // Step 3: Upload thumbnail if provided
      if (content.thumbnailPath && fs.existsSync(content.thumbnailPath)) {
        await this.setThumbnail(videoId, content.thumbnailPath);
      }

      logger.info({ videoId, url: shortsUrl }, 'YouTube Short uploaded successfully');

      return {
        postId: videoId,
        url: shortsUrl,
        platform: 'youtube-shorts',
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ error: String(error) }, 'Create YouTube Short failed');
      throw this.handleError(error, 'createPost');
    }
  }

  async updatePost(postId: string, content: Partial<PlatformPostContent>): Promise<PlatformPostResult> {
    await this.ensureValidToken();

    try {
      const updateData: Record<string, unknown> = {
        id: postId,
      };

      if (content.title) updateData.snippet = { ...updateData.snippet, title: content.title };
      if (content.description || content.content) {
        updateData.snippet = { ...updateData.snippet, description: content.description || content.content };
      }
      if (content.tags) updateData.snippet = { ...updateData.snippet, tags: content.tags };
      if (content.categoryId) updateData.snippet = { ...updateData.snippet, categoryId: content.categoryId };
      if (content.visibility) {
        updateData.status = { ...updateData.status, privacyStatus: content.visibility === 'private' ? 'private' : 'public' };
      }

      const part = Object.keys(updateData).filter(k => k !== 'id').join(',');

      await this.client.put<YouTubeVideoResource>(`/videos?part=${part}`, updateData);

      if (content.thumbnailPath && fs.existsSync(content.thumbnailPath)) {
        await this.setThumbnail(postId, content.thumbnailPath);
      }

      const shortsUrl = `https://www.youtube.com/shorts/${postId}`;

      return {
        postId,
        url: shortsUrl,
        platform: 'youtube-shorts',
        publishedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error({ postId, error: String(error) }, 'Update YouTube Short failed');
      throw this.handleError(error, 'updatePost');
    }
  }

  async setThumbnail(videoId: string, thumbnailPath: string): Promise<void> {
    await this.ensureValidToken();

    if (!fs.existsSync(thumbnailPath)) {
      logger.warn({ thumbnailPath }, 'Thumbnail file not found, skipping');
      return;
    }

    try {
      const formData = new FormData();
      formData.append('media', fs.createReadStream(thumbnailPath), {
        filename: path.basename(thumbnailPath),
      });

      await this.uploadClient.post(
        `/videos/${videoId}/thumbnails/set`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
          },
          params: { videoId },
        }
      );

      logger.info({ videoId }, 'Thumbnail uploaded');
    } catch (error) {
      logger.warn({ videoId, error: String(error) }, 'Thumbnail upload failed, continuing');
    }
  }

  async getCategories(blogName?: string): Promise<Array<{ id: string; name: string; slug?: string }>> {
    // YouTube doesn't have traditional categories for Shorts, return common ones
    return [
      { id: '1', name: 'Film & Animation', slug: 'film' },
      { id: '2', name: 'Autos & Vehicles', slug: 'autos' },
      { id: '10', name: 'Music', slug: 'music' },
      { id: '15', name: 'Pets & Animals', slug: 'pets' },
      { id: '17', name: 'Sports', slug: 'sports' },
      { id: '19', name: 'Travel & Events', slug: 'travel' },
      { id: '20', name: 'Gaming', slug: 'gaming' },
      { id: '22', name: 'People & Blogs', slug: 'people' },
      { id: '23', name: 'Comedy', slug: 'comedy' },
      { id: '24', name: 'Entertainment', slug: 'entertainment' },
      { id: '25', name: 'News & Politics', slug: 'news' },
      { id: '26', name: 'Howto & Style', slug: 'howto' },
      { id: '27', name: 'Education', slug: 'education' },
      { id: '28', name: 'Science & Technology', slug: 'science' },
    ];
  }

  async uploadImage(imagePath: string, options?: { filename?: string }): Promise<PlatformImage> {
    // YouTube uses thumbnails, not general image uploads
    // This is handled via setThumbnail
    throw new PlatformError('Use setThumbnail for YouTube', 'youtube-shorts', 'uploadImage', 400);
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureValidToken();
      await this.client.get('/channels', { params: { part: 'snippet', mine: 'true' } });
      return true;
    } catch {
      return false;
    }
  }

  private handleError(error: unknown, operation: string): Error {
    if (error instanceof PlatformError || error instanceof AuthenticationError || error instanceof ValidationError || error instanceof RateLimitError) {
      throw error;
    }

    if (error instanceof Error) {
      if (isRetryableError(error)) {
        return new PlatformError(
          `YouTube ${operation} failed: ${error.message}`,
          'youtube-shorts',
          operation,
          502,
          true,
          { operation, originalError: error.message },
          error
        );
      }
    }

    return new PlatformError(
      `YouTube ${operation} failed: ${String(error)}`,
      'youtube-shorts',
      operation,
      502,
      false,
      { operation, originalError: String(error) },
      error instanceof Error ? error : undefined
    );
  }
}

export function createYouTubeShortsAdapter(): YouTubeShortsAdapter {
  return new YouTubeShortsAdapter();
}