import type { FastifyInstance } from 'fastify';
import { getLogger } from '@core/logger';
import {
  activeAdCountsByCategory,
  addInventoryFromPaste,
  cancelAdRequest,
  getInventoryItem,
  listAdRequests,
  listInventory,
  recordInventoryCheck,
  removeInventory,
  updateInventory,
  upsertAdRequest,
} from '@affiliates/AdInventory';
import { matchAds } from '@content/AdMatcher';
import type { AdLinkFetcher } from '@content/AdGate';
import type { AdStatus } from '@content/AdTypes';

const logger = getLogger('ads-routes');

const AD_STATUSES: AdStatus[] = ['active', 'dead', 'expired', 'removed'];

/**
 * 광고 링크 생존 확인용 fetcher — `redirect: 'manual'`로 **첫 리다이렉트만** 본다
 * (설계 §3-7). 상품 페이지까지 따라가지 않는다: 이 요청이 파트너스 클릭으로
 * 집계될 수 있어 반복 호출하지 않는다.
 */
export const trackingLinkFetcher: AdLinkFetcher = async (url) => {
  const response = await fetch(url, {
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) blog-auto-poster' },
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, location: response.headers.get('location') };
};

/**
 * 광고 소재·소재 요청 API (설계 §4-1).
 *
 * 저장은 `ad_inventory`/`ad_requests` 테이블이 맡고, 이 파일은 HTTP 계약만
 * 담당한다 — `routes/index.ts`(1,944줄) 비대화를 막기 위해 분리했다.
 */
export async function registerAdRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ads/inventory', async (request) => {
    const { keyword, categoryId, status } = request.query as {
      keyword?: string;
      categoryId?: string;
      status?: string;
    };
    const items = listInventory({
      categoryId: categoryId || undefined,
      status: AD_STATUSES.includes(status as AdStatus) ? (status as AdStatus) : undefined,
    });
    if (!keyword) return { items };
    // 키워드가 있으면 관련성 순으로 — 대시보드가 "이 주제에 쓸 소재"를 그대로 본다.
    const ranked = matchAds({ keyword, categoryId }, items);
    return { items: ranked.map((entry) => ({ ...entry.ad, score: entry.score })) };
  });

  app.post('/api/ads/inventory', async (request, reply) => {
    const body = (request.body ?? {}) as {
      paste?: string;
      keywords?: unknown;
      categoryId?: string;
      requestId?: string;
    };
    const keywords = Array.isArray(body.keywords) ? body.keywords.map((k) => String(k)) : [];
    const result = addInventoryFromPaste({
      paste: String(body.paste ?? ''),
      keywords,
      categoryId: body.categoryId || undefined,
      requestId: body.requestId || undefined,
    });
    if (result.ok === false)
      return reply.code(400).send({ error: result.error, field: result.field });
    return { item: result.value };
  });

  app.patch('/api/ads/inventory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as {
      keywords?: unknown;
      categoryId?: string | null;
      status?: string;
      markUsed?: boolean;
    };
    if (body.status !== undefined && !AD_STATUSES.includes(body.status as AdStatus)) {
      return reply.code(400).send({ error: '알 수 없는 상태입니다', field: 'status' });
    }
    const item = updateInventory(id, {
      keywords: Array.isArray(body.keywords) ? body.keywords.map((k) => String(k)) : undefined,
      categoryId: body.categoryId,
      status: body.status as AdStatus | undefined,
      // 발행 기록 단계(RECORD)가 사용 횟수를 올린다 — 로봇은 DB를 직접 쓰지 않는다.
      markUsed: body.markUsed === true,
    });
    if (!item) return reply.code(404).send({ error: '소재를 찾지 못했습니다' });
    return { item };
  });

  app.delete('/api/ads/inventory/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!getInventoryItem(id)) return reply.code(404).send({ error: '소재를 찾지 못했습니다' });
    removeInventory(id);
    return { ok: true };
  });

  app.post('/api/ads/inventory/:id/check', async (request, reply) => {
    const { id } = request.params as { id: string };
    const item = getInventoryItem(id);
    if (!item) return reply.code(404).send({ error: '소재를 찾지 못했습니다' });

    let status: number | null = null;
    let location: string | null = null;
    let ok = false;
    try {
      const response = await trackingLinkFetcher(item.url);
      status = response.status;
      location = response.location ?? null;
      ok =
        response.status >= 300 &&
        response.status < 400 &&
        Boolean(location && /(^|\.)coupang\.com$/i.test(new URL(location).hostname.toLowerCase()));
    } catch (error) {
      logger.warn({ adId: id, error: String(error) }, 'ad link check failed');
    }

    const updated = recordInventoryCheck(id, {
      ok,
      status,
      location,
      checkedAt: new Date().toISOString(),
    });
    return { ok, status, location, item: updated };
  });

  app.get('/api/ads/requests', async (request) => {
    const { status } = request.query as { status?: string };
    const requests = listAdRequests({
      status: status === 'open' ? 'open' : undefined,
    });
    return { requests, inventoryCounts: activeAdCountsByCategory() };
  });

  app.post('/api/ads/requests', async (request, reply) => {
    const body = (request.body ?? {}) as {
      keyword?: string;
      categoryId?: string | null;
      needed?: number;
      criteria?: unknown;
      dueAt?: string;
      robotRunId?: string | null;
    };
    const result = upsertAdRequest({
      keyword: String(body.keyword ?? ''),
      categoryId: body.categoryId ?? null,
      needed: Number(body.needed),
      criteria: Array.isArray(body.criteria) ? body.criteria.map((c) => String(c)) : [],
      dueAt: String(body.dueAt ?? ''),
      robotRunId: body.robotRunId ?? null,
    });
    if (result.ok === false)
      return reply.code(400).send({ error: result.error, field: result.field });
    return { request: result.value };
  });

  app.post('/api/ads/requests/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!cancelAdRequest(id)) {
      return reply.code(404).send({ error: '열려 있는 소재 요청을 찾지 못했습니다' });
    }
    return { ok: true };
  });
}
