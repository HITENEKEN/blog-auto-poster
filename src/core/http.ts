import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import Bottleneck from 'bottleneck';
import { getLogger } from './logger';
import { RateLimitError, AuthenticationError, TimeoutError, BlogPosterError, isRetryableError, getRetryDelay, formatErrorForLogging } from './errors';

interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetAt: Date;
}

// Store request start times separately since Axios config doesn't have metadata
const requestStartTimes = new Map<string, number>();

const logger = getLogger('http');
const limiters = new Map<string, Bottleneck>();
const rateLimitInfo = new Map<string, RateLimitInfo>();

export interface HttpClientOptions {
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  rateLimit?: {
    requestsPerMinute: number;
    requestsPerSecond?: number;
  };
  defaultHeaders?: Record<string, string>;
  auth?: {
    type: 'bearer' | 'basic' | 'api_key';
    token?: string;
    username?: string;
    password?: string;
    apiKeyHeader?: string;
  };
}

export function createHttpClient(options: HttpClientOptions = {}): AxiosInstance {
  const {
    baseURL,
    timeout = 30000,
    maxRetries = 3,
    rateLimit,
    defaultHeaders = {},
    auth,
  } = options;

  const client = axios.create({
    baseURL,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'BlogAutoPoster/1.0',
      ...defaultHeaders,
    },
  });

  const limiterKey = baseURL || 'default';
  let limiter = limiters.get(limiterKey);

  if (rateLimit && !limiter) {
    limiter = new Bottleneck({
      minTime: rateLimit.requestsPerSecond
        ? 1000 / rateLimit.requestsPerSecond
        : 60000 / rateLimit.requestsPerMinute,
      maxConcurrent: 1,
      reservoir: rateLimit.requestsPerMinute,
      reservoirRefreshAmount: rateLimit.requestsPerMinute,
      reservoirRefreshInterval: 60000,
    });
    limiters.set(limiterKey, limiter);
  }

  client.interceptors.request.use(
    async (config: InternalAxiosRequestConfig) => {
      if (limiter) {
        await limiter.schedule(() => Promise.resolve());
      }

      if (auth) {
        switch (auth.type) {
          case 'bearer':
            if (auth.token) {
              config.headers.Authorization = `Bearer ${auth.token}`;
            }
            break;
          case 'basic':
            if (auth.username && auth.password) {
              const credentials = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
              config.headers.Authorization = `Basic ${credentials}`;
            }
            break;
          case 'api_key':
            if (auth.token && auth.apiKeyHeader) {
              config.headers[auth.apiKeyHeader] = auth.token;
            }
            break;
        }
      }

      const requestId = `${config.method}:${config.url}:${Date.now()}`;
      requestStartTimes.set(requestId, Date.now());
      (config as any).requestId = requestId;
      logger.debug({ url: config.url, method: config.method }, 'Request started');
      return config;
    },
    (error) => {
      logger.error({ error: formatErrorForLogging(error) }, 'Request interceptor error');
      return Promise.reject(error);
    }
  );

  client.interceptors.response.use(
    (response: AxiosResponse) => {
      const requestId = (response.config as any).requestId;
      const startTime = requestId ? requestStartTimes.get(requestId) : Date.now();
      const duration = Date.now() - (startTime || Date.now());
      if (requestId) requestStartTimes.delete(requestId);
      updateRateLimitInfo(response.config.url || '', response.headers);
      logger.debug({ url: response.config.url, status: response.status, duration }, 'Request completed');
      return response;
    },
    async (error: AxiosError) => {
      const config = error.config;
      if (!config) {
        return Promise.reject(error);
      }

      const requestId = (config as any).requestId;
      const startTime = requestId ? requestStartTimes.get(requestId) : Date.now();
      const duration = Date.now() - (startTime || Date.now());
      if (requestId) requestStartTimes.delete(requestId);

      logger.warn(
        { url: config.url, status: error.response?.status, duration, message: error.message },
        'Request failed'
      );
      if (error.response?.status === 429) {
        const retryAfter = parseRetryAfter(error.response.headers['retry-after']);
        const limitInfo = rateLimitInfo.get(config.url || '');
        throw new RateLimitError(
          `Rate limit exceeded for ${config.url}`,
          retryAfter,
          limitInfo?.limit || 0,
          limitInfo?.remaining || 0,
          limitInfo?.resetAt || new Date(Date.now() + retryAfter * 1000),
          'RATE_LIMIT_EXCEEDED',
          429,
          { url: config.url, method: config.method },
          error
        );
      }

      if (error.response?.status === 401) {
        throw new AuthenticationError(
          `Authentication failed for ${config.url}`,
          new URL(config.baseURL || config.url || '').hostname,
          'access',
          'AUTHENTICATION_FAILED',
          401,
          { url: config.url, method: config.method },
          error
        );
      }

      if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
        throw new TimeoutError(config.url || '', timeout, 'TIMEOUT', 504, { url: config.url }, error);
      }

      const attempt = (config as any).__retryCount || 0;
      if (attempt < maxRetries && isRetryableError(error)) {
        (config as any).__retryCount = attempt + 1;
        const delay = getRetryDelay(error, attempt);
        logger.info({ url: config.url, attempt: attempt + 1, delay }, 'Retrying request');
        await new Promise((resolve) => setTimeout(resolve, delay));
        return client.request(config);
      }

      return Promise.reject(error);
    }
  );

  return client;
}

function parseRetryAfter(value: string | string[] | undefined): number {
  if (!value) return 60;
  const parsed = Array.isArray(value) ? parseInt(value[0], 10) : parseInt(value, 10);
  return isNaN(parsed) ? 60 : parsed;
}

function updateRateLimitInfo(url: string, headers: Record<string, unknown>): void {
  const limit = parseInt(String(headers['x-ratelimit-limit'] || headers['ratelimit-limit'] || '0'), 10);
  const remaining = parseInt(String(headers['x-ratelimit-remaining'] || headers['ratelimit-remaining'] || '0'), 10);
  const reset = parseInt(String(headers['x-ratelimit-reset'] || headers['ratelimit-reset'] || '0'), 10);

  if (limit > 0) {
    rateLimitInfo.set(url, {
      limit,
      remaining,
      resetAt: new Date(reset * 1000),
    });
  }
}

export function getRateLimitInfo(url: string): RateLimitInfo | undefined {
  return rateLimitInfo.get(url);
}

export function setAuthToken(client: AxiosInstance, token: string, type: 'bearer' | 'api_key' = 'bearer', header?: string): void {
  if (type === 'bearer') {
    client.defaults.headers.common.Authorization = `Bearer ${token}`;
  } else if (type === 'api_key' && header) {
    client.defaults.headers.common[header] = token;
  }
}

export function clearAuthToken(client: AxiosInstance, type: 'bearer' | 'api_key' = 'bearer', header?: string): void {
  if (type === 'bearer') {
    delete client.defaults.headers.common.Authorization;
  } else if (type === 'api_key' && header) {
    delete client.defaults.headers.common[header];
  }
}
