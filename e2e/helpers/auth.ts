import { expect, type Page } from '@playwright/test';

const DEFAULT_USER = 'e2e-admin';
const DEFAULT_PASS = 'e2e-pass-1234';

/**
 * UI login through the real Login form.
 *
 * Selectors derived from src/web/client/src/pages/Login.tsx:
 * - username Input (:51-56): first <input> inside the <form>, placeholder "admin"
 * - password Input (:62-68): <input type="password"> inside the <form>
 * - submit Button (:79-88): text "로그인"
 * Both fields carry defaults ('admin'/'changeme', Login.tsx:11-12) — always overwritten.
 *
 * NOTE: the app does NOT auto-navigate after a successful login — /login is
 * rendered outside PrivateRoute (App.tsx:37) and Login.tsx performs no
 * navigation; AuthContext.login() only stores the JWT (AuthContext.tsx:41).
 * Success is therefore judged by the stored token, then the helper navigates
 * to / and waits for the Dashboard heading (Dashboard.tsx:106, App.tsx:46).
 */
export async function login(
  page: Page,
  username: string = process.env.E2E_ADMIN_USER ?? DEFAULT_USER,
  password: string = process.env.E2E_ADMIN_PASS ?? DEFAULT_PASS,
): Promise<void> {
  await page.goto('/login');
  const form = page.locator('form');
  await form.locator('input').first().fill(username);
  await form.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('token'))).toBeTruthy();
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: '대시보드' })).toBeVisible();
}

/**
 * The client authenticates API calls with a Bearer token from localStorage
 * (AuthContext.tsx:22-24, 41) — page.request does not carry it, so specs that
 * hit /api/* directly must attach this header manually.
 */
export async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => localStorage.getItem('token'));
  if (!token) {
    throw new Error('localStorage.token is missing — login() must run first');
  }
  return token;
}

export function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
