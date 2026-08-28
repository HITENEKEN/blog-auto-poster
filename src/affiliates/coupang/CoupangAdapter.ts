import { createHttpClient, setAuthToken } from '@core/http';
import { getCache } from '@core/cache';
import { getLogger } from '@core/logger';
import {
  AffiliateAdapter,
  AffiliateConfig,
  AffiliateProduct,
  AffiliateSearchOptions,
  AffiliateSearchResult,
} from '@core/interfaces';
import {
  AffiliateError,
  AuthenticationError,
  RateLimitError,
  isRetryableError,
} from '@core/errors';

const logger = getLogger('coupang-adapter');

interface CoupangTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

interface CoupangProductSearchResponse {
  data: {
    productData: CoupangProductData[];
    totalCount: number;
    currentPage: number;
    totalPages: number;
  };
  code: string;
  message: string;
}

interface CoupangProductData {
  productId: number;
  productName: string;
  productPrice: number;
  originalPrice: number;
  discountRate: number;
  productImage: string;
  productUrl: string;
  categoryId: string;
  categoryName: string;
  brandName: string;
  rating: number;
  reviewCount: number;
  deliveryType: string;
  deliveryFee: number;
  rocketDelivery: boolean;
  rocketWowDelivery: boolean;
  statusType: string;
  tags: string[];
}

interface CoupangProductDetailResponse {
  data: CoupangProductData;
  code: string;
  message: string;
}

interface CoupangCommissionResponse {
  data: {
    categoryId: string;
    categoryName: string;
    commissionRate: number;
  }[];
  code: string;
  message: string;
}

interface CoupangTrackingUrlResponse {
  data: {
    trackingUrl: string;
  };
  code: string;
  message: string;
}

const COUPANG_BASE_URL = 'https://api-gateway.coupang.com';
const COUPANG_AUTH_URL = 'https://login.coupang.com/oauth2/token';
const COUPANG_API_VERSION = 'v2';

export class CoupangAdapter implements AffiliateAdapter {
  readonly name = 'coupang';
  readonly supportedCategories = [
    'digital',
    'home_appliances',
    'computer',
    'mobile',
    'fashion',
    'beauty',
    'sports',
    'baby',
    'food',
    'living',
    'pet',
    'book',
    'auto',
  ];

  private client = createHttpClient({
    baseURL: COUPANG_BASE_URL,
    timeout: 30000,
    maxRetries: 3,
    rateLimit: {
      requestsPerMinute: 100,
    },
    defaultHeaders: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
  });

  private authClient = createHttpClient({
    baseURL: COUPANG_AUTH_URL.replace('/oauth2/token', ''),
    timeout: 30000,
    maxRetries: 3,
  });

  private config: AffiliateConfig | null = null;
  private tokenCache = getCache<CoupangTokenResponse>('coupang-tokens');
  private searchCache = getCache<AffiliateSearchResult>('coupang-search');
  private productCache = getCache<AffiliateProduct>('coupang-products');
  private commissionCache = getCache<Record<string, number>>('coupang-commissions');
  private initialized = false;

  async initialize(config: AffiliateConfig): Promise<void> {
    this.config = config;

    if (config.accessToken && config.tokenExpiresAt && config.tokenExpiresAt > Date.now()) {
      setAuthToken(this.client, config.accessToken);
      this.initialized = true;
      logger.info('Initialized with existing access token');
      return;
    }

    if (config.refreshToken) {
      await this.refreshAccessToken();
      this.initialized = true;
      return;
    }

    await this.obtainInitialToken();
    this.initialized = true;
  }

  private async obtainInitialToken(): Promise<void> {
    if (!this.config?.apiKey || !this.config?.apiSecret) {
      throw new AuthenticationError(
        'Coupang API key and secret required for initial token',
        'coupang',
        'api_key',
      );
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.apiKey,
        client_secret: this.config.apiSecret,
        scope: 'open',
      });

