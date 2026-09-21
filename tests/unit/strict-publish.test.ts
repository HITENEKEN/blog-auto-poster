import Fastify, { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigManager, PlatformPostContent } from '@core/interfaces';
import type { PublishedPostRow } from '../../src/scheduler/JobQueue';
import { registerRoutes } from '../../src/web/server/routes/index';
import { createInventoryItem, initAdInventoryStore } from '../../src/affiliates/AdInventory';
import { buildPublishPreviewHtml } from '../../src/content/PublishPreview';
import { ensureDisclosure } from '../../src/content/Disclosure';

/**
 * strict 발행 계약 (설계 §4-2). `app.inject`로 라우트만 검증한다 —
 * 실제 네이버 발행은 비가역이라 절대 호출하지 않는다.
 *
 * 초안은 `output/posts/<임시 id>/`에 만들고 테스트가 끝나면 지운다
 * (실제 발행물 `post-1789392253728-3a9qu`는 건드리지 않는다).
 */
const DRAFT_ID = `test-strict-${process.pid}`;
const DRAFT_DIR = `./output/posts/${DRAFT_ID}`;
const BLOG_ID = 'hiteneken';
const TITLE = '트위드자켓 고르는 법 — 소재·안감·실루엣 체크리스트';

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** #25 초안 사본 — 로컬 이미지 경로만 원격 URL로 바꾼다(표시용 경로 치환과 무관하게 검증). */
function draftHtml(): string {
  const raw = readFileSync('tests/fixtures/post-25-draft.html', 'utf8');
  return raw.replace(
    /src="output\/images\/[^"]*"/g,
    'src="https://postfiles.pstatic.net/test.png"',
  );
}

let app: FastifyInstance;
let dbPath: string;
let sentContent = '';
let createPostImpl: ((content: PlatformPostContent) => Promise<unknown>) | null = null;

const publishedRows: PublishedPostRow[] = [];

/** 같은 초안이 24h 안에 발행된 행을 심는다(DUPLICATE_DRAFT 케이스). */
function seedPublishedDraft(draftId: string, publishedAt: string): void {
  publishedRows.push({
    id: `pub-naver-${draftId}`,
    job_id: null,
    platform: 'naver',
    post_id: '1',
    url: 'https://blog.naver.com/hiteneken/1',
    title: TITLE,
    template: 'coupang-buying-guide',
    product_id: null,
    affiliate_url: null,
    status: 'published',
    published_at: publishedAt,
    metadata: JSON.stringify({ draftId }),
    created_at: publishedAt,
  });
}

/** 라이브 RSS 응답 스텁 — 실제 네트워크를 쓰지 않는다. */
function stubRss(items: Array<{ title: string; pubDate: string }>): void {
  const xml = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>https://blog.naver.com/${BLOG_ID}/1</link><pubDate>${item.pubDate}</pubDate></item>`,
    )
    .join('');
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    status: 200,
    text: async () => `<rss><channel>${xml}</channel></rss>`,
  }));
}

function writeDraft(content: string, metaOverride: Record<string, unknown> = {}): void {
  mkdirSync(DRAFT_DIR, { recursive: true });
  writeFileSync(`${DRAFT_DIR}/post.html`, content);
  const meta = {
    id: DRAFT_ID,
    title: TITLE,
    template: 'coupang-buying-guide',
    status: 'DRAFT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: ['트위드자켓'],
    categories: [],
    meta: {},
    affiliateUrl: '',
    productId: '',
    platformContent: {
      naver: {
        title: TITLE,
        content,
        tags: ['트위드자켓'],
        categories: [],
        visibility: 'public',
        allowComments: true,
        meta: {},
      },
    },
    ...metaOverride,
  };
  writeFileSync(`${DRAFT_DIR}/meta.json`, JSON.stringify(meta, null, 2));
}

