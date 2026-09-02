import { getLogger } from '@core/logger';
import { ImageGenerator, ImageGenerationOptions, ImageGenerationResult } from '@core/interfaces';
import { TemplateError, ConfigurationError } from '@core/errors';
import { getConfigManager } from '@core/config';
import { buildSectionImageMap } from './imagePrompts';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('image-generator');

/* ============================================================
 * 비용 통제 (#8) — 단가 추정, 예산 게이트, 프롬프트 캐시
 * ============================================================ */

/**
 * gpt-image-1 예상 단가 표(USD/장). 실제 단가는 OpenAI 요금 페이지 기준이며
 * 근사치다. 키: `${size}|${quality}`.
 */
const OPENAI_IMAGE_UNIT_COST_USD: Record<string, number> = {
  '1024x1024|low': 0.011,
  '1024x1024|medium': 0.063,
  '1024x1024|high': 0.17,
  '1024x1024|auto': 0.179,
  '1024x1536|low': 0.016,
  '1024x1536|medium': 0.119,
  '1024x1536|high': 0.25,
  '1024x1536|auto': 0.254,
  '1536x1024|low': 0.016,
  '1536x1024|medium': 0.119,
  '1536x1024|high': 0.25,
  '1536x1024|auto': 0.256,
};

/** gemini-3.1-flash-image 근사 단가(USD/장) — 토큰 기반 과금의 평균치 */
const GEMINI_IMAGE_FLAT_COST_USD = 0.03;

/** 프로바이더/설정 기준 1장당 예상 비용(USD). 단가 미상이면 null. */
export function estimateImageCostUsd(
  provider: string,
  opts: { model?: string; size?: string; quality?: string } = {},
): number | null {
  if (provider === 'openai' || provider === 'dalle') {
    const size = opts.size || '1024x1024';
    const quality = opts.quality || 'low';
    return OPENAI_IMAGE_UNIT_COST_USD[`${size}|${quality}`] ?? null;
  }
  if (provider === 'gemini') {
    return GEMINI_IMAGE_FLAT_COST_USD;
  }
  return null;
}

export interface ImageBudgetConfig {
  /** 하루 최대 생성 장수. 0이면 무제한. */
  dailyImageLimit: number;
  /** 하루 최대 누적 예상 비용(USD). 0이면 비용 한도 미사용. */
  dailyCostLimitUsd: number;
}

/**
 * `imageProviders.budget` 설정 해석. 기본값은 보수적으로 잡는다:
 * 하루 20장 / 비용 한도 미사용. 무제한을 원하면 dailyImageLimit: 0.
 */
export function resolveImageBudgetConfig(): ImageBudgetConfig {
  try {
    const raw = getConfigManager().get('imageProviders.budget') as
      Record<string, unknown> | undefined;
    const num = (v: unknown, d: number) => (typeof v === 'number' && v >= 0 ? v : d);
    return {
      dailyImageLimit: num(raw?.dailyImageLimit, 20),
      dailyCostLimitUsd: num(raw?.dailyCostLimitUsd, 0),
    };
  } catch {
    return { dailyImageLimit: 20, dailyCostLimitUsd: 0 };
  }
}

/** 포스트당 이미지 생성 상한. `imageProviders.maxImagesPerPost`, 기본 3. */
export function resolveMaxImagesPerPost(): number {
  try {
    const raw = getConfigManager().get('imageProviders.maxImagesPerPost');
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
  } catch {
    return 3;
  }
}

interface ImageUsageLedger {
  /** YYYY-MM-DD (로컬 날짜) */
  date: string;
  /** 오늘 생성 예약된 장수 (성공/실패 무관 선점, 실패 시 반납) */
  count: number;
  /** 오늘 누적 예상 비용(USD) */
  estCostUsd: number;
}

