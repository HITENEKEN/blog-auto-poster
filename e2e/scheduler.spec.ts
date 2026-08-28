import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

test.describe('scheduler', () => {
  // e2e profile: scheduler disabled, jobs []. The page must render stopped with
  // no jobs. PUT /api/scheduler/config (enabled:true) is FORBIDDEN in specs —
  // asserted below by never issuing one and by listening for any.
  test('renders stopped scheduler with empty jobs', async ({ page }) => {
    const schedulerConfigPuts: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/scheduler/config')) {
        schedulerConfigPuts.push(req.url());
      }
    });

    await login(page);
    await page.goto('/scheduler');

    // Scheduler.tsx:78 — <h1>자동 포스팅 설정</h1>
    await expect(page.getByRole('heading', { level: 1, name: '자동 포스팅 설정' })).toBeVisible();

    // Jobs empty: CardTitle "예약된 작업 ({jobs.length}개)" (:99) and empty
    // state "예약된 작업이 없습니다." (:109) — rendered instead of the job list.
    await expect(page.getByText('예약된 작업 (0개)')).toBeVisible();
    await expect(page.getByText('예약된 작업이 없습니다.')).toBeVisible();

    // Stopped state: hydrated from GET /api/scheduler/config (Scheduler.tsx:38-43
    // sets schedulerRunning from response.data.enabled), so the toggle offers
    // "스케줄러 시작" (:86-93), never "중지".
    await expect(page.getByRole('button', { name: '스케줄러 시작' })).toBeVisible();
    await expect(page.getByRole('button', { name: '스케줄러 중지' })).toHaveCount(0);

    // The forbidden mutation was never sent from the page.
    expect(schedulerConfigPuts).toHaveLength(0);

    // API-level: GET /api/scheduler/jobs returns an empty jobs array
    // (routes/index.ts wrapper { jobs: [...] }), and the hydrated config
    // confirms stopped: enabled false (e2e profile), not running.
    const token = await getAuthToken(page);
    const res = await page.request.get('/api/scheduler/jobs', { headers: authHeaders(token) });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { jobs: unknown[] };
    expect(Array.isArray(body.jobs)).toBe(true);
    expect(body.jobs).toHaveLength(0);

    const cfgRes = await page.request.get('/api/scheduler/config', {
      headers: authHeaders(token),
    });
    expect(cfgRes.ok()).toBeTruthy();
    const cfg = (await cfgRes.json()) as { success: boolean; enabled: boolean; running: boolean };
    expect(cfg.success).toBe(true);
    expect(cfg.enabled).toBe(false);
    expect(cfg.running).toBe(false);
  });
});
