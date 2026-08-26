// Core interfaces for Blog Auto Poster

// ============================================================================
// Affiliate Types
// ============================================================================

export interface AffiliateProduct {
  id: string;
  name: string;
  price: number;
  originalPrice?: number;
  discountRate?: number;
  currency: string;
  imageUrl?: string;
  productUrl: string;
  categoryId: string;
  categoryName: string;
  brand?: string;
  rating?: number;
  reviewCount?: number;
  description?: string;
  specs?: Record<string, unknown>;
  availability: 'in_stock' | 'out_of_stock' | 'limited';
  tags?: string[];
  commissionRate?: number;
}

export interface AffiliateSearchOptions {
  keyword: string;
  page?: number;
  limit?: number;
  categoryId?: string;
  sort?: 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'review_count' | 'newest';
  minPrice?: number;
  maxPrice?: number;
  brand?: string;
}

export interface AffiliateSearchResult {
  products: AffiliateProduct[];
  totalCount: number;
  currentPage: number;
  totalPages: number;
}

export interface AffiliateAdapter {
  readonly name: string;
  readonly supportedCategories: string[];
  initialize(config: AffiliateConfig): Promise<void>;
  searchProducts(options: AffiliateSearchOptions): Promise<AffiliateSearchResult>;
  getProductDetails(productId: string): Promise<AffiliateProduct>;
  generateTrackingUrl(productId: string, subId?: string): Promise<string>;
  getCommissionRates(categoryId: string): Promise<Record<string, number>>;
  validateCredentials(): Promise<boolean>;
}

export interface AffiliateConfig {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  trackingId?: string;
  baseUrl?: string;
  rateLimit?: {
    requestsPerMinute: number;
  };
  extra?: Record<string, unknown>;
}

// ============================================================================
// Platform Types
// ============================================================================
export interface PlatformPostContent {
  title: string;
  content: string;
  excerpt?: string;
  tags: string[];
  categories: string[];
  categoryId?: string;
  visibility: 'public' | 'private' | 'protected' | 'draft';
  images?: PlatformImage[];
  meta?: Record<string, unknown>;
  allowComments?: boolean;
  description?: string;
  videoPath?: string;
  scheduledAt?: string;
  password?: string;
  seo?: {
    title?: string;
    description?: string;
    keywords?: string[];
    canonicalUrl?: string;
    ogTitle?: string;
    ogDescription?: string;
    ogImage?: string;
    twitterCard?: string;
    jsonLd?: Record<string, unknown>;
  };
  customFields?: Record<string, unknown>;
}

export interface PlatformImage {
  localPath: string;
  remoteUrl?: string;
  url?: string;
  altText: string;
  caption?: string;
  width?: number;
  height?: number;
}

export interface PlatformPostResult {
  postId: string;
  url: string;
  publishedAt: Date;
  platformData?: Record<string, unknown>;
}

export interface PlatformCredentials {
  [key: string]: string | number | boolean;
}

export interface PlatformAdapter {
  readonly name: string;
  readonly supportedFeatures: PlatformFeature[];
  initialize(credentials: PlatformCredentials): Promise<void>;
  createPost(content: PlatformPostContent): Promise<PlatformPostResult>;
  updatePost(postId: string, content: Partial<PlatformPostContent>): Promise<PlatformPostResult>;
  getCategories(blogName?: string): Promise<PlatformCategory[]>;
  uploadImage(imagePath: string, options?: { filename?: string; alt?: string; caption?: string }): Promise<PlatformImage>;
  validateCredentials(): Promise<boolean>;
}

export interface PlatformCategory {
  id: string;
  name: string;
  parentId?: string;
  slug?: string;
}

export type PlatformFeature =
  | 'categories'
  | 'tags'
  | 'featured_image'
  | 'custom_fields'
  | 'scheduling'
  | 'seo_fields'
  | 'media_upload'
  | 'comments'
  | 'revisions';

// ============================================================================
// Template Types
// ============================================================================

export interface TemplateData {
  [key: string]: unknown;
}

export interface TemplateRenderResult {
  title: string;
  content: string;
  meta: {
    description: string;
    keywords: string[];
    jsonLd?: Record<string, unknown>;
  };
  tags: string[];
  categories: string[];
}

export interface TemplateFrontmatter {
  name: string;
  platforms: string[];
  requiredFields: string[];
  optionalFields?: string[];
  seo: {
    titleTemplate: string;
    descriptionTemplate: string;
    keywords: string[];
    jsonLd?: {
      type: string;
      includeReview: boolean;
      includeAggregateRating: boolean;
    };
  };
}