function todayKey(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export interface ImageProvider {
  name: string;
  generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult>;
  validateConfig(): Promise<boolean>;
}

export class DalleProvider implements ImageProvider {
  readonly name = 'dalle';

  private apiKey: string;
  private model: string;
  private defaultStyle: string;
  private defaultQuality: string;
  private defaultSize: string;

  constructor(config: {
    apiKey: string;
    model?: string;
    defaultStyle?: string;
    defaultQuality?: string;
    defaultSize?: string;
  }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'dall-e-3';
    this.defaultStyle = config.defaultStyle || 'vivid';
    this.defaultQuality = config.defaultQuality || 'hd';
    this.defaultSize = config.defaultSize || '1024x1024';
  }

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    // This would call the OpenAI API
    // For now, return placeholder
    logger.warn('DALL-E provider not fully implemented, returning placeholder');
    return this.generatePlaceholder(prompt, options);
  }

  private async generatePlaceholder(
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    const count = options.count || 1;
    const urls: string[] = [];
    const localPaths: string[] = [];

    for (let i = 0; i < count; i++) {
      const placeholderUrl = `https://via.placeholder.com/${options.aspectRatio === '9:16' ? '1080x1920' : '1024x1024'}/cccccc/666666?text=${encodeURIComponent(prompt.substring(0, 50))}`;
      urls.push(placeholderUrl);
    }

    return { urls, localPaths, provider: this.name };
  }

  async validateConfig(): Promise<boolean> {
    return !!this.apiKey;
  }
}

export class StableDiffusionProvider implements ImageProvider {
  readonly name = 'stable-diffusion';

  private apiUrl: string;
  private apiKey: string;
  private defaultEngine: string;

  constructor(config: { apiUrl: string; apiKey: string; defaultEngine?: string }) {
    this.apiUrl = config.apiUrl;
    this.apiKey = config.apiKey;
    this.defaultEngine = config.defaultEngine || 'stable-diffusion-xl-1024-v1-0';
  }

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    logger.warn('Stable Diffusion provider not fully implemented, returning placeholder');
    return this.generatePlaceholder(prompt, options);
  }

  private async generatePlaceholder(
    prompt: string,
    options: ImageGenerationOptions,
  ): Promise<ImageGenerationResult> {
    const count = options.count || 1;
    const urls: string[] = [];
    const localPaths: string[] = [];

    for (let i = 0; i < count; i++) {
      const placeholderUrl = `https://via.placeholder.com/${options.aspectRatio === '9:16' ? '1080x1920' : '1024x1024'}/aaaaaa/555555?text=${encodeURIComponent(prompt.substring(0, 50))}`;
      urls.push(placeholderUrl);
    }

    return { urls, localPaths, provider: this.name };
  }

  async validateConfig(): Promise<boolean> {
    return !!this.apiKey;
  }
}

export const DEFAULT_GEMINI_IMAGE_MODEL = 'gemini-3.1-flash-image';
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** 이미지 생성에 쓸 수 있는 모델명인지 판별 (텍스트용 flash/pro 계열은 거부) */
const GEMINI_IMAGE_MODEL_PATTERN = /image|imagen/i;

export class GeminiProvider implements ImageProvider {
  readonly name = 'gemini';

  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config: { apiKey: string; model?: string; baseUrl?: string; timeoutMs?: number }) {
    // 복사-붙여넣기 키의 앞뒤 공백/개행이 인증 헤더를 깨뜨리므로 원천에서 trim한다.
    this.apiKey = (config.apiKey || '').trim();
    this.model = config.model || DEFAULT_GEMINI_IMAGE_MODEL;
    this.baseUrl = (config.baseUrl || GEMINI_API_BASE).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? 90_000;
  }

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const count = options.count || 1;
    const urls: string[] = [];

    for (let i = 0; i < count; i++) {
      urls.push(await this.generateOne(prompt));
    }

    return { urls, localPaths: [], provider: this.name };
  }

  /** Gemini 이미지 생성 REST API 1회 호출 → inlineData base64를 data URL로 반환 */
  private async generateOne(prompt: string): Promise<string> {
    const response = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': this.apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini image API ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
      promptFeedback?: { blockReason?: string };
    };

    const inline = data.candidates?.[0]?.content?.parts?.find(
      (p) => p.inlineData?.data,
    )?.inlineData;
    if (!inline?.data) {
      const blocked = data.promptFeedback?.blockReason
        ? ` (blocked: ${data.promptFeedback.blockReason})`
        : '';
      throw new Error(`Gemini image response contains no inlineData${blocked}`);
    }

    return `data:${inline.mimeType || 'image/png'};base64,${inline.data}`;
  }

  async validateConfig(): Promise<boolean> {
    return !!this.apiKey;
  }
}

