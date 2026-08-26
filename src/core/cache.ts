import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from './logger';

const logger = getLogger('cache');

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

export interface CacheOptions {
  ttlSeconds?: number;
  maxSize?: number;
  cleanupIntervalSeconds?: number;
}

export class FileCache<T = unknown> {
  private cacheDir: string;
  private ttlSeconds: number;
  private maxSize: number;
  private memoryCache: Map<string, CacheEntry<T>> = new Map();
  private cleanupTimer?: NodeJS.Timeout;
  private hits = 0;
  private misses = 0;

  constructor(cacheDir: string, options: CacheOptions = {}) {
    this.cacheDir = cacheDir;
    this.ttlSeconds = options.ttlSeconds || 3600;
    this.maxSize = options.maxSize || 10000;

    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }

    this.loadFromDisk();
    this.startCleanup(options.cleanupIntervalSeconds || 300);
  }

  private loadFromDisk(): void {
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const filePath = path.join(this.cacheDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const entry = JSON.parse(content) as CacheEntry<T>;

        if (entry.expiresAt > Date.now()) {
          const key = file.slice(0, -5);
          this.memoryCache.set(key, entry);
        } else {
          fs.unlinkSync(filePath);
        }
      }
      logger.debug({ entries: this.memoryCache.size }, 'Cache loaded from disk');
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to load cache from disk');
    }
  }

  private startCleanup(intervalSeconds: number): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, intervalSeconds * 1000);

    this.cleanupTimer.unref();
  }

  private cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.expiresAt <= now) {
        this.memoryCache.delete(key);
        this.deleteFromDisk(key);
        cleaned++;
      }
    }

    if (this.memoryCache.size > this.maxSize) {
      const entries = Array.from(this.memoryCache.entries())
        .sort((a, b) => a[1].createdAt - b[1].createdAt);

      const toRemove = entries.slice(0, this.memoryCache.size - this.maxSize);
      for (const [key] of toRemove) {
        this.memoryCache.delete(key);
        this.deleteFromDisk(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug({ cleaned, remaining: this.memoryCache.size }, 'Cache cleanup completed');
    }
  }

  private getFilePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.cacheDir, `${safeKey}.json`);
  }

  private writeToDisk(key: string, entry: CacheEntry<T>): void {
    try {
      const filePath = this.getFilePath(key);
      fs.writeFileSync(filePath, JSON.stringify(entry), 'utf-8');
    } catch (error) {
      logger.warn({ key, error: String(error) }, 'Failed to write cache to disk');
    }
  }

  private deleteFromDisk(key: string): void {
    try {
      const filePath = this.getFilePath(key);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      logger.warn({ key, error: String(error) }, 'Failed to delete cache from disk');
    }
  }

  get(key: string): T | null {
    const entry = this.memoryCache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      this.deleteFromDisk(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds?: number): void {
    const now = Date.now();
    const ttl = ttlSeconds || this.ttlSeconds;

    const entry: CacheEntry<T> = {
      value,
      expiresAt: now + ttl * 1000,
      createdAt: now,
    };

    this.memoryCache.set(key, entry);
    this.writeToDisk(key, entry);
  }

  has(key: string): boolean {
    const entry = this.memoryCache.get(key);
    if (!entry) return false;
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      this.deleteFromDisk(key);
      return false;
    }
    return true;
  }

  delete(key: string): boolean {
    const deleted = this.memoryCache.delete(key);
    if (deleted) {
      this.deleteFromDisk(key);
    }
    return deleted;
  }

  clear(): void {
    this.memoryCache.clear();
    try {
      const files = fs.readdirSync(this.cacheDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(this.cacheDir, file));
        }
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to clear cache directory');
    }
  }

  getStats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.memoryCache.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  getKeys(): string[] {
    return Array.from(this.memoryCache.keys());
  }

  async close(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanup();
  }
}

const cacheInstances = new Map<string, FileCache<unknown>>();

export function getCache<T = unknown>(name: string, options?: CacheOptions): FileCache<T> {
  const cacheDir = path.join(process.cwd(), '.cache', name);

  if (!cacheInstances.has(name)) {
    cacheInstances.set(name, new FileCache<T>(cacheDir, options));
  }

  return cacheInstances.get(name) as FileCache<T>;
}

export function clearAllCaches(): void {
  for (const cache of cacheInstances.values()) {
    cache.clear();
  }
}

export async function closeAllCaches(): Promise<void> {
  for (const cache of cacheInstances.values()) {
    await cache.close();
  }
  cacheInstances.clear();
}