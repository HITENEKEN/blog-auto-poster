import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('pages', () => {
  // All platforms are disabled in the e2e profile. /api/blogs (routes/index.ts:182-230)
  // still lists configured platform keys as disconnected entries, so the page
  // shows cards with "연결 안됨" badges (Blogs.tsx:117-119); the empty state
  // ("연동된 블로그가 없습니다", :86) is the fallback if none are listed.
  test('/blogs renders disabled state without crash', async ({ page }) => {
    await login(page);
    await page.goto('/blogs');

    // Blogs.tsx:69 — <h1>블로그 관리</h1>
    await expect(page.getByRole('heading', { level: 1, name: '블로그 관리' })).toBeVisible();

    // Either disconnected cards or the empty state — both are non-crash renders.
    const disconnected = page.getByText('연결 안됨');
    const emptyState = page.getByText('연동된 블로그가 없습니다');
    await expect(disconnected.or(emptyState).first()).toBeVisible({ timeout: 15_000 });
  });

  // Coupang affiliate is disabled; the page renders static zero-value stat
  // cards (Coupang.tsx:30-55) without touching the real affiliate API.
  test('/coupang renders inactive state without crash', async ({ page }) => {
    await login(page);
    await page.goto('/coupang');

    // Coupang.tsx:69 — <h1>쿠팡 파트너스 현황</h1>
    await expect(page.getByRole('heading', { level: 1, name: '쿠팡 파트너스 현황' })).toBeVisible();

    // Stat cards render with zeroed placeholder values (:32-33).
    await expect(page.getByText('총 수익', { exact: true })).toBeVisible();
    await expect(page.getByText('₩0', { exact: true })).toBeVisible();
  });
});