export const DEFAULT_OPENAI_IMAGE_MODEL = 'gpt-image-1';
const OPENAI_IMAGE_API_URL = 'https://api.openai.com/v1/images/generations';

/**
 * OpenAI images API 요청 바디 빌더.
 * gpt-image-1은 b64_json만 반환하므로 response_format 파라미터가 불요하다.
 */
export function buildOpenAIImageRequestBody(
  prompt: string,
  config: { model?: string; size?: string; quality?: string },
): Record<string, unknown> {
  return {
    model: config.model || DEFAULT_OPENAI_IMAGE_MODEL,
    prompt,
    n: 1,
    size: config.size || '1024x1024',
    // 기본 'high'는 장당 ~$0.17로 크레딧이 빠르게 소진된다(#8). 기본 'low'로 하향 —
    // 더 높은 품질이 필요하면 imageProviders.openai.quality 로 명시한다.
    quality: config.quality || 'low',
  };
}

export class OpenAIProvider implements ImageProvider {
  readonly name = 'openai';

  private apiKey: string;
  private model: string;
  private size: string;
  private quality: string;
  private timeoutMs: number;

  constructor(config: {
    apiKey: string;
    model?: string;
    size?: string;
    quality?: string;
    timeoutMs?: number;
  }) {
    // 복사-붙여넣기 키의 앞뒤 공백/개행이 Bearer 헤더를 깨뜨리므로 원천에서 trim한다.
    this.apiKey = (config.apiKey || '').trim();
    this.model = config.model || DEFAULT_OPENAI_IMAGE_MODEL;
    this.size = config.size || '1024x1024';
    // 'high' 기본은 장당 ~$0.17 — 비용 통제(#8)로 'low' 기본으로 하향.
    this.quality = config.quality || 'low';
    this.timeoutMs = config.timeoutMs ?? 90_000;
  }

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const count = options.count || 1;
    const urls: string[] = [];

    for (let i = 0; i < count; i++) {
      urls.push(await this.generateOne(prompt));
    }

    return { urls, localPaths: [], provider: this.name };
  }

  /** OpenAI images generation 1회 호출 → data[0].b64_json을 data URL로 반환 */
  private async generateOne(prompt: string): Promise<string> {
    const response = await fetch(OPENAI_IMAGE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(
        buildOpenAIImageRequestBody(prompt, {
          model: this.model,
          size: this.size,
          quality: this.quality,
        }),
      ),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`OpenAI image API ${response.status}: ${body.slice(0, 300)}`);
    }

    const data = (await response.json()) as { data?: Array<{ b64_json?: string }> };
    const b64 = data.data?.[0]?.b64_json;
    if (!b64) {
      throw new Error('OpenAI image response contains no b64_json');
    }

    return `data:image/png;base64,${b64}`;
  }

  async validateConfig(): Promise<boolean> {
    return !!this.apiKey;
  }
}

export class PlaceholderProvider implements ImageProvider {
  readonly name = 'placeholder';

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    const count = options.count || 1;
    const urls: string[] = [];
    const localPaths: string[] = [];

    const width = options.aspectRatio === '9:16' ? 1080 : 1024;
    const height = options.aspectRatio === '9:16' ? 1920 : 1024;

    for (let i = 0; i < count; i++) {
      const text = `${prompt.substring(0, 50)}${count > 1 ? ` (${i + 1}/${count})` : ''}`;
      const url = `https://via.placeholder.com/${width}x${height}/e0e0e0/666666?text=${encodeURIComponent(text)}`;
      urls.push(url);
    }

    return { urls, localPaths, provider: this.name };
  }

  async validateConfig(): Promise<boolean> {
    return true;
  }
}

export class ImageGeneratorImpl implements ImageGenerator {
  private providers = new Map<string, ImageProvider>();
  private defaultProvider: string;
  private outputDir: string;

