import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { ConfigManager, AppConfig, AffiliateConfig, PlatformCredentials, ImageProviderConfig, KeywordProviderConfig } from './interfaces';

export class ConfigManagerImpl implements ConfigManager {
  private config: AppConfig;
  private configPath: string;
  private secretsPath: string;
  private envPrefix = 'BLOG_POSTER_';
  private loaded = false;

  constructor(configDir: string = 'config', env: string = process.env.NODE_ENV || 'development') {
    this.configPath = path.resolve(configDir, `${env}.yaml`);
    this.secretsPath = path.resolve(configDir, 'secrets.yaml');
    this.config = this.getDefaultConfig();
  }

  private getDefaultConfig(): AppConfig {
    const dataDir = process.env.BLOG_POSTER_DATA_DIR || path.resolve(process.cwd(), 'data');
    const cacheDir = process.env.BLOG_POSTER_CACHE_DIR || path.resolve(process.cwd(), '.cache');
    const outputDir = process.env.BLOG_POSTER_OUTPUT_DIR || path.resolve(process.cwd(), 'output');

    return {
      app: {
        name: 'blog-auto-poster',
        version: '1.0.0',
        env: (process.env.NODE_ENV as AppConfig['app']['env']) || 'development',
        logLevel: (process.env.BLOG_POSTER_LOG_LEVEL as AppConfig['app']['logLevel']) || 'info',
        dataDir,
        cacheDir,
        outputDir,
      },
      affiliates: {},
      platforms: {},
      imageProviders: {},
      keywordProviders: {},
      templates: {
        dir: path.resolve(process.cwd(), 'templates'),
        defaultTemplate: 'coupang-product-review',
        validation: true,
      },
      scheduler: {
        enabled: true,
        timezone: 'Asia/Seoul',
        jobs: [],
        concurrency: {
          default: 3,
          perPlatform: {},
          perAffiliate: {},
        },
      },
      intelligence: {
        keywordResearch: {
          defaultProvider: 'naver',
          cacheTtlHours: 24,
          minVolume: 100,
        },
        competitorAnalysis: {
          defaultProviders: ['naver-blog', 'tistory'],
          cacheTtlHours: 1,
          minViews: 100,
        },
        topicSelection: {
          maxTopics: 10,
          minScore: 0.3,
          weightSearchVolume: 0.3,
          weightCommissionRate: 0.25,
          weightContentGap: 0.25,
          weightTrendVelocity: 0.2,
        },
      },
      publishing: {
        dryRun: true,
        maxConcurrentPublishes: 2,
      },
      jobQueue: {
        dbPath: path.resolve(dataDir, 'jobs.sqlite'),
        maxConcurrentJobs: 3,
        defaultRetryAttempts: 3,
        defaultRetryDelayMs: 5000,
        deadLetterAfterAttempts: 5,
      },
      seo: {
        defaultTitleTemplate: '{{productName}} 리뷰 - 장단점 총정리',
        defaultDescriptionTemplate: '{{productName}} 구매 전 꼭 확인하세요. 가격 {{price}}원...',
        defaultKeywords: ['리뷰', '추천', '가성비', '후기'],
        jsonLd: true,
      },
      web: {
        enabled: false,
        host: '0.0.0.0',
        port: 3000,
        jwtSecret: 'change-me-in-production',
        jwtExpiresIn: '7d',
        cors: {
          origin: '*',
          credentials: true,
        },
        rateLimit: {
          windowMs: 900000,
          maxRequests: 100,
        },
      },
    };
  }

  async load(): Promise<void> {
    if (this.loaded) return;

    const defaultConfigPath = path.resolve(path.dirname(this.configPath), 'default.yaml');

    const configs: Partial<AppConfig>[] = [];

    if (fs.existsSync(defaultConfigPath)) {
      configs.push(this.loadYamlFile(defaultConfigPath));
    }

    if (fs.existsSync(this.configPath)) {
      configs.push(this.loadYamlFile(this.configPath));
    }

    if (fs.existsSync(this.secretsPath)) {
      configs.push(this.loadYamlFile(this.secretsPath));
    }

    this.config = this.deepMerge(this.config, ...configs);
    this.applyEnvOverrides();
    this.ensureDirectories();
    this.loaded = true;
  }