export interface TemplateEngine {
  registerHelper(name: string, helper: HandlebarsHelper): void;
  loadTemplates(): Promise<void>;
  validateTemplate(templateName: string): Promise<boolean>;
  render(templateName: string, data: TemplateData): Promise<TemplateRenderResult>;
  getTemplateNames(): string[];
  getTemplateInfo(templateName: string): TemplateFrontmatter | null;
  getAllTemplateInfos(): Map<string, TemplateFrontmatter>;
}

export type HandlebarsHelper = (context: HandlebarsContext, options: HandlebarsOptions) => string;

export interface HandlebarsContext {
  [key: string]: unknown;
}

export interface HandlebarsOptions {
  fn?: (context: unknown) => string;
  inverse?: (context: unknown) => string;
  hash?: Record<string, unknown>;
  data?: HandlebarsData;
}

export interface HandlebarsData {
  [key: string]: unknown;
}

// ============================================================================
// Image Generation Types
// ============================================================================

export interface ImageGenerator {
  generate(prompt: string, options?: ImageGenerationOptions): Promise<ImageGenerationResult>;
  registerProvider(name: string, provider: ImageProvider): void;
  setDefaultProvider(name: string): void;
  validateAllProviders(): Promise<Record<string, boolean>>;
  getProviders(): string[];
}

export interface ImageGenerationOptions {
  style?: string;
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
  count?: number;
}

export interface ImageGenerationResult {
  urls: string[];
  localPaths: string[];
  provider?: string;
}

export interface ImageProvider {
  readonly name: string;
  generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult>;
  validateConfig(): Promise<boolean>;
}

// ============================================================================
// Intelligence Types
// ============================================================================

export interface KeywordData {
  keyword: string;
  volume: number;
  competition: number;
  trend: 'rising' | 'falling' | 'stable';
  related: string[];
  source: string;
  metadata?: Record<string, unknown>;
}

export interface KeywordProvider {
  readonly name: string;
  research(keywords: string[], options?: KeywordResearchOptions): Promise<KeywordData[]>;
  validateConfig(): Promise<boolean>;
}
export interface KeywordResearchOptions {
  providers?: string[];
  limit?: number;
  minVolume?: number;
  maxCompetition?: 'low' | 'medium' | 'high';
  includeRelated?: boolean;
  includeTrending?: boolean;
  language?: string;
  country?: string;
  period?: string;
}
export interface CompetitorPost {
  platform: string;
  url: string;
  title: string;
  excerpt: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  publishedAt: string;
  author?: string;
  blogName?: string;
  structure: CompetitorPostStructure[];
  affiliateLinks: string[];
  ctaPatterns: string[];
  score: number;
  metadata?: Record<string, unknown>;
}

export interface CompetitorPostStructure {
  level: number;
  text: string;
}

export interface CompetitorAnalyzer {
  readonly name: string;
  analyze(keyword: string, platforms: string[], limit: number): Promise<CompetitorPost[]>;
}

export interface CompetitorAnalysisOptions {
  platforms?: string[];
  limit?: number;
}

export interface TopicRecommendation {
  keyword: string;
  keywordData: KeywordData;
  affiliateData?: AffiliateProduct;
  competitorPosts: CompetitorPost[];
  contentGap: string[];
  suggestedAngles: string[];
  recommendedTemplate: string;
  priority: 'high' | 'medium' | 'low';
  estimatedEffort: 'low' | 'medium' | 'high';
}

export interface TopicSelectionConfig {
  minScore?: number;
  maxResults?: number;
  weights?: {
    searchVolume: number;
    commissionRate: number;
    contentGap: number;
    trendVelocity: number;
  };
  filters?: {
    minVolume?: number;
    maxCompetition?: number;
    trends?: ('rising' | 'falling' | 'stable')[];
    minCommission?: number;
  };
}

export interface TopicSelector {
  select(candidates: TopicRecommendation[], config: TopicSelectionConfig): Promise<TopicRecommendation[]>;
}

// ============================================================================
// Content Types
// ============================================================================

export interface PostContent {
  id: string;
  template: string;
  productId: string;
  platform: string;
  status: PostStatus;
  title: string;
  content: string;
  meta: TemplateRenderResult['meta'];
  tags: string[];
  categories: string[];
  platformContent: Record<string, PlatformPostContent>;
  affiliateUrl: string;
  images: string[];
  createdAt: string;
  updatedAt: string;
}

export type PostStatus =
  | 'DRAFT'
  | 'GENERATING'
  | 'READY'
  | 'PUBLISHING'
  | 'PUBLISHED'
  | 'FAILED';

// ============================================================================
// Scheduler Types
// ============================================================================

