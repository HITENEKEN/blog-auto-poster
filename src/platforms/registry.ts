import { PlatformAdapter, PlatformCredentials } from '@core/interfaces';
import { TistoryAdapter } from './tistory/TistoryAdapter';
import { WordPressAdapter } from './wordpress/WordPressAdapter';
import { YouTubeShortsAdapter } from './youtube-shorts/YouTubeShortsAdapter';
import { ConfigurationError } from '@core/errors';
import { getLogger } from '@core/logger';

const logger = getLogger('platform-registry');

type PlatformAdapterConstructor = new () => PlatformAdapter;

const adapterRegistry = new Map<string, PlatformAdapterConstructor>();

adapterRegistry.set('tistory', TistoryAdapter);
adapterRegistry.set('wordpress', WordPressAdapter);
adapterRegistry.set('youtube-shorts', YouTubeShortsAdapter);

export class PlatformRegistry {
  private instances = new Map<string, PlatformAdapter>();
  private configs = new Map<string, PlatformCredentials>();

  register(name: string, adapterClass: PlatformAdapterConstructor): void {
    if (adapterRegistry.has(name)) {
      logger.warn({ name }, 'Overriding existing platform adapter');
    }
    adapterRegistry.set(name, adapterClass);
  }

  unregister(name: string): void {
    adapterRegistry.delete(name);
    this.instances.delete(name);
    this.configs.delete(name);
  }

  getAdapter(name: string): PlatformAdapter {
    const instance = this.instances.get(name);
    if (instance) {
      return instance;
    }

    const AdapterClass = adapterRegistry.get(name);
    if (!AdapterClass) {
      throw new ConfigurationError(`Platform adapter not found: ${name}`, 'platform');
    }

    const adapter = new AdapterClass();
    this.instances.set(name, adapter);
    return adapter;
  }

  async initialize(name: string, config: PlatformCredentials): Promise<PlatformAdapter> {
    const adapter = this.getAdapter(name);
    await adapter.initialize(config);
    this.configs.set(name, config);
    return adapter;
  }

  async initializeAll(configs: Record<string, PlatformCredentials>): Promise<Map<string, PlatformAdapter>> {
    const results = new Map<string, PlatformAdapter>();

    for (const [name, config] of Object.entries(configs)) {
      try {
        const adapter = await this.initialize(name, config);
        results.set(name, adapter);
      } catch (error) {
        logger.error({ name, error: String(error) }, 'Failed to initialize platform adapter');
        throw error;
      }
    }

    return results;
  }

  getConfig(name: string): PlatformCredentials | undefined {
    return this.configs.get(name);
  }

  getInitializedAdapters(): Map<string, PlatformAdapter> {
    return new Map(this.instances);
  }

  getAvailableAdapters(): string[] {
    return Array.from(adapterRegistry.keys());
  }

  hasAdapter(name: string): boolean {
    return adapterRegistry.has(name);
  }

  async validateAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [name, adapter] of this.instances) {
      try {
        results[name] = await adapter.validateCredentials();
      } catch {
        results[name] = false;
      }
    }

    return results;
  }

  clear(): void {
    this.instances.clear();
    this.configs.clear();
  }
}

let registryInstance: PlatformRegistry | null = null;

export function getPlatformRegistry(): PlatformRegistry {
  if (!registryInstance) {
    registryInstance = new PlatformRegistry();
  }
  return registryInstance;
}

export function resetPlatformRegistry(): void {
  if (registryInstance) {
    registryInstance.clear();
    registryInstance = null;
  }
}

export { TistoryAdapter } from './tistory/TistoryAdapter';
export { WordPressAdapter } from './wordpress/WordPressAdapter';
export { YouTubeShortsAdapter } from './youtube-shorts/YouTubeShortsAdapter';