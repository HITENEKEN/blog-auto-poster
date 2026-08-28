import { LLM_PROVIDERS } from './ContentGenerator';

/**
 * 프로바이더별 모델 목록 조회 요청을 구성한다(네트워크 없이 순수 함수).
 * gemini는 네이티브 REST, anthropic은 자체 헤더, 나머지는 OpenAI 호환 /models.
 * apiKey는 절대 응답/로그로 노출되지 않아야 하므로 반환값에만 사용한다.
 */
export function buildModelsRequest(
  provider: string,
  apiKey: string,
): { url: string; headers: Record<string, string> } | null {
  if (!LLM_PROVIDERS[provider] || !apiKey) return null;

  if (provider === 'gemini') {
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=200`,
      headers: {},
    };
  }
  if (provider === 'anthropic') {
    return {
      url: 'https://api.anthropic.com/v1/models?limit=100',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    };
  }
  return {
    url: `${LLM_PROVIDERS[provider].baseUrl}/models`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

/** 프로바이더별 모델 목록 응답 본문을 모델 id 문자열 배열로 정규화한다(순수 함수). */
export function parseModelsResponse(provider: string, body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const record = body as Record<string, unknown>;

  if (provider === 'gemini') {
    const models = Array.isArray(record.models) ? record.models : [];
    return (
      models
        .filter((m): m is Record<string, unknown> => !!m && typeof m === 'object')
        // 'generateContent' 지원 여부는 지정되어 있을 때만 필터링한다.
        .filter((m) => {
          const methods = m.supportedGenerationMethods;
          return !Array.isArray(methods) || methods.includes('generateContent');
        })
        .map((m) => (typeof m.name === 'string' ? m.name.replace(/^models\//, '') : ''))
        .filter((name) => name.length > 0)
    );
  }

  // OpenAI 호환 응답은 data[].id 객체 배열, 방어적으로 문자열 배열도 허용한다.
  const data = Array.isArray(record.data) ? record.data : [];
  return data
    .map((item) => {
      if (typeof item === 'string' && item.length > 0) return item;
      if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>).id;
        return typeof id === 'string' && id.length > 0 ? id : '';
      }
      return '';
    })
    .filter((id) => id.length > 0);
}

/**
 * 저장된 apiKey로 해당 프로바이더의 모델 목록을 조회한다.
 * 네트워크/HTTP 오류는 호출자(routes)가 사용자 친화적 error로 변환하도록 throw한다.
 * 오류 메시지에는 URL(= gemini key 파라미터 포함)이 노출되지 않게 상태 코드만 담는다.
 */
export async function fetchLlmModels(provider: string, apiKey: string): Promise<string[]> {
  const request = buildModelsRequest(provider, apiKey);
  if (!request) throw new Error('지원하지 않는 프로바이더입니다');

  let res: Response;
  try {
    res = await fetch(request.url, { headers: request.headers });
  } catch {
    throw new Error('모델 목록 조회에 실패했습니다 (네트워크 오류)');
  }
  if (!res.ok) throw new Error(`모델 목록 조회에 실패했습니다 (HTTP ${res.status})`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('모델 목록 응답을 파싱할 수 없습니다');
  }
  return parseModelsResponse(provider, body);
}