export interface Job {
  id: string;
  type: JobType;
  status: JobStatus;
  priority: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  attempts: number;
  maxAttempts: number;
  scheduledAt?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type JobType =
  | 'RESEARCH'
  | 'GENERATE'
  | 'PUBLISH'
  | 'SYNC_ANALYTICS'
  | 'REFRESH_TOKEN'
  | 'CLEANUP';

export type JobStatus =
  | 'PENDING'
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'RETRYING'
  | 'DEAD_LETTER';

export interface JobQueue {
  enqueue(job: Omit<Job, 'id' | 'retryCount' | 'status'>): Promise<string>;
  dequeue(types?: JobType[]): Promise<Job | null>;
  complete(jobId: string, result?: Record<string, unknown>): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  retry(jobId: string): Promise<boolean>;
  getJob(jobId: string): Promise<Job | null>;
  getJobs(filters?: JobFilters): Promise<Job[]>;
  getStats(): JobQueueStats;
  cleanup(olderThanDays: number): Promise<number>;
}

export interface JobFilters {
  type?: JobType;
  status?: JobStatus;
  platform?: string;
  affiliate?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export interface JobQueueStats {
  pending: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  retrying: number;
  deadLetter: number;
  total: number;
  byType: Record<string, Record<string, number>>;
}

export interface SchedulerConfig {
  enabled: boolean;
  timezone: string;
  jobs: ScheduledJobConfig[];
  concurrency: {
    default: number;
    perPlatform: Record<string, number>;
    perAffiliate: Record<string, number>;
  };
}

export interface ScheduledJobConfig {
  name: string;
  type: JobType;
  cron: string;
  enabled: boolean;
  priority?: number;
  maxAttempts?: number;
  config: Record<string, unknown>;
}

// ============================================================================
// Config Types
// ============================================================================

export interface ConfigManager {
  load(): Promise<void>;
  reload(): Promise<void>;
  get<T>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
  has(key: string): boolean;
  getAll(): Record<string, unknown>;
  getAffiliateConfig(name: string): AffiliateConfig | null;
  getPlatformConfig(name: string): PlatformCredentials | null;
  getImageProviderConfig(name: string): ImageProviderConfig | null;
  getKeywordProviderConfig(name: string): KeywordProviderConfig | null;
}

export interface ImageProviderConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  extra?: Record<string, unknown>;
}
export interface KeywordProviderConfig {
  apiKey?: string;
  apiSecret?: string;
  baseUrl?: string;
  enabled?: boolean;
  useSerpApi?: boolean;
  useApiHub?: boolean;
  extra?: Record<string, unknown>;
}

export interface AppConfig {
  app: {
    name: string;
    version: string;
    env: 'development' | 'staging' | 'production';
    logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    dataDir: string;
    cacheDir: string;
    outputDir: string;
  };
  affiliates: Record<string, AffiliateConfig>;
  platforms: Record<string, PlatformCredentials>;
  imageProviders: Record<string, ImageProviderConfig>;
  keywordProviders: Record<string, KeywordProviderConfig>;
  scheduler: SchedulerConfig;
  jobQueue: {
    dbPath: string;
    maxConcurrentJobs: number;
    defaultRetryAttempts: number;
    defaultRetryDelayMs: number;
    deadLetterAfterAttempts: number;
  };
  templates: {
    dir: string;
    defaultTemplate: string;
    validation: boolean;
    directory?: string;
  };
  seo: {
    defaultTitleTemplate: string;
    defaultDescriptionTemplate: string;
    defaultKeywords: string[];
    jsonLd: boolean;
  };
  web: {
    enabled: boolean;
    host: string;
    port: number;
    jwtSecret: string;
    jwtExpiresIn: string;
    cors: {
      origin: string;
      credentials: boolean;
    };
    rateLimit: {
      windowMs: number;
      maxRequests: number;
    };
  };
  intelligence?: {
    keywordResearch?: {
      defaultProvider?: string;
      cacheTtlHours?: number;
      minVolume?: number;
    };
    competitorAnalysis?: {
      defaultPlatforms?: string[];
      defaultProviders?: string[];
      cacheTtlHours?: number;
      minViews?: number;
    };
    topicSelection?: {
      maxTopics?: number;
      minScore?: number;
      weightSearchVolume?: number;
      weightCommissionRate?: number;
      weightContentGap?: number;
      weightTrendVelocity?: number;
    };
  };
  publishing?: {
    defaultPlatforms?: string[];
    defaultPlatform?: string;
    reviewRequired?: boolean;
    dryRun?: boolean;
    maxConcurrentPublishes?: number;
  };
}