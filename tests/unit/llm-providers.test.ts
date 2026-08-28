import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.mock 팩토리는 호이스트되므로 스토어도 호이스트해 공유한다.
const configStore = vi.hoisted(() => ({
  // logger 초기화가 읽는 app.dataDir — 임시 디렉터리로 우회한다.
  'app.dataDir': '/tmp/blog-auto-poster-test',
})) as Record<string, Record<string, unknown>>;

// getConfigManager를 설정 파일 없이 스텁한다(createContentGeneratorFromConfig 검증용).
vi.mock('../../src/core/config', () => ({
  getConfigManager: () => ({
    get: (path: string, defaultValue?: string) => configStore[path] ?? defaultValue,
  }),
  resetConfigManager: () => {
    for (const key of Object.keys(configStore)) {
      if (key !== 'app.dataDir') delete configStore[key];
    }
  },
}));

import {
  LLM_PROVIDERS,
  ContentGenerator,
  createContentGeneratorFromConfig,
} from '../../src/content/ContentGenerator';

describe('LLM_PROVIDERS', () => {
  it('defines all 9 providers', () => {
    expect(Object.keys(LLM_PROVIDERS).sort()).toEqual(
      [
        'anthropic',
        'deepseek',
        'gemini',
        'groq',
        'mistral',
        'ollama',
        'openai',
        'openrouter',
        'xai',
      ].sort(),
    );
  });

  it('has non-empty distinct baseUrls (gemini may be empty)', () => {
    const baseUrls = Object.values(LLM_PROVIDERS)
      .map((p) => p.baseUrl)
      .filter(Boolean);
    for (const [name, p] of Object.entries(LLM_PROVIDERS)) {
      if (name === 'gemini') expect(p.baseUrl).toBe('');
      else expect(p.baseUrl).toMatch(/^https?:\/\//);
    }
    // 동적 값의 유일성 검사(런타임 배열)이므로 Set이 적절하다.
    expect(new Set(baseUrls).size).toBe(baseUrls.length);
  });

  it('has a non-empty defaultModel for every provider', () => {
    for (const p of Object.values(LLM_PROVIDERS)) {
      expect(p.defaultModel.length).toBeGreaterThan(0);
    }
  });
});

describe('ContentGenerator config resolution', () => {
  it('stores provider/model/baseUrl from config', () => {
    const gen = new ContentGenerator({
      provider: 'openrouter',
      apiKey: 'k',
      model: 'openai/gpt-4o-mini',
      baseUrl: 'https://custom.example.com/v1',
    });
    const priv = gen as unknown as Record<string, unknown>;
    expect(priv.provider).toBe('openrouter');
    expect(priv.model).toBe('openai/gpt-4o-mini');
    expect(priv.baseUrl).toBe('https://custom.example.com/v1');
  });

  it('omits baseUrl when empty so the provider default applies', () => {
    const gen = new ContentGenerator({ provider: 'deepseek', apiKey: 'k' });
    expect((gen as unknown as Record<string, unknown>).baseUrl).toBeUndefined();
  });
});

describe('createContentGeneratorFromConfig', () => {
  beforeEach(() => {
    for (const key of Object.keys(configStore)) {
      if (key !== 'app.dataDir') delete configStore[key];
    }
  });
  afterEach(() => {
    for (const key of Object.keys(configStore)) {
      if (key !== 'app.dataDir') delete configStore[key];
    }
  });

  it('resolves provider/model/baseUrl from the llm section', () => {
    configStore['llm'] = {
      provider: 'groq',
      apiKey: 'gsk_test',
      model: 'llama-3.3-70b-versatile',
      baseUrl: 'https://proxy.example.com/v1',
    };
    configStore['imageProviders.gemini'] = { apiKey: 'ignored' };
    const gen = createContentGeneratorFromConfig();
    const priv = gen as unknown as Record<string, unknown>;
    expect(priv.provider).toBe('groq');
    expect(priv.model).toBe('llama-3.3-70b-versatile');
    expect(priv.baseUrl).toBe('https://proxy.example.com/v1');
  });

  it('falls back to the provider default model when llm.model is absent', () => {
    configStore['llm'] = { provider: 'deepseek', apiKey: 'sk' };
    const gen = createContentGeneratorFromConfig();
    const priv = gen as unknown as Record<string, unknown>;
    expect(priv.model).toBe(LLM_PROVIDERS.deepseek.defaultModel);
  });

  it('falls back to imageProviders.gemini when no llm section exists', () => {
    configStore['imageProviders.gemini'] = {
      provider: 'gemini',
      apiKey: 'g-key',
      model: 'gemini-1.5-pro',
    };
    const gen = createContentGeneratorFromConfig();
    const priv = gen as unknown as Record<string, unknown>;
    expect(priv.provider).toBe('gemini');
    expect(priv.model).toBe('gemini-1.5-pro');
  });
});
