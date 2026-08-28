import { getLogger } from '@core/logger';
import { ImageGenerator, ImageGenerationOptions, ImageGenerationResult } from '@core/interfaces';
import { TemplateError, ConfigurationError } from '@core/errors';
import * as fs from 'fs';
import * as path from 'path';

const logger = getLogger('image-generator');

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

export class GeminiProvider implements ImageProvider {
  readonly name = 'gemini';

  private apiKey: string;
  private model: string;

  constructor(config: { apiKey: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-1.5-pro';
  }

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    logger.warn('Gemini provider not fully implemented, returning placeholder');
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
      const placeholderUrl = `https://via.placeholder.com/${options.aspectRatio === '9:16' ? '1080x1920' : '1024x1024'}/999999/444444?text=${encodeURIComponent(prompt.substring(0, 50))}`;
      urls.push(placeholderUrl);
    }

    return { urls, localPaths, provider: this.name };
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

    logger.info({ provider: providerName, prompt: prompt.substring(0, 100) }, 'Generating image');

    try {
      const result = await provider.generate(prompt, options);

      // Download and save images locally if URLs provided
      if (result.urls.length > 0 && result.localPaths.length === 0) {
        result.localPaths = await this.downloadImages(result.urls, prompt);
      }

      return result;
    } catch (error) {
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

  private async downloadImages(urls: string[], prompt: string): Promise<string[]> {
    const localPaths: string[] = [];
    const timestamp = Date.now();
    const safePrompt = prompt.substring(0, 50).replace(/[^a-zA-Z0-9가-힣]/g, '_');

    for (let i = 0; i < urls.length; i++) {
      try {
        const ext = '.webp';
        const filename = `${timestamp}_${safePrompt}_${i + 1}${ext}`;
        const localPath = path.join(this.outputDir, filename);

        // In a real implementation, download the image here
        // For now, just create a placeholder file
        fs.writeFileSync(localPath, `Placeholder for ${urls[i]}`);
        localPaths.push(localPath);
      } catch (error) {
        logger.warn({ url: urls[i], error: String(error) }, 'Failed to download image');
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
