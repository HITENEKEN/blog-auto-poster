// 서버용 쌍둥이: src/content/ContentGenerator.ts의 LLM_PROVIDERS (수동 동기화 유지).
export const LLM_PROVIDER_OPTIONS: Array<{
  value: string;
  label: string;
  defaultModel: string;
  defaultBaseUrl: string;
}> = [
  {
    value: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-1.5-pro',
    defaultBaseUrl: '',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    value: 'anthropic',
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-3-5-sonnet-latest',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4o-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
  },
  {
    value: 'deepseek',
    label: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    value: 'groq',
    label: 'Groq',
    defaultModel: 'llama-3.3-70b-versatile',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
  },
  {
    value: 'mistral',
    label: 'Mistral AI',
    defaultModel: 'mistral-large-latest',
    defaultBaseUrl: 'https://api.mistral.ai/v1',
  },
  {
    value: 'xai',
    label: 'xAI (Grok)',
    defaultModel: 'grok-2-latest',
    defaultBaseUrl: 'https://api.x.ai/v1',
  },
  {
    value: 'ollama',
    label: 'Ollama (로컬)',
    defaultModel: 'llama3.1',
    defaultBaseUrl: 'http://localhost:11434/v1',
  },
];
