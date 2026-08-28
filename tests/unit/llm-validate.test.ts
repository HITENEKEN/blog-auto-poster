import { describe, expect, it } from 'vitest';
import { LLM_PROVIDERS, resolveLlmValidateConfig } from '../../src/content/ContentGenerator';

// 순수 함수만 검증한다: 저장된 설정(saved) 위에 연결 테스트 본문(override)을 덧씌우는 규칙.
const saved = {
  provider: 'deepseek',
  apiKey: '  sk-saved  ',
  model: 'deepseek-chat',
  baseUrl: '',
};

describe('resolveLlmValidateConfig — apiKey', () => {
  it('uses the override key (trimmed) when provided', () => {
    const cfg = resolveLlmValidateConfig(saved, {
      provider: 'deepseek',
      apiKey: '  sk-unsaved  ',
      model: 'deepseek-chat',
      baseUrl: '',
    });
    expect(cfg.apiKey).toBe('sk-unsaved');
  });

  it("uses the saved key when the override is the '***' sentinel", () => {
    const cfg = resolveLlmValidateConfig(saved, { apiKey: '***' });
    expect(cfg.apiKey).toBe('sk-saved');
  });

  it('uses the saved key when the override apiKey is absent, empty, or whitespace', () => {
    expect(resolveLlmValidateConfig(saved, {}).apiKey).toBe('sk-saved');
    expect(resolveLlmValidateConfig(saved, { apiKey: undefined }).apiKey).toBe('sk-saved');
    expect(resolveLlmValidateConfig(saved, { apiKey: '' }).apiKey).toBe('sk-saved');
    expect(resolveLlmValidateConfig(saved, { apiKey: '   ' }).apiKey).toBe('sk-saved');
  });

  it('trims a whitespace-polluted saved key', () => {
    const cfg = resolveLlmValidateConfig(saved, {});
    expect(cfg.apiKey).toBe('sk-saved');
  });

  it('trims the override key that equals the saved key', () => {
    const cfg = resolveLlmValidateConfig(saved, { apiKey: '***' });
    expect(cfg.apiKey).not.toContain(' ');
  });

  it('returns an empty key when neither override nor saved key exists', () => {
    const cfg = resolveLlmValidateConfig(
      { provider: 'deepseek', apiKey: '   ', model: 'deepseek-chat' },
      { apiKey: undefined },
    );
    expect(cfg.apiKey).toBe('');
  });
});

describe('resolveLlmValidateConfig — provider/model/baseUrl', () => {
  it('keeps saved values when the override omits them', () => {
    const cfg = resolveLlmValidateConfig(saved, { apiKey: 'sk-x' });
    expect(cfg.provider).toBe('deepseek');
    expect(cfg.model).toBe('deepseek-chat');
    expect(cfg.baseUrl).toBe('');
  });

  it('applies provider/model/baseUrl overrides (trimmed)', () => {
    const cfg = resolveLlmValidateConfig(saved, {
      provider: '  openai  ',
      apiKey: 'sk-x',
      model: '  gpt-4o-mini  ',
      baseUrl: '  https://example.invalid/v1  ',
    });
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-4o-mini');
    expect(cfg.baseUrl).toBe('https://example.invalid/v1');
  });

  it('falls back to empty baseUrl when both are blank', () => {
    const cfg = resolveLlmValidateConfig({ ...saved, baseUrl: '' }, { baseUrl: '   ' });
    expect(cfg.baseUrl).toBe('');
  });

  it('falls back to the provider default model when neither override nor saved model exists', () => {
    const cfg = resolveLlmValidateConfig({ provider: 'deepseek', apiKey: 'sk-x' }, {});
    expect(cfg.model).toBe(LLM_PROVIDERS.deepseek.defaultModel);
  });

  it('handles an undefined override like an empty one', () => {
    const cfg = resolveLlmValidateConfig(saved, undefined);
    expect(cfg).toEqual({
      provider: 'deepseek',
      apiKey: 'sk-saved',
      model: 'deepseek-chat',
      baseUrl: '',
    });
  });
});
