import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('auth', () => {
  // App.tsx:26-27 — PrivateRoute redirects unauthenticated users to /login.
  test('redirects unauthenticated / to /login', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  });

  // Wrong credentials → 401 from server (middleware/auth.ts:93-96, message
  // "Username or password is incorrect") rendered in Login.tsx's error div
  // (Login.tsx:43-47, set from err.response.data.message at :25-28).
  // api.ts excludes /api/auth/* from the refresh/reload interceptor so the
  // error state survives; assert both the network response and the UI.
  test('shows server 401 message on wrong password', async ({ page }) => {
    await page.goto('/login');
    const form = page.locator('form');
    await form.locator('input').first().fill('e2e-admin');
    await form.locator('input[type="password"]').fill('definitely-wrong-password');
    const loginResp = page.waitForResponse(
      (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const resp = await loginResp;
    expect(resp.status()).toBe(401);
    const body = (await resp.json()) as { message?: string };
    expect(body.message).toBe('Username or password is incorrect');

    // Server message visibly rendered in the form's error div; no navigation
    // away, no token stored.
    await expect(form.getByText('Username or password is incorrect')).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  });

  // Successful login → JWT in localStorage.token (AuthContext.tsx:41) and the
  // helper lands on / (Dashboard, App.tsx:46) where stat cards render
  // (Dashboard.tsx:117-141). Fresh DB + all providers disabled → zeroed stats,
  // rendered without any external calls.
  test('login success lands on dashboard with token and rendered stats', async ({ page }) => {
    await login(page);
    await expect(page).toHaveURL(/\/$/);
    const token = await page.evaluate(() => localStorage.getItem('token'));
    expect(token).toBeTruthy();

    // Stat card titles (Dashboard.tsx:118, 125, 132, 137).
    await expect(page.getByText('총 포스트', { exact: true })).toBeVisible();
    await expect(page.getByText('오늘 발행', { exact: true })).toBeVisible();
    await expect(page.getByText('발행 성공', { exact: true })).toBeVisible();
    await expect(page.getByText('성공률', { exact: true })).toBeVisible();
  });

  // Layout.tsx:112-118 logout button (title="로그아웃") clears the token
  // (AuthContext.tsx:46-50) and PrivateRoute bounces back to /login (App.tsx:26-27).
  test('logout returns to /login and removes token', async ({ page }) => {
    await login(page);
    await page.locator('button[title="로그아웃"]').click();
    await expect(page).toHaveURL(/\/login$/);
    await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).toBeNull();
  });
});
