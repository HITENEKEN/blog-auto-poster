import { describe, expect, it } from 'vitest';

import { buildModelsRequest, parseModelsResponse } from '../../src/content/LlmModels';

describe('buildModelsRequest', () => {
  it('builds a gemini request with the key as a query param and no auth header', () => {
    const req = buildModelsRequest('gemini', 'g-key-123');
    expect(req).not.toBeNull();
    expect(req!.url).toContain('https://generativelanguage.googleapis.com/v1beta/models');
    expect(req!.url).toContain('key=g-key-123');
    expect(req!.url).toContain('pageSize=200');
    expect(req!.headers).toEqual({});
  });

  it('encodes special characters in the gemini key param', () => {
    const req = buildModelsRequest('gemini', 'a&b=c d');
    expect(req!.url).toContain('key=a%26b%3Dc%20d');
  });

  it('builds an anthropic request with x-api-key and anthropic-version headers', () => {
    const req = buildModelsRequest('anthropic', 'sk-ant-1');
    expect(req).not.toBeNull();
    expect(req!.url).toBe('https://api.anthropic.com/v1/models?limit=100');
    expect(req!.headers).toEqual({
      'x-api-key': 'sk-ant-1',
      'anthropic-version': '2023-06-01',
    });
  });

  it('builds an OpenAI-compatible Bearer request against the provider baseUrl', () => {
    const req = buildModelsRequest('openrouter', 'or-key');
    expect(req).not.toBeNull();
    expect(req!.url).toBe('https://openrouter.ai/api/v1/models');
    expect(req!.headers).toEqual({ Authorization: 'Bearer or-key' });
  });

  it('returns null for an unknown provider', () => {
    expect(buildModelsRequest('unknown', 'k')).toBeNull();
  });

  it('returns null when the apiKey is empty', () => {
    expect(buildModelsRequest('openai', '')).toBeNull();
  });
});

describe('parseModelsResponse', () => {
  it('strips the models/ prefix from gemini model names', () => {
    const body = {
      models: [
        { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
      ],
    };
    expect(parseModelsResponse('gemini', body)).toEqual(['gemini-1.5-pro', 'gemini-1.5-flash']);
  });

  it('filters gemini models without generateContent support when the field exists', () => {
    const body = {
      models: [
        { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/no-methods' },
      ],
    };
    expect(parseModelsResponse('gemini', body)).toEqual(['gemini-1.5-pro', 'no-methods']);
  });

  it('reads data[].id for OpenAI-compatible providers', () => {
    const body = { data: [{ id: 'openai/gpt-4o-mini' }, { id: 'anthropic/claude-3.5-sonnet' }] };
    expect(parseModelsResponse('openrouter', body)).toEqual([
      'openai/gpt-4o-mini',
      'anthropic/claude-3.5-sonnet',
    ]);
  });
  it('accepts string entries and object entries with an id, filtering the rest', () => {
    const body = { data: ['m1', 42, null, { id: 'x' }, { nope: 1 }, 'm2'] };
    expect(parseModelsResponse('openai', body)).toEqual(['m1', 'x', 'm2']);
  });

  it('returns [] for garbage input', () => {
    expect(parseModelsResponse('gemini', null)).toEqual([]);
    expect(parseModelsResponse('gemini', 'nope')).toEqual([]);
    expect(parseModelsResponse('gemini', {})).toEqual([]);
    expect(parseModelsResponse('openai', { models: ['a'] })).toEqual([]);
    expect(parseModelsResponse('gemini', { data: ['a'] })).toEqual([]);
  });
});