  private loadYamlFile(filePath: string): Partial<AppConfig> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return yaml.load(content) as Partial<AppConfig> || {};
    } catch (error) {
      console.error(`Failed to load config from ${filePath}:`, error);
      return {};
    }
  }

  private applyEnvOverrides(): void {
    const envMappings: Record<string, (value: string) => void> = {
      [`${this.envPrefix}LOG_LEVEL`]: (v) => (this.config.app.logLevel = v as AppConfig['app']['logLevel']),
      [`${this.envPrefix}DATA_DIR`]: (v) => (this.config.app.dataDir = v),
      [`${this.envPrefix}CACHE_DIR`]: (v) => (this.config.app.cacheDir = v),
      [`${this.envPrefix}OUTPUT_DIR`]: (v) => (this.config.app.outputDir = v),
      [`${this.envPrefix}ENV`]: (v) => (this.config.app.env = v as AppConfig['app']['env']),
      [`${this.envPrefix}TEMPLATE_DIR`]: (v) => (this.config.templates.directory = v),
      [`${this.envPrefix}DEFAULT_TEMPLATE`]: (v) => (this.config.templates.defaultTemplate = v),
      [`${this.envPrefix}DRY_RUN`]: (v) => (this.config.publishing.dryRun = v === 'true'),
      [`${this.envPrefix}TIMEZONE`]: (v) => (this.config.scheduler.timezone = v),
    };

    for (const [envKey, setter] of Object.entries(envMappings)) {
      const value = process.env[envKey];
      if (value !== undefined) {
        try {
          setter(value);
        } catch {
          console.warn(`Failed to apply env override for ${envKey}`);
        }
      }
    }

    this.applyAffiliateEnvOverrides();
    this.applyPlatformEnvOverrides();
    this.applyImageProviderEnvOverrides();
    this.applyKeywordProviderEnvOverrides();
  }

  private applyAffiliateEnvOverrides(): void {
    const affiliatePrefixes = ['COUPANG', 'ALIEXPRESS', 'NAVER_SHOPPING'];

    for (const prefix of affiliatePrefixes) {
      const affiliateKey = prefix.toLowerCase().replace('_', '-');
      const envPrefix = `BLOG_POSTER_AFFILIATE_${prefix}_`;

      if (!this.config.affiliates[affiliateKey]) {
        this.config.affiliates[affiliateKey] = {} as AffiliateConfig;
      }

      const mappings: Record<string, (value: string) => void> = {
        [`${envPrefix}API_KEY`]: (v) => (this.config.affiliates[affiliateKey].apiKey = v),
        [`${envPrefix}API_SECRET`]: (v) => (this.config.affiliates[affiliateKey].apiSecret = v),
        [`${envPrefix}ACCESS_TOKEN`]: (v) => (this.config.affiliates[affiliateKey].accessToken = v),
        [`${envPrefix}REFRESH_TOKEN`]: (v) => (this.config.affiliates[affiliateKey].refreshToken = v),
        [`${envPrefix}BASE_URL`]: (v) => (this.config.affiliates[affiliateKey].baseUrl = v),
      };

      for (const [envKey, setter] of Object.entries(mappings)) {
        const value = process.env[envKey];
        if (value !== undefined) {
          setter(value);
        }
      }
    }
  }

  private applyPlatformEnvOverrides(): void {
    const platformPrefixes = ['TISTORY', 'WORDPRESS', 'YOUTUBE'];

    for (const prefix of platformPrefixes) {
      const platformKey = prefix.toLowerCase();
      const envPrefix = `BLOG_POSTER_PLATFORM_${prefix}_`;

      if (!this.config.platforms[platformKey]) {
        this.config.platforms[platformKey] = {};
      }

      const mappings: Record<string, (value: string) => void> = {
        [`${envPrefix}CLIENT_ID`]: (v) => (this.config.platforms[platformKey].clientId = v),
        [`${envPrefix}CLIENT_SECRET`]: (v) => (this.config.platforms[platformKey].clientSecret = v),
        [`${envPrefix}ACCESS_TOKEN`]: (v) => (this.config.platforms[platformKey].accessToken = v),
        [`${envPrefix}REFRESH_TOKEN`]: (v) => (this.config.platforms[platformKey].refreshToken = v),
        [`${envPrefix}BLOG_NAME`]: (v) => (this.config.platforms[platformKey].blogName = v),
        [`${envPrefix}USERNAME`]: (v) => (this.config.platforms[platformKey].username = v),
        [`${envPrefix}PASSWORD`]: (v) => (this.config.platforms[platformKey].password = v),
        [`${envPrefix}APP_PASSWORD`]: (v) => (this.config.platforms[platformKey].appPassword = v),
        [`${envPrefix}SITE_URL`]: (v) => (this.config.platforms[platformKey].siteUrl = v),
      };

      for (const [envKey, setter] of Object.entries(mappings)) {
        const value = process.env[envKey];
        if (value !== undefined) {
          setter(value);
        }
      }
    }
  }

  private applyImageProviderEnvOverrides(): void {
    const providerPrefixes = ['OPENAI', 'STABLE_DIFFUSION', 'GEMINI'];

    for (const prefix of providerPrefixes) {
      const providerKey = prefix.toLowerCase().replace('_', '-');
      const envPrefix = `BLOG_POSTER_IMAGE_${prefix}_`;

      if (!this.config.imageProviders[providerKey]) {
        this.config.imageProviders[providerKey] = {} as ImageProviderConfig;
      }

      const mappings: Record<string, (value: string) => void> = {
        [`${envPrefix}API_KEY`]: (v) => (this.config.imageProviders[providerKey].apiKey = v),
        [`${envPrefix}BASE_URL`]: (v) => (this.config.imageProviders[providerKey].baseUrl = v),
        [`${envPrefix}MODEL`]: (v) => (this.config.imageProviders[providerKey].model = v),
      };

      for (const [envKey, setter] of Object.entries(mappings)) {
        const value = process.env[envKey];
        if (value !== undefined) {
          setter(value);
        }
      }
    }
  }

  private applyKeywordProviderEnvOverrides(): void {
    const providerPrefixes = ['NAVER', 'GOOGLE_TRENDS', 'COUPANG', 'NAVER_API_HUB'];

    for (const prefix of providerPrefixes) {
      const providerKey = prefix.toLowerCase().replace('_', '-');
      const envPrefix = `BLOG_POSTER_KEYWORD_${prefix}_`;

      if (!this.config.keywordProviders[providerKey]) {
        this.config.keywordProviders[providerKey] = {} as KeywordProviderConfig;
      }

      const mappings: Record<string, (value: string) => void> = {
        [`${envPrefix}API_KEY`]: (v) => (this.config.keywordProviders[providerKey].apiKey = v),
        [`${envPrefix}API_SECRET`]: (v) => (this.config.keywordProviders[providerKey].apiSecret = v),
        [`${envPrefix}BASE_URL`]: (v) => (this.config.keywordProviders[providerKey].baseUrl = v),
        [`${envPrefix}USE_API_HUB`]: (v) => (this.config.keywordProviders[providerKey].useApiHub = v === 'true'),
      };

      for (const [envKey, setter] of Object.entries(mappings)) {
        const value = process.env[envKey];
        if (value !== undefined) {
          setter(value);
        }
      }
    }
  }

  private ensureDirectories(): void {
    for (const dir of [this.config.app.dataDir, this.config.app.cacheDir, this.config.app.outputDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private deepMerge(target: AppConfig, ...sources: Partial<AppConfig>[]): AppConfig {
    const result = JSON.parse(JSON.stringify(target)) as AppConfig;

    for (const source of sources) {
      if (!source) continue;
      this.mergeObject(result as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
    }

    return result;
  }

  private mergeObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
    for (const key of Object.keys(source)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        this.mergeObject(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>);
      } else {
        target[key] = sourceValue;
      }
    }
  }

  async reload(): Promise<void> {
    this.loaded = false;
    await this.load();
  }

  get<T>(key: string, defaultValue?: T): T {
    const keys = key.split('.');
    let current: unknown = this.config;

    for (const k of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return defaultValue as T;
      }
      current = (current as Record<string, unknown>)[k];
    }

    return current as T ?? defaultValue as T;
  }

  set(key: string, value: unknown): void {
    const keys = key.split('.');
    let current: Record<string, unknown> = this.config as unknown as Record<string, unknown>;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== 'object' || current[k] === null) {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
  }

  has(key: string): boolean {
    const keys = key.split('.');
    let current: unknown = this.config;

    for (const k of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return false;
      }
      if (!(k in (current as Record<string, unknown>))) {
        return false;
      }
      current = (current as Record<string, unknown>)[k];
    }

    return true;
  }

  getAll(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(this.config));
  }

  getAffiliateConfig(name: string): AffiliateConfig | null {
    const config = this.config.affiliates[name];
    if (!config || !config.apiKey || !config.apiSecret) {
      return null;
    }
    return config;
  }

  getPlatformConfig(name: string): PlatformCredentials | null {
    const config = this.config.platforms[name];
    if (!config || Object.keys(config).length === 0) {
      return null;
    }
    return config;
  }

  getImageProviderConfig(name: string): ImageProviderConfig | null {
    const config = this.config.imageProviders[name];
    if (!config || !config.apiKey) {
      return null;
    }
    return config;
  }

  getKeywordProviderConfig(name: string): KeywordProviderConfig | null {
    const config = this.config.keywordProviders[name];
    if (!config) {
      return null;
    }
    return config;
  }
}

let configManagerInstance: ConfigManagerImpl | null = null;

export function getConfigManager(configDir?: string, env?: string): ConfigManager {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManagerImpl(configDir, env);
  }
  return configManagerInstance;
}

export function resetConfigManager(): void {
  configManagerInstance = null;
}