/** 소재 5개를 인벤토리에 넣고 place-ads로 초안에 배치한다(로봇 PLACE_ADS 단계). */
async function seedInventoryAndPlaceAds(): Promise<void> {
  for (let i = 1; i <= 5; i += 1) {
    const created = createInventoryItem({
      url: `https://link.coupang.com/a/strict${i}`,
      productName: `트위드자켓 상품 ${i}`,
      imageUrl: `https://image8.coupangcdn.com/strict${i}.jpg`,
      keywords: ['트위드자켓'],
    });
    if (created.ok === false) throw new Error(created.error);
  }
  const placed = await app.inject({
    method: 'POST',
    url: `/api/posts/${DRAFT_ID}/place-ads`,
    payload: { keyword: '트위드자켓' },
  });
  expect(placed.statusCode).toBe(200);
}

/** 게이트를 돌려 (실패해도) previewSha256을 받는다 — 로봇 GATE 단계와 같은 값. */
async function gateSha(): Promise<{ sha: string; ok: boolean; violations: unknown[] }> {
  const response = await app.inject({
    method: 'POST',
    url: `/api/posts/${DRAFT_ID}/gate`,
    payload: { checkLinks: false, keyword: '트위드자켓' },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  return { sha: body.previewSha256, ok: body.ok, violations: body.violations };
}

async function publish(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/posts/${DRAFT_ID}/publish`,
    payload: { platform: 'naver', strict: true, ...payload },
  });
}

beforeAll(async () => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'strict-db-')), 'test.db');
  app = Fastify({ logger: false });
  await registerRoutes(app, {
    configManager: {
      get: (key: string, fallback?: unknown) =>
        key === 'platforms.naver' ? { blogId: BLOG_ID } : fallback,
      getAll: () => ({}),
    } as unknown as ConfigManager,
    affiliateRegistry: { getAdapter: () => null } as never,
    platformRegistry: {
      getAdapter: (name: string) =>
        name === 'naver'
          ? {
              name: 'naver',
              createPost: async (content: PlatformPostContent) => {
                sentContent = content.content;
                if (createPostImpl) return createPostImpl(content);
                return {
                  postId: '99999',
                  url: 'https://blog.naver.com/hiteneken/99999',
                  publishedAt: new Date(),
                };
              },
            }
          : null,
    } as never,
    // 발행 기록은 인메모리 스텁으로 잡는다 — 실제 jobs.sqlite에 테스트 행을 남기지 않는다.
    jobQueue: {
      recordPublishedPost: (post: Record<string, unknown>) => {
        publishedRows.push({
          id: `pub-${post.platform}-${post.postId}`,
          job_id: null,
          platform: String(post.platform),
          post_id: String(post.postId),
          url: String(post.url ?? ''),
          title: String(post.title ?? ''),
          template: null,
          product_id: null,
          affiliate_url: null,
          status: String(post.status),
          published_at: new Date().toISOString(),
          metadata: post.metadata ? JSON.stringify(post.metadata) : null,
          created_at: new Date().toISOString(),
        } as PublishedPostRow);
      },
      getPublishedPosts: (filters: { status?: string; fromDate?: string; limit?: number } = {}) =>
        publishedRows
          .filter((row) => (filters.status ? row.status === filters.status : true))
          .filter((row) => (filters.fromDate ? row.published_at >= filters.fromDate : true))
          .slice(0, filters.limit ?? publishedRows.length),
      getPublishedPostById: () => null,
    } as never,
    scheduler: {} as never,
  });
  await app.ready();
}, 30000);

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'strict-db-')), 'test.db');
  initAdInventoryStore({ dbPath, legacyPresetsPath: join(tmpdir(), 'missing-presets.json') });
  publishedRows.length = 0;
  sentContent = '';
  createPostImpl = null;
  writeDraft(draftHtml());
  stubRss([{ title: '다른 주제의 기존 글', pubDate: new Date().toISOString() }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(DRAFT_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(dbPath, { force: true });
});

describe('strict 발행 — 게이트·중복·락', () => {
  it('400: strict에서 aiPolish:true는 거부한다', async () => {
    const response = await publish({ aiPolish: true, expectedPreviewSha256: 'x' });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('AI_POLISH_FORBIDDEN');
  });

  it('400: strict에는 expectedPreviewSha256이 필요하다', async () => {
    const response = await publish({});
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('PREVIEW_SHA_REQUIRED');
  });

  it('409 PREVIEW_CHANGED: 미리보기 sha가 다르면 발행하지 않는다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();
    const response = await publish({ expectedPreviewSha256: `${sha}-stale` });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.code).toBe('PREVIEW_CHANGED');
    expect(body.previewSha256).toBe(sha);
    expect(sentContent).toBe('');
  });

  it('409 DUPLICATE_DRAFT: 24시간 안에 같은 초안이 발행됐으면 거부한다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();
    seedPublishedDraft(DRAFT_ID, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const response = await publish({ expectedPreviewSha256: sha });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DUPLICATE_DRAFT');
    expect(sentContent).toBe('');
  });

  it('24시간이 지난 기록은 중복으로 보지 않는다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();
    seedPublishedDraft(DRAFT_ID, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    const response = await publish({ expectedPreviewSha256: sha });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].success).toBe(true);
  });

  it('409 DUPLICATE_TITLE: 라이브 RSS에 같은 제목이 있으면 거부한다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();
    stubRss([
      { title: TITLE, pubDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
    ]);
    const response = await publish({ expectedPreviewSha256: sha });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('DUPLICATE_TITLE');
    expect(sentContent).toBe('');
  });

  it('422 GATE_FAILED: 고지가 빠진 초안은 발행하지 않는다', async () => {
    await seedInventoryAndPlaceAds();
    // 고지만 제거 — 광고는 남으므로 DISCLOSURE_COUNT 위반이다.
    const withoutDisclosure = ensureDisclosure(
      readFileSync(`${DRAFT_DIR}/post.html`, 'utf8'),
      false,
    );
    writeFileSync(`${DRAFT_DIR}/post.html`, withoutDisclosure);
    const { sha, ok, violations } = await gateSha();
    expect(ok).toBe(false);
    expect(JSON.stringify(violations)).toContain('DISCLOSURE_COUNT');
    const response = await publish({ expectedPreviewSha256: sha });
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.code).toBe('GATE_FAILED');
    expect(JSON.stringify(body.violations)).toContain('DISCLOSURE_COUNT');
    expect(sentContent).toBe('');
  });

  it('423 PUBLISH_IN_PROGRESS: 발행 중 두 번째 요청은 락에 막힌다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();

    const gate = Promise.withResolvers<unknown>();
    createPostImpl = () => gate.promise;

    const first = publish({ expectedPreviewSha256: sha });
    // 첫 요청이 락을 잡고 createPost까지 진행할 때까지 기다린다.
    await vi.waitFor(() => expect(sentContent).not.toBe(''), { timeout: 5000 });

    const second = await publish({ expectedPreviewSha256: sha });
    expect(second.statusCode).toBe(423);
    expect(second.json().code).toBe('PUBLISH_IN_PROGRESS');

    gate.resolve({
      postId: '1',
      url: 'https://blog.naver.com/hiteneken/1',
      publishedAt: new Date(),
    });
    const firstResponse = await first;
    expect(firstResponse.statusCode).toBe(200);
    expect(firstResponse.json().results[0].success).toBe(true);
  });
});

describe('strict 발행 — 불변식', () => {
  it('초안 본문을 바꾸지 않고, 보낸 HTML은 미리보기 sha와 같다', async () => {
    await seedInventoryAndPlaceAds();
    const htmlBefore = readFileSync(`${DRAFT_DIR}/post.html`, 'utf8');
    const metaBefore = JSON.parse(readFileSync(`${DRAFT_DIR}/meta.json`, 'utf8'));
    const { sha } = await gateSha();

    const response = await publish({ expectedPreviewSha256: sha, robotRunId: 'run-1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].success).toBe(true);

    // (a) strict는 승인한 초안을 다시 쓰지 않는다.
    expect(readFileSync(`${DRAFT_DIR}/post.html`, 'utf8')).toBe(htmlBefore);
    const metaAfter = JSON.parse(readFileSync(`${DRAFT_DIR}/meta.json`, 'utf8'));
    expect(metaAfter.platformContent.naver.content).toBe(metaBefore.platformContent.naver.content);
    expect(metaAfter.status).toBe('PUBLISHED');

    // (b) strict가 보낸 HTML의 sha == 미리보기 sha(게이트가 검증한 값).
    expect(sha256(sentContent)).toBe(sha);
    // (c) 대시보드가 보여주는 미리보기와도 같은 HTML이다(로컬 경로 치환 없음).
    const preview = await app.inject({
      method: 'GET',
      url: `/api/posts/${DRAFT_ID}/publish-preview?platform=naver`,
    });
    expect(sha256(preview.json().html)).toBe(sha);

    // (d) 발행 직전 HTML은 자동 광고 카드가 오프라인으로 렌더된 결과다.
    expect(sentContent).toContain('🛒 쿠팡에서 보기');
    expect(sentContent).not.toContain('data-coupang-widget');
    expect(sentContent.match(/link\.coupang\.com\/a\/strict/g)?.length).toBeGreaterThan(0);
    const offline = buildPublishPreviewHtml(htmlBefore, 'naver');
    expect(sha256(offline)).toBe(sha);
  });

  it('발행 기록에 draftId·previewSha256·robotRunId가 남는다', async () => {
    await seedInventoryAndPlaceAds();
    const { sha } = await gateSha();
    const response = await publish({ expectedPreviewSha256: sha, robotRunId: 'run-42' });
    expect(response.statusCode).toBe(200);
    const row = publishedRows.find((r) => r.status === 'published');
    expect(row).toBeTruthy();
    const metadata = JSON.parse(row?.metadata ?? '{}');
    expect(metadata.draftId).toBe(DRAFT_ID);
    expect(metadata.previewSha256).toBe(sha);
    expect(metadata.robotRunId).toBe('run-42');
  });
});

describe('place-ads — 멱등성', () => {
  it('두 번 적용해도 post.html이 같고, gate는 파일을 바꾸지 않는다', async () => {
    await seedInventoryAndPlaceAds();
    const once = readFileSync(`${DRAFT_DIR}/post.html`, 'utf8');
    const second = await app.inject({
      method: 'POST',
      url: `/api/posts/${DRAFT_ID}/place-ads`,
      payload: { keyword: '트위드자켓' },
    });
    expect(second.statusCode).toBe(200);
    expect(
      second
        .json()
        .slots.map((s: { kind: string; afterSection: number }) => [s.kind, s.afterSection]),
    ).toEqual([
      ['single', 3],
      ['single', 5],
      ['bundle', 9],
    ]);
    expect(second.json().disclosure).toBe(true);
    expect(readFileSync(`${DRAFT_DIR}/post.html`, 'utf8')).toBe(once);

    const metaBefore = readFileSync(`${DRAFT_DIR}/meta.json`, 'utf8');
    const gated = await app.inject({
      method: 'POST',
      url: `/api/posts/${DRAFT_ID}/gate`,
      payload: { checkLinks: false, keyword: '트위드자켓' },
    });
    expect(gated.statusCode).toBe(200);
    expect(gated.json().ok).toBe(true);
    expect(gated.json().previewSha256).toHaveLength(64);
    // 게이트는 초안을 바꾸지 않는다(별도 증거 파일만 남긴다).
    expect(readFileSync(`${DRAFT_DIR}/post.html`, 'utf8')).toBe(once);
    expect(readFileSync(`${DRAFT_DIR}/meta.json`, 'utf8')).toBe(metaBefore);
  });
});
