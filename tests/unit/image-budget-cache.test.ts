import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// vi.mock 팩토리는 호이스트되므로 스토어도 호이스트해 공유한다.
const configStore = vi.hoisted(() => ({
  'app.dataDir': '/tmp/blog-auto-poster-test',
})) as Record<string, Record<string, unknown>>;

vi.mock('../../src/core/config', () => ({
  getConfigManager: () => ({
    get: (path: string, defaultValue?: string) => configStore[path] ?? defaultValue,
  }),
}));

import {
  estimateImageCostUsd,
  interleaveImageSpecs,
  resolveImageBudgetConfig,
  resolveMaxImagesPerPost,
} from '../../src/content/ImageGenerator';

const B64_PNG = Buffer.from('fake-png-bytes').toString('base64');

function stubFetch(ok = true, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok,
        status,
        json: async () => ({ data: [{ b64_json: B64_PNG }] }),
        text: async () => JSON.stringify({ data: [{ b64_json: B64_PNG }] }),
      };
    }),
  );
  return calls;
}

beforeEach(() => {
  for (const key of Object.keys(configStore)) {
    if (key !== 'app.dataDir') delete configStore[key];
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('estimateImageCostUsd — 단가 테이블', () => {
  it('openai 1024x1024 low는 $0.011이다', () => {
    expect(estimateImageCostUsd('openai', { size: '1024x1024', quality: 'low' })).toBe(0.011);
  });

  it('openai 1024x1024 high는 $0.17이다 (기존 기본값이 비용 사건의 원인)', () => {
    expect(estimateImageCostUsd('openai', { size: '1024x1024', quality: 'high' })).toBe(0.17);
  });

  it('큰 사이즈는 단가가 다르다', () => {
    expect(estimateImageCostUsd('openai', { size: '1536x1024', quality: 'high' })).toBe(0.25);
  });

  it('gemini는 근사 평단가를 반환한다', () => {
    expect(estimateImageCostUsd('gemini')).toBeGreaterThan(0);
  });

  it('알 수 없는 조합은 null을 반환한다', () => {
    expect(estimateImageCostUsd('openai', { size: '999x999', quality: 'low' })).toBeNull();
  });
});

describe('설정 해석', () => {
  it('budget 설정이 없으면 기본값(하루 20장, 비용 한도 미사용)을 쓴다', () => {
    expect(resolveImageBudgetConfig()).toEqual({ dailyImageLimit: 20, dailyCostLimitUsd: 0 });
  });

  it('budget 설정을 반영한다', () => {
    configStore['imageProviders.budget'] = { dailyImageLimit: 5, dailyCostLimitUsd: 1 };
    expect(resolveImageBudgetConfig()).toEqual({ dailyImageLimit: 5, dailyCostLimitUsd: 1 });
  });

  it('maxImagesPerPost 기본값은 3이고 설정으로 바꿀 수 있다', () => {
    expect(resolveMaxImagesPerPost()).toBe(3);
    configStore['imageProviders.maxImagesPerPost'] = 5;
    expect(resolveMaxImagesPerPost()).toBe(5);
  });
});

describe('interleaveImageSpecs — 상품/섹션 교차 배치', () => {
  it('상품과 섹션 스펙을 1:1로 교차 배치한다', () => {
    const products = [{ prompt: 'p1' }, { prompt: 'p2' }, { prompt: 'p3' }];
    const sections = [
      { key: 'usage', prompt: 's1' },
      { key: 'specs', prompt: 's2' },
    ];
    expect(interleaveImageSpecs(products, sections)).toEqual([
      { prompt: 'p1' },
      { key: 'usage', prompt: 's1' },
      { prompt: 'p2' },
      { key: 'specs', prompt: 's2' },
      { prompt: 'p3' },
    ]);
  });
});

describe('이미지 캐시 — 동일 프롬프트 재생성 방지', () => {
  it('같은 프롬프트로 두 번 generate하면 두 번째는 캐시를 재사용한다', async () => {
    const calls = stubFetch();
    const { resolveImageGenerator } = await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imgcache-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    const generator = resolveImageGenerator(outputDir);

    const first = await generator.generate('동일한 프롬프트', { count: 1 });
    const second = await generator.generate('동일한 프롬프트', { count: 1 });

    // 프로바이더 API 호출은 1회만 발생해야 한다
    expect(calls).toHaveLength(1);
    expect(first.localPaths).toHaveLength(1);
    expect(second.localPaths).toHaveLength(1);
    // 두 번째 결과는 캐시 디렉터리의 파일을 가리킨다
    expect(second.localPaths[0]).toContain('/cache/');
    expect(existsSync(second.localPaths[0])).toBe(true);
    expect(readFileSync(second.localPaths[0])).toEqual(readFileSync(first.localPaths[0]));
  });

  it('다른 프롬프트는 캐시를 재사용하지 않는다', async () => {
    const calls = stubFetch();
    const { resolveImageGenerator } = await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imgcache2-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    const generator = resolveImageGenerator(outputDir);

    await generator.generate('프롬프트 A', { count: 1 });
    await generator.generate('프롬프트 B', { count: 1 });

    expect(calls).toHaveLength(2);
  });
});

describe('예산 게이트 — 일일 한도 초과 시 생성 스킵', () => {
  it('dailyImageLimit 초과 시 IMAGE_BUDGET_EXCEEDED를 던진다', async () => {
    stubFetch();
    const { resolveImageGenerator } = await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imgbudget-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    configStore['imageProviders.budget'] = { dailyImageLimit: 1 };
    const generator = resolveImageGenerator(outputDir);

    await expect(generator.generate('첫 번째', { count: 1 })).resolves.toBeTruthy();
    await expect(generator.generate('두 번째', { count: 1 })).rejects.toThrow(
      /IMAGE_BUDGET_EXCEEDED|daily image limit/,
    );

    // 성공한 첫 번째 이미지는 캐시에 저장돼 있으므로 캐시 히트로 다시 얻을 수 있다
    await expect(generator.generate('첫 번째', { count: 1 })).resolves.toBeTruthy();
  });

  it('생성 실패 시 선점한 예산 슬롯을 반납한다', async () => {
    stubFetch(false, 401);
    const { resolveImageGenerator } = await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imgbudget2-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    configStore['imageProviders.budget'] = { dailyImageLimit: 1 };
    const generator = resolveImageGenerator(outputDir);

    await expect(generator.generate('실패할 프롬프트', { count: 1 })).rejects.toThrow();

    // 반납됐으므로 대장은 0장이고 다음 생성은 허용된다
    const ledger = JSON.parse(readFileSync(join(outputDir, '.image-usage.json'), 'utf8'));
    expect(ledger.count).toBe(0);
    await expect(generator.generate('다음 프롬프트', { count: 1 })).rejects.toThrow(); // 여전히 401이지만 한도로 막히지 않음
  });
});

describe('generateImagesSafely — 포스트당 장수 상한', () => {
  it('maxImagesPerPost를 초과한 스펙은 절단된다', async () => {
    const calls = stubFetch();
    const { resolveImageGenerator, generateImagesSafely } =
      await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imglimit-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    configStore['imageProviders.maxImagesPerPost'] = 2;
    const generator = resolveImageGenerator(outputDir);

    const specs = [
      { prompt: 'a' },
      { prompt: 'b' },
      { key: 'usage', prompt: 'c' },
      { key: 'specs', prompt: 'd' },
    ];
    const result = await generateImagesSafely(generator, specs);

    expect(calls).toHaveLength(2);
    expect(result.urls).toHaveLength(2);
    expect(result.localPaths).toHaveLength(2);
    // 앞 2개 스펙(a, b)만 생성됐으므로 sectionImages는 비어 있다
    expect(result.sectionImages).toEqual({});
  });

  it('상한 이내면 모든 스펙이 생성된다', async () => {
    const calls = stubFetch();
    const { resolveImageGenerator, generateImagesSafely } =
      await import('../../src/content/ImageGenerator');
    const outputDir = mkdtempSync(join(tmpdir(), 'imglimit2-'));
    configStore['imageProviders.openai'] = { apiKey: 'o-key' };
    configStore['imageProviders.maxImagesPerPost'] = 4;
    const generator = resolveImageGenerator(outputDir);

    const result = await generateImagesSafely(generator, [
      { prompt: 'a' },
      { key: 'usage', prompt: 'b' },
      { prompt: 'c' },
      { key: 'specs', prompt: 'd' },
    ]);

    expect(calls).toHaveLength(4);
    expect(result.localPaths).toHaveLength(4);
    expect(Object.keys(result.sectionImages)).toEqual(['usage', 'specs']);
  });
});
