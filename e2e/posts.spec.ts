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
});