  constructor(defaultProvider: string = 'placeholder', outputDir: string = './output/images') {
    this.defaultProvider = defaultProvider;
    this.outputDir = outputDir;

    // Register built-in providers
    this.providers.set('placeholder', new PlaceholderProvider());

    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  registerProvider(name: string, provider: ImageProvider): void {
    this.providers.set(name, provider);
  }

  setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new ConfigurationError(
        `Image provider not registered: ${name}`,
        'image.defaultProvider',
      );
    }
    this.defaultProvider = name;
  }

  async generate(
    prompt: string,
    options: ImageGenerationOptions = {},
  ): Promise<ImageGenerationResult> {
    const providerName = options.style ? this.defaultProvider : this.defaultProvider;
    const provider = this.providers.get(providerName);

    if (!provider) {
      throw new TemplateError(
        `Image provider not found: ${providerName}`,
        'PROVIDER_NOT_FOUND',
        providerName,
      );
    }

    // placeholder는 비용도 캐시 의미도 없으므로 게이트/캐시를 건너뛴다.
    const budgeted = providerName !== 'placeholder';

    // 캐시 조회(#8): 동일 프롬프트+동일 프로바이더/옵션 조합은 재생성하지 않는다.
    const cacheKey = budgeted ? this.cacheKey(providerName, prompt) : null;
    if (cacheKey) {
      const cachedPath = this.lookupCache(cacheKey);
      if (cachedPath) {
        logger.info(
          { provider: providerName, cacheKey },
          'Image cache hit; skipping provider call',
        );
        return { urls: [cachedPath], localPaths: [cachedPath], provider: providerName };
      }
    }

    // 예산 게이트(#8): 슬롯을 먼저 선점해 병렬 생성 시 한도 초과를 막는다(실패 시 반납).
    let ledger: ImageUsageLedger | null = null;
    let estCost: number | null = null;
    if (budgeted) {
      ledger = this.loadLedger();
      const exceeded = this.budgetExceeded(ledger);
      if (exceeded) {
        throw new TemplateError(
          `Image generation skipped: ${exceeded} — imageProviders.budget 설정을 확인하세요`,
          providerName,
          'IMAGE_BUDGET_EXCEEDED',
          429,
          false,
          { originalError: exceeded },
        );
      }
      const flavor = resolveGeminiImageConfig();
      estCost = estimateImageCostUsd(providerName, {
        model: flavor?.model,
        size: flavor?.size,
        quality: flavor?.quality,
      });
      ledger.count += 1;
      if (estCost !== null) ledger.estCostUsd += estCost;
      this.saveLedger(ledger);
    }

    logger.info({ provider: providerName, prompt: prompt.substring(0, 100) }, 'Generating image');

    try {
      const result = await provider.generate(prompt, options);

      // Download and save images locally if URLs provided
      if (result.urls.length > 0 && result.localPaths.length === 0) {
        result.localPaths = await this.downloadImages(result.urls, prompt);
      }

      // 성공: 캐시 저장 + 비용 로깅(#8)
      if (budgeted && cacheKey) {
        this.saveToCache(cacheKey, result.localPaths[0]);
        logger.info(
          { provider: providerName, cacheKey, estCostUsd: estCost, ledger: this.loadLedger() },
          `Image generated (estimated cost: ${estCost === null ? 'unknown' : `$${estCost.toFixed(3)}`})`,
        );
      }

      return result;
    } catch (error) {
      // 실패: 선점한 예산 슬롯 반납
      if (ledger) {
        ledger.count -= 1;
        if (estCost !== null) ledger.estCostUsd = Math.max(0, ledger.estCostUsd - estCost);
        this.saveLedger(ledger);
      }
      logger.error({ provider: providerName, error: String(error) }, 'Image generation failed');
      throw new TemplateError(
        `Image generation failed: ${String(error)}`,
        providerName,
        'GENERATION_FAILED',
        400,
        false,
        { originalError: String(error) },
        error instanceof Error ? error : undefined,
      );
    }
  }

  /* ---- 캐시/예산 헬퍼 (#8) ---- */

  /** 프롬프트+프로바이더+옵션(model/size/quality) 조합의 캐시 키 */
  private cacheKey(providerName: string, prompt: string): string {
    let flavor = 'default';
    try {
      const cfg = resolveGeminiImageConfig();
      if (cfg) flavor = `${cfg.model || ''}|${cfg.size || ''}|${cfg.quality || ''}`;
    } catch {
      // 설정 조회 실패 시 기본 플레이버 사용
    }
    return createHash('sha1').update(`${providerName}|${flavor}|${prompt}`).digest('hex');
  }

  private cacheDir(): string {
    return path.join(this.outputDir, 'cache');
  }

  private lookupCache(key: string): string | null {
    try {
      for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
        const p = path.join(this.cacheDir(), `${key}${ext}`);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      // 캐시 조회 실패는 치명적이지 않다
    }
    return null;
  }

  private saveToCache(key: string, localPath: string | undefined): void {
    if (!localPath || !fs.existsSync(localPath)) return;
    try {
      if (!fs.existsSync(this.cacheDir())) fs.mkdirSync(this.cacheDir(), { recursive: true });
      const ext = path.extname(localPath) || '.png';
      fs.copyFileSync(localPath, path.join(this.cacheDir(), `${key}${ext}`));
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to write image cache entry');
    }
  }

  private usageLedgerPath(): string {
    return path.join(this.outputDir, '.image-usage.json');
  }

  private loadLedger(): ImageUsageLedger {
    const today = todayKey();
    try {
      const raw = JSON.parse(fs.readFileSync(this.usageLedgerPath(), 'utf8')) as ImageUsageLedger;
      if (raw.date === today && typeof raw.count === 'number') {
        return { date: today, count: raw.count, estCostUsd: raw.estCostUsd || 0 };
      }
    } catch {
      // 파일이 없거나 손상됐으면 새 날짜로 시작
    }
    return { date: today, count: 0, estCostUsd: 0 };
  }

  private saveLedger(ledger: ImageUsageLedger): void {
    try {
      if (!fs.existsSync(this.outputDir)) fs.mkdirSync(this.outputDir, { recursive: true });
      fs.writeFileSync(this.usageLedgerPath(), JSON.stringify(ledger, null, 2));
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to write image usage ledger');
    }
  }

  /** 한도 초과 시 초과 사유를 반환, 여유 있으면 null */
  private budgetExceeded(ledger: ImageUsageLedger): string | null {
    const cfg = resolveImageBudgetConfig();
    if (cfg.dailyImageLimit > 0 && ledger.count >= cfg.dailyImageLimit) {
      return `daily image limit reached (${ledger.count}/${cfg.dailyImageLimit})`;
    }
    if (cfg.dailyCostLimitUsd > 0 && ledger.estCostUsd >= cfg.dailyCostLimitUsd) {
      return `daily cost limit reached ($${ledger.estCostUsd.toFixed(2)}/$${cfg.dailyCostLimitUsd})`;
    }
    return null;
  }

  private async downloadImages(urls: string[], prompt: string): Promise<string[]> {
    const localPaths: string[] = [];
    const timestamp = Date.now();
    const safePrompt = prompt.substring(0, 50).replace(/[^a-zA-Z0-9가-힣]/g, '_') || 'image';

    for (let i = 0; i < urls.length; i++) {
      try {
        const { bytes, ext } = await fetchImageBytes(urls[i]);
        if (bytes.length === 0) {
          throw new Error('Empty image body');
        }
        const filename = `${timestamp}_${safePrompt}_${i + 1}${ext}`;
        const localPath = path.join(this.outputDir, filename);
        fs.writeFileSync(localPath, bytes);
        localPaths.push(localPath);
      } catch (error) {
        logger.warn(
          { url: urls[i].slice(0, 80), error: String(error) },
          'Failed to download image',
        );
      }
    }

    return localPaths;
  }

  async validateAllProviders(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, provider] of this.providers) {
      try {
        results[name] = await provider.validateConfig();
      } catch {
        results[name] = false;
      }
    }

    return results;
  }

  getProviders(): string[] {
    return Array.from(this.providers.keys());
  }
}

