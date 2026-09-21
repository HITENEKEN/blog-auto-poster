import { TransientError } from './errors';

/** 로봇이 쓰는 최소 HTTP 계층 — 테스트에서 가짜로 바꿔 끼운다(RSS·라이브 목록 조회). */
export interface HttpClient {
  getText(url: string, opts?: { timeoutMs?: number }): Promise<string>;
  /** 응답 상태 코드만 본다(네트워크 오류·타임아웃이면 0). 본문 링크 200 확인용. */
  status(url: string, opts?: { timeoutMs?: number }): Promise<number>;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export function createHttpClient(): HttpClient {
  const withTimeout = async (
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    getText: async (url: string, opts: { timeoutMs?: number } = {}) => {
      try {
        const res = await withTimeout(url, {}, opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
        if (!res.ok) throw new TransientError(`GET ${url} → ${res.status}`);
        return await res.text();
      } catch (error) {
        if (error instanceof TransientError) throw error;
        throw new TransientError(`GET ${url} 실패: ${String(error)}`, error);
      }
    },
    status: async (url: string, opts: { timeoutMs?: number } = {}) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
      try {
        // HEAD를 지원하지 않는 서버가 있어 405/501이면 GET으로 한 번 더 본다.
        const head = await withTimeout(url, { method: 'HEAD', redirect: 'follow' }, timeoutMs);
        if (head.status !== 405 && head.status !== 501) return head.status;
        const get = await withTimeout(url, { method: 'GET', redirect: 'follow' }, timeoutMs);
        return get.status;
      } catch {
        return 0;
      }
    },
  };
}
