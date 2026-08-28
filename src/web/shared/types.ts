// Shared types between server and client

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface DashboardStats {
  totalPosts: number;
  todayPosts: number;
  publishedPosts: number;
  failedPosts: number;
  successRate: number;
  jobQueue: JobQueueStats;
  affiliates: Record<string, boolean>;
  platforms: Record<string, boolean>;
  recentPosts: RecentPost[];
}

export interface RecentPost {
  id: string;
  title: string;
  platform: string;
  status: string;
  publishedAt: string;
}

export interface JobQueueStats {
  total: number;
  pending: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  retrying: number;
  deadLetter: number;
  byType: Record<string, Record<string, number>>;
}

export interface BlogInfo {
  name: string;
  platform: string;
  connected: boolean;
  categories: Category[];
  lastPost: LastPost | null;
  config: Record<string, unknown> | null;
}

export interface Category {
  id: string;
  name: string;
  parentId?: string;
  slug?: string;
}

export interface LastPost {
  id: string;
  title: string;
  url: string;
  publishedAt: string;
  status: string;
}

export interface CoupangStatus {
  connected: boolean;
  recentPosts: number;
  earnings: number;
  clicks: number;
  conversions: number;
  approvalRate: number;
}

export interface KeywordData {
  keyword: string;
  volume: number;
  competition: number;
  trend: 'rising' | 'falling' | 'stable';
  related: string[];
  source: string;
  metadata?: Record<string, unknown>;
}

export interface KeywordResearchRequest {
  keywords: string[];
  providers?: string[];
  limit?: number;
}

export interface KeywordResearchResponse {
  keywords: KeywordData[];
}

export interface PostSummary {
  id: string;
  jobId?: string;
  platform: string;
  postId: string;
  url: string;
  title: string;
  template: string;
  productId: string;
  status: string;
  publishedAt: string;
  metadata?: Record<string, unknown>;
}

export interface CreatePostRequest {
  template: string;
  productId: string;
  platform: string;
  subId?: string;
}

export interface CreatePostResponse {
  post: PostContent;
}

export interface PostContent {
  id: string;
  template: string;
  productId: string;
  platform: string;
  status: string;
  title: string;
  content: string;
  meta: PostMeta;
  tags: string[];
  categories: string[];
  platformContent: Record<string, PlatformPostContent>;
  affiliateUrl: string;
  images: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PostMeta {
  description: string;
  keywords: string[];
  jsonLd?: Record<string, unknown>;
}

export interface PlatformPostContent {
  title: string;
  content: string;
  tags?: string[];
  categories?: string[];
  meta?: Record<string, unknown>;
  visibility?: string;
  allowComments?: boolean;
  featuredImageId?: string;
  excerpt?: string;
  scheduledAt?: string;
  password?: string;
  videoPath?: string;
  thumbnailPath?: string;
}

export interface PublishPostRequest {
  platform?: string;
}

export interface PublishPostResponse {
  results: PublishResult[];
}

export interface PublishResult {
  platform: string;
  postId?: string;
  url?: string;
  publishedAt?: string;
  error?: string;
  success: boolean;
}

export interface ScheduledJob {
  name: string;
  type: string;
  cron: string;
  enabled: boolean;
  priority: number;
  config: Record<string, unknown>;
  nextRun?: string;
}

export interface SchedulerConfig {
  enabled: boolean;
  timezone: string;
  jobs: ScheduledJobConfig[];
}

export interface ScheduledJobConfig {
  name: string;
  type: 'RESEARCH' | 'GENERATE' | 'PUBLISH' | 'SYNC_ANALYTICS';
  cron: string;
  enabled: boolean;
  priority?: number;
  maxAttempts?: number;
  config: Record<string, unknown>;
}

export interface AnalyticsResponse {
  period: { days: number; from: string; to: string };
  totalPosts: number;
  byDay: DailyAnalytics[];
  byPlatform: Record<string, number>;
  byTemplate: Record<string, number>;
  successRate: number;
}

export interface DailyAnalytics {
  date: string;
  posts: number;
  platforms: Record<string, number>;
}

export interface TemplateInfo {
  name: string;
  platforms: string[];
  requiredFields: string[];
  optionalFields: string[];
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

export interface WebSocketMessage {
  type: 'status' | 'log' | 'progress' | 'notification' | 'pong';
  data: unknown;
  timestamp: number;
}

export interface LogEntry {
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  metadata?: Record<string, unknown>;
  timestamp: string;
  jobId?: string;
}

export interface JobProgress {
  jobId: string;
  type: string;
  status: string;
  progress: number;
  message?: string;
}