export function createImageGenerator(
  defaultProvider?: string,
  outputDir?: string,
): ImageGeneratorImpl {
  return new ImageGeneratorImpl(defaultProvider, outputDir);
}

/** MIME → 파일 확장자 */
const IMAGE_MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;
const IMAGE_GENERATION_CONCURRENCY = 4;

/**
 * 이미지 URL을 바이트로 가져온다. data: URL(base64)은 네트워크 없이 디코드하고,
 * http(s)는 fetch로 내려받는다. 확장자는 data URL MIME → 응답 Content-Type → URL 경로 순으로 판별.
 */
async function fetchImageBytes(url: string): Promise<{ bytes: Buffer; ext: string }> {
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!match) {
      throw new Error('Malformed data URL');
    }
    const mime = match[1] || 'image/png';
    const bytes = match[2]
      ? Buffer.from(match[3], 'base64')
      : Buffer.from(decodeURIComponent(match[3]), 'utf-8');
    return { bytes, ext: IMAGE_MIME_EXTENSIONS[mime] || '.png' };
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  const pathExt = path.extname(new URL(url).pathname).toLowerCase();
  const ext =
    IMAGE_MIME_EXTENSIONS[contentType] ||
    (/^\.(png|jpe?g|webp|gif)$/.test(pathExt) ? pathExt : '.png');
  return { bytes, ext };
}

