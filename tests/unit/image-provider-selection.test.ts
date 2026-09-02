import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.mock 팩토리는 호이스트되므로 스토어도 호이스트해 공유한다.
const configStore = vi.hoisted(() => ({
  // logger 초기화가 읽는 app.dataDir — 임시 디렉터리로 우회한다.
  'app.dataDir': '/tmp/blog-auto-poster-test',
})) as Record<string, Record<string, unknown>>;

// getConfigManager를 설정 파일 없이 스텁한다(게이팅 우선순위 검증용).
vi.mock('../../src/core/config', () => ({
  getConfigManager: () => ({
    get: (path: string, defaultValue?: string) => configStore[path] ?? defaultValue,
  }),
}));

// ImageGeneratorImpl에 defaultProvider 게터가 없어 테스트에서만 private 필드를 읽는다.
const readDefaultProvider = (generator: object): string => {
  if ('defaultProvider' in generator) {
    return String(generator.defaultProvider);
  }
  throw new Error('defaultProvider field missing on generator');
};

import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  OpenAIProvider,
  buildOpenAIImageRequestBody,
  resolveGeminiImageConfig,
  resolveImageGenerator,
} from '../../src/content/ImageGenerator';

beforeEach(() => {
  for (const key of Object.keys(configStore)) {
    if (key !== 'app.dataDir') delete configStore[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveGeminiImageConfig — 프로바이더 게이팅 우선순위', () => {
  it('openai(enabled+apiKey)만 있으면 openai를 반환한다', () => {
    configStore['imageProviders.openai'] = { enabled: true, apiKey: 'o-key' };
    expect(resolveGeminiImageConfig()).toEqual({
      provider: 'openai',
      apiKey: 'o-key',
      model: undefined,
      size: undefined,
      quality: undefined,
    });
  });

  it('openai와 gemini가 모두 설정돼 있으면 openai가 우선한다', () => {
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    configStore['imageProviders.gemini'] = { enabled: true, apiKey: 'g-key' };
    const cfg = resolveGeminiImageConfig();
    expect(cfg?.provider).toBe('openai');
    expect(cfg?.apiKey).toBe('o-key');
  });

  it('openai 키가 없고 gemini(enabled+apiKey)만 있으면 gemini를 반환한다', () => {
    configStore['imageProviders.gemini'] = { enabled: true, apiKey: 'g-key' };
    const cfg = resolveGeminiImageConfig();
    expect(cfg?.provider).toBe('gemini');
    expect(cfg?.apiKey).toBe('g-key');
  });

  it('openai가 enabled:false면 gemini로 폴백한다', () => {
    configStore['imageProviders.openai'] = { enabled: false, apiKey: 'o-key' };
    configStore['imageProviders.gemini'] = { enabled: true, apiKey: 'g-key' };
    expect(resolveGeminiImageConfig()?.provider).toBe('gemini');
  });

  it('둘 다 유효하지 않으면 null을 반환한다', () => {
    configStore['imageProviders.openai'] = { enabled: false };
    configStore['imageProviders.gemini'] = { enabled: false };
    expect(resolveGeminiImageConfig()).toBeNull();
  });

  it('openai apiKey는 trim되고, size/quality 지정 시 그대로 전달된다', () => {
    configStore['imageProviders.openai'] = {
      apiKey: '  o-key\n',
      size: '1536x1024',
      quality: 'medium',
    };
    const cfg = resolveGeminiImageConfig();
    expect(cfg).toEqual({
      provider: 'openai',
      apiKey: 'o-key',
      model: undefined,
      size: '1536x1024',
      quality: 'medium',
    });
  });
});

describe('buildOpenAIImageRequestBody — 요청 바디 빌더', () => {
  it('모델/size/quality 미지정 시 기본값(gpt-image-1, 1024x1024, low)을 쓴다 — 비용 통제 #8', () => {
    expect(buildOpenAIImageRequestBody('프롬프트', {})).toEqual({
      model: 'gpt-image-1',
      prompt: '프롬프트',
      n: 1,
      size: '1024x1024',
      quality: 'low',
    });
  });

  it('지정된 모델/size/quality를 반영하고 response_format은 포함하지 않는다', () => {
    const body = buildOpenAIImageRequestBody('p', {
      model: 'gpt-image-1',
      size: '1024x1536',
      quality: 'low',
    });
    expect(body).toEqual({
      model: 'gpt-image-1',
      prompt: 'p',
      n: 1,
      size: '1024x1536',
      quality: 'low',
    });
    expect(body).not.toHaveProperty('response_format');
  });

  it('DEFAULT_OPENAI_IMAGE_MODEL은 gpt-image-1이다', () => {
    expect(DEFAULT_OPENAI_IMAGE_MODEL).toBe('gpt-image-1');
  });
});

describe('OpenAIProvider — b64_json 응답 처리 (mock fetch)', () => {
  const B64_PNG = Buffer.from('fake-png-bytes').toString('base64');

  function stubFetch(payload: unknown, ok = true, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return {
          ok,
          status,
          json: async () => payload,
          text: async () => JSON.stringify(payload),
        };
      }),
    );
    return calls;
  }

  it('data[0].b64_json을 data URL로 반환하고 Authorization Bearer 헤더를 보낸다', async () => {
    const calls = stubFetch({ data: [{ b64_json: B64_PNG }] });
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    const result = await provider.generate('상품 이미지', { count: 1 });

    expect(result.provider).toBe('openai');
    expect(result.urls).toEqual([`data:image/png;base64,${B64_PNG}`]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.openai.com/v1/images/generations');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body).toEqual({
      model: 'gpt-image-1',
      prompt: '상품 이미지',
      n: 1,
      size: '1024x1024',
      quality: 'low',
    });
  });

  it('HTTP 에러는 GeminiProvider와 동일하게 상태코드+본문 일부를 담아 던진다', async () => {
    stubFetch({ error: { message: 'Incorrect API key' } }, false, 401);
    const provider = new OpenAIProvider({ apiKey: 'bad' });

    // GeminiProvider와 동일하게 응답 본문(원문 JSON)을 상태코드와 함께 그대로 노출한다.
    await expect(provider.generate('p', { count: 1 })).rejects.toThrow(
      /OpenAI image API 401: \{"error":\{"message":"Incorrect API key"\}\}/,
    );
  });

  it('b64_json이 없으면 에러를 던진다', async () => {
    stubFetch({ data: [{}] });
    const provider = new OpenAIProvider({ apiKey: 'sk-test' });

    await expect(provider.generate('p', { count: 1 })).rejects.toThrow(/no b64_json/);
  });
});