      const response = await this.authClient.post<CoupangTokenResponse>('/oauth2/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      await this.storeToken(response.data);
      logger.info('Obtained initial Coupang access token');
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to obtain initial token');
      throw new AuthenticationError(
        'Failed to obtain initial Coupang access token',
        'coupang',
        'api_key',
        'AUTHENTICATION_FAILED',
        401,
        { originalError: String(error) },
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.config?.refreshToken || !this.config?.apiKey || !this.config?.apiSecret) {
      throw new AuthenticationError(
        'Refresh token, API key, and secret required for token refresh',
        'coupang',
        'refresh',
      );
    }

    try {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.apiKey,
        client_secret: this.config.apiSecret,
        refresh_token: this.config.refreshToken,
        scope: 'open',
      });

      const response = await this.authClient.post<CoupangTokenResponse>('/oauth2/token', params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });

      await this.storeToken(response.data);
      logger.info('Refreshed Coupang access token');
    } catch (error) {
      logger.error({ error: String(error) }, 'Failed to refresh token');
      throw new AuthenticationError(
        'Failed to refresh Coupang access token',
        'coupang',
        'refresh',
        'AUTHENTICATION_FAILED',
        401,
        { originalError: String(error) },
        error instanceof Error ? error : undefined,
      );
    }
  }

  private async storeToken(tokenData: CoupangTokenResponse): Promise<void> {
    const expiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

    this.config!.accessToken = tokenData.access_token;
    this.config!.refreshToken = tokenData.refresh_token;
    this.config!.tokenExpiresAt = expiresAt;

    setAuthToken(this.client, tokenData.access_token);

    this.tokenCache.set('tokens', tokenData, tokenData.expires_in - 60);
  }

  private async ensureValidToken(): Promise<void> {
    if (!this.config?.accessToken || !this.config?.tokenExpiresAt) {
      await this.obtainInitialToken();
      return;
    }

    if (this.config.tokenExpiresAt <= Date.now() + 60000) {
      if (this.config.refreshToken) {
        await this.refreshAccessToken();
      } else {
        await this.obtainInitialToken();
      }
    }
  }

  async searchProducts(options: AffiliateSearchOptions): Promise<AffiliateSearchResult> {
    await this.ensureValidToken();

    const cacheKey = `search:${JSON.stringify(options)}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached) {
      logger.debug({ keyword: options.keyword }, 'Returning cached search results');
      return cached;
    }

    try {
      const params: Record<string, string> = {
        keyword: options.keyword,
        page: String(options.page || 1),
        limit: String(options.limit || 20),
      };

      if (options.categoryId) params.categoryId = options.categoryId;
      if (options.sort) params.sort = options.sort;
      if (options.minPrice) params.minPrice = String(options.minPrice);
      if (options.maxPrice) params.maxPrice = String(options.maxPrice);
      if (options.brand) params.brand = options.brand;

      const response = await this.client.get<CoupangProductSearchResponse>(
        `/${COUPANG_API_VERSION}/affiliate/products/search`,
        { params },
      );

      if (response.data.code !== 'SUCCESS') {
        throw new AffiliateError(
          `Coupang search failed: ${response.data.message}`,
          'coupang',
          'SEARCH_FAILED',
          502,
          true,
          { response: response.data },
        );
      }

      const products: AffiliateProduct[] = response.data.data.productData.map(this.mapProduct);

      const result: AffiliateSearchResult = {
        products,
        totalCount: response.data.data.totalCount,
        currentPage: response.data.data.currentPage,
        totalPages: response.data.data.totalPages,
      };
      this.searchCache.set(cacheKey, result, 300);

      return result;
    } catch (error) {
      logger.error({ keyword: options.keyword, error: String(error) }, 'Product search failed');
      throw this.handleError(error, 'searchProducts');
    }
  }

  async getProductDetails(productId: string): Promise<AffiliateProduct> {
    await this.ensureValidToken();

    const cacheKey = `product:${productId}`;
    const cached = this.productCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.client.get<CoupangProductDetailResponse>(
        `/${COUPANG_API_VERSION}/affiliate/products/${productId}`,
      );

      if (response.data.code !== 'SUCCESS') {
        throw new AffiliateError(
          `Coupang product detail failed: ${response.data.message}`,
          'coupang',
          'PRODUCT_DETAIL_FAILED',
          502,
          true,
          { productId, response: response.data },
        );
      }

      const product = this.mapProduct(response.data.data);
      this.productCache.set(cacheKey, product, 3600);
      return product;
    } catch (error) {
      logger.error({ productId, error: String(error) }, 'Product detail failed');
      throw this.handleError(error, 'getProductDetails');
    }
  }

  async generateTrackingUrl(productId: string, subId?: string): Promise<string> {
    await this.ensureValidToken();

    try {
      const params: Record<string, string> = {
        productId,
      };

      if (subId) params.subId = subId;

      const response = await this.client.get<CoupangTrackingUrlResponse>(
        `/${COUPANG_API_VERSION}/affiliate/tracking-url`,
        { params },
      );

      if (response.data.code !== 'SUCCESS') {
        throw new AffiliateError(
          `Coupang tracking URL generation failed: ${response.data.message}`,
          'coupang',
          'TRACKING_URL_FAILED',
          502,
          true,
          { productId, response: response.data },
        );
      }

      logger.debug({ productId }, 'Tracking URL generated');
      return response.data.data.trackingUrl;
    } catch (error) {
      logger.error({ productId, error: String(error) }, 'Tracking URL generation failed');
      throw this.handleError(error, 'generateTrackingUrl');
    }
  }

  async getCommissionRates(categoryId: string): Promise<Record<string, number>> {
    await this.ensureValidToken();

    const cacheKey = `commission:${categoryId}`;
    const cached = this.commissionCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    try {
      const response = await this.client.get<CoupangCommissionResponse>(
        `/${COUPANG_API_VERSION}/affiliate/commissions`,
        { params: { categoryId } },
      );

      if (response.data.code !== 'SUCCESS') {
        throw new AffiliateError(
          `Coupang commission rates failed: ${response.data.message}`,
          'coupang',
          'COMMISSION_FAILED',
          502,
          true,
          { categoryId, response: response.data },
        );
      }

      const rates: Record<string, number> = {};
      for (const item of response.data.data) {
        rates[item.categoryId] = item.commissionRate;
      }
      this.commissionCache.set(cacheKey, rates, 86400);
      return rates;
    } catch (error) {
      logger.error({ categoryId, error: String(error) }, 'Commission rates failed');
      throw this.handleError(error, 'getCommissionRates');
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureValidToken();
      const result = await this.searchProducts({ keyword: 'test', limit: 1 });
      return result.products.length >= 0;
    } catch {
      return false;
    }
  }

  private mapProduct(data: CoupangProductData): AffiliateProduct {
    const price = data.productPrice;
    const originalPrice = data.originalPrice || price;
    const discountRate = data.discountRate || 0;

    return {
      id: String(data.productId),
      name: data.productName,
      price,
      originalPrice: originalPrice > price ? originalPrice : undefined,
      discountRate,
      currency: 'KRW',
      imageUrl: data.productImage,
      productUrl: data.productUrl,
      categoryId: data.categoryId,
      categoryName: data.categoryName,
      brand: data.brandName,
      rating: data.rating,
      reviewCount: data.reviewCount,
      description: undefined,
      specs: undefined,
      availability: data.statusType === 'NORMAL' ? 'in_stock' : 'out_of_stock',
      tags: data.tags,
    };
  }

  private handleError(error: unknown, operation: string): Error {
    if (
      error instanceof AffiliateError ||
      error instanceof AuthenticationError ||
      error instanceof RateLimitError
    ) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === 'RateLimitError') {
        throw error;
      }
      if (error.name === 'AuthenticationError') {
        throw error;
      }
      if (isRetryableError(error)) {
        return new AffiliateError(
          `Coupang ${operation} failed: ${error.message}`,
          'coupang',
          'REQUEST_FAILED',
          502,
          true,
          { operation, originalError: error.message },
          error,
        );
      }
    }

    return new AffiliateError(
      `Coupang ${operation} failed: ${String(error)}`,
      'coupang',
      'REQUEST_FAILED',
      502,
      false,
      { operation, originalError: String(error) },
      error instanceof Error ? error : undefined,
    );
  }
}

export function createCoupangAdapter(): CoupangAdapter {
  return new CoupangAdapter();
}