/**
 * 이미지 생성 게이팅 설정 — 우선순위: openai(gpt-image-1) → gemini → null(생성 불가).
 * 함수 이름은 기존 호출부(KeywordPostGenerator.ts, cli/index.ts, routes/index.ts)의
 * 게이팅 import를 유지하기 위해 resolveGeminiImageConfig로 고정돼 있으며,
 * openai가 설정되면 openai 설정을 provider 필드와 함께 반환한다.
 */
export function resolveGeminiImageConfig(): {
  provider: 'openai' | 'gemini';
  apiKey: string;
  model?: string;
  baseUrl?: string;
  size?: string;
  quality?: string;
} | null {
  try {
    // 1순위: openai (enabled !== false && apiKey)
    const openai =
      (getConfigManager().get('imageProviders.openai') as Record<string, unknown> | undefined) ||
      {};
    const openaiKey = typeof openai.apiKey === 'string' ? openai.apiKey.trim() : '';
    if (openai.enabled !== false && openaiKey) {
      return {
        provider: 'openai',
        apiKey: openaiKey,
        model:
          typeof openai.model === 'string' && openai.model.trim() ? openai.model.trim() : undefined,
        size:
          typeof openai.size === 'string' && openai.size.trim() ? openai.size.trim() : undefined,
        quality:
          typeof openai.quality === 'string' && openai.quality.trim()
            ? openai.quality.trim()
            : undefined,
      };
    }

    // 2순위: gemini (enabled !== false && apiKey)
    const cfg =
      (getConfigManager().get('imageProviders.gemini') as Record<string, unknown> | undefined) ||
      {};
    const apiKey = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
    // enabled가 명시적으로 false면 미사용 (config에 키만 있고 enabled가 없으면 사용)
    if (cfg.enabled === false || !apiKey) {
      return null;
    }
    const configuredModel = typeof cfg.model === 'string' ? cfg.model.trim() : '';
    // model 필드는 LLM 텍스트 생성과 공유되므로, 이미지 생성 불가 모델이 설정돼 있으면
    // 기본 이미지 모델로 대체한다.
    const model = GEMINI_IMAGE_MODEL_PATTERN.test(configuredModel) ? configuredModel : undefined;
    const baseUrl =
      typeof cfg.baseUrl === 'string' && cfg.baseUrl.trim() ? cfg.baseUrl.trim() : undefined;
    return { provider: 'gemini', apiKey, model, baseUrl };
  } catch (error) {
    logger.warn(
      { error: String(error) },
      'Failed to read image provider config; using placeholder',
    );
    return null;
  }
}

/**
 * 설정된 이미지 프로바이더 팩토리 — 게이팅 우선순위(openai → gemini → placeholder)에 따라
 * 프로바이더를 등록하고 기본값으로 지정한다. `createImageGenerator('placeholder', outputDir)`
 * 호출부(routes/index.ts, KeywordPostGenerator.ts, cli/index.ts)를 그대로 대체한다.
 *
 * 사용 예: const imageGenerator = resolveImageGenerator('./output/images');
 */
