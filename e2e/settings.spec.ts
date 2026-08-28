import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

// Collect every secret-like string field in a config tree; each must be the
// '***' sentinel (server maskSecrets, routes/index.ts:26-44).
function collectMasked(value: unknown, path = '', out: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectMasked(v, `${path}[${i}]`, out));
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path ? `${path}.${key}` : key;
      if (v === '***') {
        out.push(childPath);
      } else {
        collectMasked(v, childPath, out);
      }
    }
  }
  return out;
}

test.describe('settings', () => {
  test('loads config, masks secrets, saves a non-secret value round-trip', async ({ page }) => {
    await login(page);
    await page.goto('/settings');

    // Settings.tsx:272 — <h1>설정</h1>; general tab is the default active tab.
    await expect(page.getByRole('heading', { level: 1, name: '설정' })).toBeVisible();

    // Site name input (Settings.tsx:311, id="siteName") hydrates from
    // GET /api/config app.name (Settings.tsx:134-137) — e2e profile sets
    // app.name 'blog-auto-poster-e2e'.
    const siteName = page.locator('#siteName');
    await expect(siteName).toHaveValue(/.+/);

    // Masked secrets: GET /api/config masks every secret-like key with '***'
    // (routes/index.ts:92-94). The e2e profile's naver-api-hub credentials are
    // the guaranteed non-empty secret pair.
    const token = await getAuthToken(page);
    const res = await page.request.get('/api/config', { headers: authHeaders(token) });
    expect(res.ok()).toBeTruthy();
    const config = (await res.json()) as { config: unknown };
    const masked = collectMasked(config);
    expect(masked).toContain('config.keywordProviders.naver-api-hub.apiKey');
    expect(masked).toContain('config.keywordProviders.naver-api-hub.apiSecret');

    // Affiliate secret inputs render as password fields (Settings.tsx:362-363).
    await page.getByRole('tab', { name: '제휴 네트워크' }).click(); // TabsTrigger :283-286 (role=tab, Tabs.tsx:66-70)
    const tabpanel = page.getByRole('tabpanel');
    await expect(tabpanel.locator('input[type="password"]')).toHaveCount(2);

    // Save a non-secret value: PUT /api/config (Settings.tsx:220-232,
    // payload { app: { name, timezone } } per toServerPayload :76-77), then
    // verify it round-trips from the server (persisted to the workspace YAML).
    await page.getByRole('tab', { name: '일반' }).click(); // TabsTrigger :279-282
    const newName = `e2e-site-${Date.now()}`;
    await siteName.fill(newName);
    await page.getByRole('button', { name: '저장' }).click(); // :346-353
    await expect(page.getByText('저장됨')).toBeVisible(); // success toast (Settings.tsx:226, use-toast.tsx:71-89)

    const res2 = await page.request.get('/api/config', { headers: authHeaders(token) });
    expect(res2.ok()).toBeTruthy();
    const config2 = (await res2.json()) as { config: { app?: { name?: string } } };
    expect(config2.config.app?.name).toBe(newName);
  });
});
