import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

// Fresh DB → no posts. API contract: GET /api/posts returns the wrapper
// { posts: [...], total, limit, offset } (routes/index.ts:544-561).
// No POST /api/posts here — forbidden by plan (would trigger external calls).
test.describe('posts', () => {
  test('renders empty posts list and empty GET /api/posts', async ({ page }) => {
    await login(page);
    await page.goto('/posts');

    // Posts.tsx:71 — <h1>포스트 관리</h1>
    await expect(page.getByRole('heading', { level: 1, name: '포스트 관리' })).toBeVisible();

    // Empty state (Posts.tsx:133) instead of the posts table (:138-209).
    await expect(page.getByText('포스트가 없습니다.')).toBeVisible();
    await expect(page.getByRole('row')).toHaveCount(0);

    // API wrapper check: { posts: [], total: 0 }.
    const token = await getAuthToken(page);
    const res = await page.request.get('/api/posts', { headers: authHeaders(token) });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { posts: unknown[]; total: number };
    expect(Array.isArray(body.posts)).toBe(true);
    expect(body.posts).toHaveLength(0);
    expect(body.total).toBe(0);
  });

  // Plan Verification 2 — full keyword→draft flow on the fallback path
  // (config/e2e has no LLM key, so ContentGenerator.generateTemplateData
  // returns null and KeywordPostGenerator fills DEFAULT_FIELD_VALUES).
  // NOTE: must run after the empty-state test above — the drafts card on
  // /posts breaks that test's row-count assertion.
  test('generates a draft from keyword, persists, and renders the draft row in UI', async ({
    page,
  }) => {
    test.setTimeout(120_000); // template render + naver-hub mock round-trips
    await login(page);
    const token = await getAuthToken(page);
    // Unique per attempt — a retried attempt runs in the same server
    // workspace, and the /posts drafts-card row filter must match exactly one
    // row even after the previous attempt's draft persists there.
    const runStamp = Date.now();

    // --- POST /api/posts/generate-from-keyword → 200 + post.id ---
    const genRes = await page.request.post('/api/posts/generate-from-keyword', {
      headers: authHeaders(token),
      data: { keyword: '무선청소기', template: 'coupang-product-review' },
    });
    expect(genRes.status()).toBe(200);
    const genBody = (await genRes.json()) as {
      post?: { id?: string };
      error?: string;
    };
    const postId = genBody.post?.id;
    expect(postId, `generate-from-keyword failed: ${genBody.error}`).toBeTruthy();

    // 비동기 계약(routes/index.ts:1040-1099): POST는 드래프트 id만 즉시 반환하고
    // 실제 생성(LLM 폴백→렌더→저장)은 백그라운드에서 완료된다. 본문을 단언·수정하기
    // 전에 백그라운드 완료를 폴링으로 기다린다 — 완료 전 PUT은 백그라운드 저장에
    // 덮어쓰일 수 있다. e2e에선 LLM 키가 없어 수십 ms 만에 완료된다.
    await expect
      .poll(
        async () => {
          const pollRes = await page.request.get('/api/posts/drafts', {
            headers: authHeaders(token),
          });
          const pollBody = (await pollRes.json()) as {
            drafts: Array<{ id: string; generationStatus?: string }>;
          };
          return pollBody.drafts.find((d) => d.id === postId)?.generationStatus;
        },
        { timeout: 90_000, intervals: [100, 250, 1000, 5000] },
      )
      .toBe('done');

    // --- GET /api/posts/:id → content contains keyword + affiliate disclosure ---
    const getRes = await page.request.get(`/api/posts/${postId}`, {
      headers: authHeaders(token),
    });
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as { post: { content: string } };
    expect(getBody.post.content).toContain('무선청소기');
    // 고지 문구 — templates/coupang-product-review.hbs:40
    expect(getBody.post.content).toContain('쿠팡 파트너스');

    // --- PUT widget-marker content → GET re-fetch reflects it ---
    const widgetProps = encodeURIComponent(
      JSON.stringify({ url: 'https://link.coupang.com/a/e2e', text: '무선청소기 최저가' }),
    );
    const marker = `<div data-coupang-widget="product-link" data-widget-props="${widgetProps}"></div>`;
    const newTitle = `무선청소기 추천 (e2e-${runStamp})`;
    const putRes = await page.request.put(`/api/posts/${postId}`, {
      headers: authHeaders(token),
      data: { content: marker, title: newTitle },
    });
    expect(putRes.status()).toBe(200);
    const refetchRes = await page.request.get(`/api/posts/${postId}`, {
      headers: authHeaders(token),
    });
    const refetchBody = (await refetchRes.json()) as {
      post: { content: string; meta: { title: string } };
    };
    expect(refetchBody.post.content).toContain(marker);
    expect(refetchBody.post.meta.title).toBe(newTitle);

    // --- GET /api/posts/drafts contains the id ---
    const draftsRes = await page.request.get('/api/posts/drafts', {
      headers: authHeaders(token),
    });
    expect(draftsRes.ok()).toBeTruthy();
    const draftsBody = (await draftsRes.json()) as {
      drafts: Array<{ id: string }>;
    };
    expect(draftsBody.drafts.some((d) => d.id === postId)).toBe(true);

    // --- UI: /posts draft row renders ---
    await page.goto('/posts');
    await expect(page.getByRole('heading', { level: 1, name: '포스트 관리' })).toBeVisible();
    await expect(page.getByText('임시저장 드래프트')).toBeVisible(); // Posts.tsx:103
    // hasText is substring matching — new RegExp(newTitle) would treat the
    // literal "(e2e)" parens as a capture group and never match.
    const draftRow = page.getByRole('row').filter({ hasText: newTitle });
    await expect(draftRow).toBeVisible();
  });

  // Editor visible on /posts/:id/edit — plan acceptance. Previously expected
  // to fail: EditorImage's dual 'inline block' group declaration crashed the
  // TipTap schema ("Mixing inline and block content"), white-screening the
  // editor. Fixed in 56292a0 (nodes.tsx: `group: 'inline'` + `inline: true`).
  test('shows the WYSIWYG editor on /posts/:id/edit', async ({ page }) => {
    test.setTimeout(60_000);
    await login(page);
    const token = await getAuthToken(page);
    const runStamp = Date.now();

    // Fresh draft with a widget marker so the editor has content to load.
    const genRes = await page.request.post('/api/posts/generate-from-keyword', {
      headers: authHeaders(token),
      data: { keyword: '무선청소기', template: 'coupang-product-review' },
    });
    expect(genRes.status()).toBe(200);
    const genBody = (await genRes.json()) as { post?: { id?: string } };
    const postId = genBody.post?.id;
    expect(postId).toBeTruthy();

    // 비동기 계약: 백그라운드 생성 완료 전 PUT하면 저장이 배경 저장으로 덮어쓰인다 —
    // 종료 상태까지 폴링(posts.spec 두 번째 테스트와 동일한 근거).
    await expect
      .poll(
        async () => {
          const pollRes = await page.request.get('/api/posts/drafts', {
            headers: authHeaders(token),
          });
          const pollBody = (await pollRes.json()) as {
            drafts: Array<{ id: string; generationStatus?: string }>;
          };
          return pollBody.drafts.find((d) => d.id === postId)?.generationStatus;
        },
        { timeout: 90_000, intervals: [100, 250, 1000, 5000] },
      )
      .toBe('done');
    const widgetProps = encodeURIComponent(
      JSON.stringify({ url: 'https://link.coupang.com/a/e2e', text: '무선청소기 최저가' }),
    );
    const marker = `<div data-coupang-widget="product-link" data-widget-props="${widgetProps}"></div>`;
    const editorTitle = `무선청소기 위젯 편집 (e2e-${runStamp})`;
    const putRes = await page.request.put(`/api/posts/${postId}`, {
      headers: authHeaders(token),
      data: { content: marker, title: editorTitle },
    });
    expect(putRes.status()).toBe(200);

    // Navigate via the drafts card row (Posts.tsx:125-132 → /posts/{id}/edit).
    await page.goto('/posts');
    const draftRow = page.getByRole('row').filter({ hasText: editorTitle });
    await expect(draftRow).toBeVisible();
    await draftRow.getByRole('button', { name: '편집' }).click();

    // Plan acceptance: contenteditable editor visible (PostEditor.tsx:133,161).
    await expect(page.getByRole('heading', { name: '포스트 편집' })).toBeVisible();
    // TipTap EditorContent renders .ProseMirror[contenteditable="true"]
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
    // The PUT title lands in the title Input (PostEditor.tsx:153-157)
    await expect(page.getByPlaceholder('포스트 제목')).toHaveValue(editorTitle);
  });
});
