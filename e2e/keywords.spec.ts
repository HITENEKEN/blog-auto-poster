import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('keywords', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/keywords');
    // Keywords.tsx:186 — <h1>키워드 리서치</h1>
    await expect(page.getByRole('heading', { level: 1, name: '키워드 리서치' })).toBeVisible();
  });

  // On load the page fetches GET /api/keywords/top?limit=20 (Keywords.tsx:103),
  // which resolves topSeeds (무선청소기) through the naver-api-hub provider →
  // local mock server (e2e/mock/naver-hub-mock.mjs echoes "[mock] <query>" in
  // titles/descriptions, mock.mjs:36-38). The provider derives related keywords
  // from those titles (NaverApiHubProvider.ts:178-219), so "mock" appears in the
  // row's related-keywords cell — proving server → mock → UI end to end.
  test('top keywords section renders data sourced from the mock server', async ({ page }) => {
    // TOP 20 card title (Keywords.tsx:325) renders once results arrive.
    await expect(page.getByText('블로그 키워드 TOP 20')).toBeVisible({ timeout: 25_000 });
    // Row for the seed keyword (Keywords.tsx:162 renders kw.keyword in a table cell).
    const row = page.getByRole('row').filter({ hasText: '무선청소기' });
    await expect(row.first()).toBeVisible();
    await expect(row.first()).toContainText('mock'); // related keyword extracted from mock titles
  });

  // Research with a unique query: cache keys include the query
  // (NaverApiHubProvider.ts:78,124), so Date.now() uniqueness guarantees the
  // request reaches the mock instead of a cached entry. The blog-competitor
  // section (Keywords.tsx:340-378) renders the mock's echoed title.
  test('unique-query research shows mock echo title', async ({ page }) => {
    const query = `e2e-query-${Date.now()}`;
    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query); // Keywords.tsx:204-210
    await page.getByRole('button', { name: '분석' }).click(); // Keywords.tsx:224-231

    // Result table row carries the queried keyword (Keywords.tsx:284).
    const resultRow = page.getByRole('row').filter({ hasText: query });
    await expect(resultRow.first()).toBeVisible({ timeout: 25_000 });

    // 경쟁 블로그 section shows "[mock] <query> 블로그 N" titles
    // (Keywords.tsx:359 renders blog.title; mock.mjs:36 produces the echo).
    await expect(page.getByText(`[mock] ${query} 블로그 1`)).toBeVisible({ timeout: 25_000 });
  });
});
