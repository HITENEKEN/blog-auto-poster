import { AffiliateAdapter, AffiliateConfig } from '@core/interfaces';
import { CoupangAdapter } from './coupang/CoupangAdapter';
import { ConfigurationError } from '@core/errors';
import { getLogger } from '@core/logger';

const logger = getLogger('affiliate-registry');

type AffiliateAdapterConstructor = new () => AffiliateAdapter;

const adapterRegistry = new Map<string, AffiliateAdapterConstructor>();

adapterRegistry.set('coupang', CoupangAdapter);

export class AffiliateRegistry {
  private instances = new Map<string, AffiliateAdapter>();
  private configs = new Map<string, AffiliateConfig>();

  register(name: string, adapterClass: AffiliateAdapterConstructor): void {
    if (adapterRegistry.has(name)) {
      logger.warn({ name }, 'Overriding existing affiliate adapter');
    }
    adapterRegistry.set(name, adapterClass);
    logger.info({ name }, 'Affiliate adapter registered');
  }

  unregister(name: string): void {
    adapterRegistry.delete(name);
    this.instances.delete(name);
    this.configs.delete(name);
    logger.info({ name }, 'Affiliate adapter unregistered');
  }

  getAdapter(name: string): AffiliateAdapter {
    const existing = this.instances.get(name);
    if (existing) {
      return existing;
    }

    const AdapterClass = adapterRegistry.get(name);
    if (!AdapterClass) {
      throw new ConfigurationError(
        `Affiliate adapter not found: ${name}`,
        `affiliates.${name}`,
        'ADAPTER_NOT_FOUND',
      );
    }

    const adapter = new AdapterClass();
    this.instances.set(name, adapter);
    logger.debug({ name }, 'Affiliate adapter instance created');
    return adapter;
  }

  async initialize(name: string, config: AffiliateConfig): Promise<AffiliateAdapter> {
    const adapter = this.getAdapter(name);
    await adapter.initialize(config);
    this.configs.set(name, config);
    logger.info({ name }, 'Affiliate adapter initialized');
    return adapter;
  }

  async initializeAll(
    configs: Record<string, AffiliateConfig>,
  ): Promise<Map<string, AffiliateAdapter>> {
    const results = new Map<string, AffiliateAdapter>();

    for (const [name, config] of Object.entries(configs)) {
      try {
        const adapter = await this.initialize(name, config);
        results.set(name, adapter);
      } catch (error) {
        logger.error({ name, error: String(error) }, 'Failed to initialize affiliate adapter');
        throw error;
      }
    }

    return results;
  }

  getConfig(name: string): AffiliateConfig | undefined {
    return this.configs.get(name);
  }

  getInitializedAdapters(): Map<string, AffiliateAdapter> {
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
      } catch (error) {
        logger.error({ name, error: String(error) }, 'Credential validation failed');
        results[name] = false;
      }
    }

    return results;
  }

  clear(): void {
    this.instances.clear();
    this.configs.clear();
    logger.debug('Affiliate registry cleared');
  }
}

let registryInstance: AffiliateRegistry | null = null;

export function getAffiliateRegistry(): AffiliateRegistry {
  if (!registryInstance) {
    registryInstance = new AffiliateRegistry();
  }
  return registryInstance;
}

export function resetAffiliateRegistry(): void {
  if (registryInstance) {
    registryInstance.clear();
  }
  registryInstance = null;
}

export { CoupangAdapter } from './coupang/CoupangAdapter';