export function resolveImageGenerator(outputDir?: string): ImageGeneratorImpl {
  const generator = createImageGenerator('placeholder', outputDir);
  const cfg = resolveGeminiImageConfig();
  if (cfg?.provider === 'openai') {
    generator.registerProvider('openai', new OpenAIProvider(cfg));
    generator.setDefaultProvider('openai');
    logger.info(
      { model: cfg.model || DEFAULT_OPENAI_IMAGE_MODEL },
      'OpenAI image provider enabled (gpt-image-1)',
    );
  } else if (cfg?.provider === 'gemini') {
    generator.registerProvider('gemini', new GeminiProvider(cfg));
    generator.setDefaultProvider('gemini');
    logger.info(
      { model: cfg.model || DEFAULT_GEMINI_IMAGE_MODEL },
      'Gemini image provider enabled',
    );
  }
  return generator;
}

export interface ImagePromptSpec {
  /** 섹션 이미지인 경우 템플릿 슬롯 키 (sectionImages 주입 대상) */
  key?: string;
  prompt: string;
}

/**
 * 상품 스펙과 섹션 스펙을 교차 배치한다(#8). generateImagesSafely가
 * imageProviders.maxImagesPerPost로 앞부분을 자를 때 상품 컷만 남거나
 * 섹션 컷이 전부 잘리는 편중을 막기 위한 순서 재배치다.
 */
export function interleaveImageSpecs(
  productSpecs: ImagePromptSpec[],
  sectionSpecs: ImagePromptSpec[],
): ImagePromptSpec[] {
  const out: ImagePromptSpec[] = [];
  const total = Math.max(productSpecs.length, sectionSpecs.length);
  for (let i = 0; i < total; i++) {
    if (productSpecs[i]) out.push(productSpecs[i]);
    if (sectionSpecs[i]) out.push(sectionSpecs[i]);
  }
  return out;
}

/**
 * 프롬프트 목록을 동시 실행(상한 IMAGE_GENERATION_CONCURRENCY)으로 생성하고
 * 개별 실패는 경고 로그 후 건너뛴다.
 * 이미지 생성 실패는 글 발행을 막지 않는다(A3 폴백: images 없이 진행).
 * 반환 결과의 urls/localPaths는 요청 순서를 유지하고(KeywordPostGenerator가
 * localPaths[0]을 대표 이미지로 사용), sectionImages는 key가 붙은 스펙의
 * 대표 경로(없으면 URL) 매핑이다.
 */
export async function generateImagesSafely(
  generator: ImageGeneratorImpl,
  specs: ImagePromptSpec[],
): Promise<ImageGenerationResult> {
  // 포스트당 장수 상한(#8): imageProviders.maxImagesPerPost (기본 3)로 스펙을 제한한다.
  const limit = resolveMaxImagesPerPost();
  if (specs.length > limit) {
    logger.warn(
      { requested: specs.length, limit },
      'Image spec count exceeds imageProviders.maxImagesPerPost; truncating',
    );
    specs = specs.slice(0, limit);
  }
  const images: ImageGenerationResult = { urls: [], localPaths: [], sectionImages: {} };
  // 요청 순서 보존: 성공 슬롯만 채우고 실패/대기 슬롯은 null
  const slots: Array<{ key?: string; urls: string[]; localPaths: string[] } | null> = new Array(
    specs.length,
  ).fill(null);

  let cursor = 0;
  const workerCount = Math.max(1, Math.min(IMAGE_GENERATION_CONCURRENCY, specs.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= specs.length) return;
      const spec = specs[index];
      try {
        const result = await generator.generate(spec.prompt, { count: 1, aspectRatio: '16:9' });
        slots[index] = { key: spec.key, urls: result.urls, localPaths: result.localPaths };
      } catch (error) {
        logger.warn(
          { key: spec.key, prompt: spec.prompt.substring(0, 60), error: String(error) },
          'Image generation failed; continuing without image',
        );
      }
    }
  });
  await Promise.all(workers);

  const keyedPaths: string[] = [];
  for (const slot of slots) {
    if (!slot) continue;
    images.urls.push(...slot.urls);
    images.localPaths.push(...slot.localPaths);
    if (slot.key) {
      keyedPaths.push(slot.localPaths[0] || slot.urls[0] || '');
    }
  }

  images.sectionImages = buildSectionImageMap(keyedPaths);
  return images;
}
