import { beforeEach, describe, expect, it } from 'vitest';
import { PlatformRegistry } from '../../src/platforms/registry';
import type { PlatformAdapter, PlatformCredentials, PlatformFeature } from '@core/interfaces';

/**
 * `ensureAdapters` — 재기동 직후 `/health`의 `services.platforms`가 `{}`로 나오던
 * 문제(설계 §0)의 근본 원인을 고정한다: `validateAll()`은 `this.instances`만 보는데,
 * `enabled: false`인 플랫폼은 기동 시 `initializeAll`이 건너뛰어 아무도 `getAdapter()`를
 * 부르기 전까지 인스턴스가 없다.
 */

class FakeAdapter implements PlatformAdapter {
  static instanceCount = 0;
  readonly name = 'fake';
  readonly supportedFeatures: PlatformFeature[] = [];

  constructor() {
    FakeAdapter.instanceCount += 1;
  }

  async initialize(): Promise<void> {}
  async createPost(): Promise<never> {
    throw new Error('not used in this test');
  }
  async updatePost(): Promise<never> {
    throw new Error('not used in this test');
  }
  async getCategories() {
    return [];
  }
  async uploadImage(): Promise<never> {
    throw new Error('not used in this test');
  }
  async validateCredentials(): Promise<boolean> {
    return true;
  }
}

function registryWithFakeAdapter(): PlatformRegistry {
  const registry = new PlatformRegistry();
  registry.register('fake', FakeAdapter);
  return registry;
}

beforeEach(() => {
  FakeAdapter.instanceCount = 0;
});

describe('PlatformRegistry.ensureAdapters', () => {
  it('validateAll()이 빈 값을 내던 미실현 어댑터를 인스턴스화해 보고 대상에 넣는다', async () => {
    const registry = registryWithFakeAdapter();

    // 아무도 getAdapter()/initialize()를 부르지 않은 상태 — 기존 버그의 재현.
    expect(await registry.validateAll()).toEqual({});

    registry.ensureAdapters(['fake']);
    expect(await registry.validateAll()).toEqual({ fake: true });
  });

  it('등록되지 않은 이름은 조용히 건너뛴다(설정에는 있지만 어댑터가 없는 플랫폼)', () => {
    const registry = registryWithFakeAdapter();
    expect(() => registry.ensureAdapters(['fake', 'does-not-exist'])).not.toThrow();
    expect(registry.hasAdapter('does-not-exist')).toBe(false);
  });

  it('이미 만들어진 어댑터는 재사용한다(중복 인스턴스화 없음)', () => {
    const registry = registryWithFakeAdapter();
    registry.ensureAdapters(['fake']);
    registry.ensureAdapters(['fake']);
    expect(FakeAdapter.instanceCount).toBe(1);
  });

  it('initialize()로 이미 인스턴스화된 어댑터도 그대로 재사용한다', async () => {
    const registry = registryWithFakeAdapter();
    await registry.initialize('fake', {} as PlatformCredentials);
    registry.ensureAdapters(['fake']);
    expect(FakeAdapter.instanceCount).toBe(1);
    expect(await registry.validateAll()).toEqual({ fake: true });
  });
});