describe('resolveImageGenerator — 팩토리 선택', () => {
  it('openai 설정 시 openai 프로바이더를 기본값으로 등록한다', () => {
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    const generator = resolveImageGenerator(mkdtempSync(join(tmpdir(), 'imgsel-')));
    expect(generator.getProviders()).toContain('openai');
    expect(readDefaultProvider(generator)).toBe('openai');
  });

  it('openai가 없고 gemini가 있으면 gemini를 기본값으로 등록한다', () => {
    configStore['imageProviders.gemini'] = { enabled: true, apiKey: 'g-key' };
    const generator = resolveImageGenerator(mkdtempSync(join(tmpdir(), 'imgsel-')));
    expect(readDefaultProvider(generator)).toBe('gemini');
  });

  it('설정이 없으면 placeholder로 머무른다', () => {
    const generator = resolveImageGenerator(mkdtempSync(join(tmpdir(), 'imgsel-')));
    expect(readDefaultProvider(generator)).toBe('placeholder');
  });

  it('생성된 data URL은 기존 downloadImages 경로에서 디코드되어 파일로 저장된다 (mock fetch)', async () => {
    const bytes = Buffer.from('decoded-image-bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: bytes.toString('base64') }] }),
      })),
    );
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    const outputDir = mkdtempSync(join(tmpdir(), 'imgdl-'));
    const generator = resolveImageGenerator(outputDir);

    const result = await generator.generate('테스트 프롬프트', { count: 1 });

    expect(result.localPaths).toHaveLength(1);
    expect(readFileSync(result.localPaths[0])).toEqual(bytes);
  });
});
