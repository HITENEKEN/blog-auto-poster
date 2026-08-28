import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

// Seed templates are a copy of repo templates/ (serve.sh) — coupang-product-review
// and siblings are therefore guaranteed filenames.
const SEED_FILENAMES = [
  'coupang-product-review.hbs',
  'coupang-partner-review.hbs',
  'coupang-comparison-guide.hbs',
  'coupang-buying-guide.hbs',
  'naver-coupang-review.hbs',
];

test.describe('templates', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/templates');
    // Templates.tsx:153 — <h1>템플릿 관리</h1>
    await expect(page.getByRole('heading', { level: 1, name: '템플릿 관리' })).toBeVisible();
  });

  // List view renders each template card with a filename Badge (Templates.tsx:183-185).
  test('lists seeded templates from templates dir', async ({ page }) => {
    for (const filename of SEED_FILENAMES) {
      await expect(page.getByText(filename, { exact: true })).toBeVisible();
    }
  });

  // Create via UI (POST /api/templates, Templates.tsx:97), preview via UI
  // (POST /api/templates/:name/preview, :138), delete via UI (DELETE, :113),
  // then verify removal through GET /api/templates.
  test('creates, previews, then deletes a template', async ({ page }) => {
    test.setTimeout(60_000);
    const name = `e2e-template-${Date.now()}`;

    // --- Create (editor view) ---
    await page.getByRole('button', { name: '새 템플릿' }).click(); // Templates.tsx:156-158
    await expect(page.getByRole('heading', { name: '새 템플릿' })).toBeVisible(); // :333-336
    const nameInput = page.getByPlaceholder('my-custom-template'); // :347-351
    await nameInput.fill(name); // input sanitizes to [a-zA-Z0-9-_] — our name is safe
    // Replace the default body: the frontmatter name MUST match the created
    // filename, because the preview button calls POST /api/templates/<frontmatter
    // name>/preview (Templates.tsx:134-138 — it uses t.name, not the filename;
    // the default "new-template" frontmatter would point at a nonexistent file).
    await page
      .locator('textarea')
      .fill(
        [
          '---',
          `name: "${name}"`,
          'platforms: ["tistory"]',
          'requiredFields:',
          '  - "productName"',
          '---',
          '',
          '<div><h1>{{productName}}</h1></div>',
          '',
        ].join('\n'),
      );
    await page.getByRole('button', { name: '저장' }).click(); // :369-376
    // Back on list view; the new card shows its filename Badge (:183-185).
    const badge = page.getByText(`${name}.hbs`, { exact: true });
    await expect(badge).toBeVisible();
    const card = page.locator('div.grid > div', { hasText: name }).first();
    await card.getByRole('button', { name: '미리보기' }).click(); // :220-228
    await expect(page.getByRole('heading', { name: `미리보기: ${name}` })).toBeVisible(); // :273-276
    const frameBody = page.frameLocator('iframe[srcdoc]').locator('body'); // :315-320
    await expect(frameBody).toContainText('무선 청소기 프리미엄', { timeout: 20_000 });
    await page.getByRole('button', { name: '닫기' }).click(); // :292-295
    await expect(badge).toBeVisible();

    // --- Delete (Templates.tsx:110-118 uses window.confirm — accept it) ---
    page.once('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: '삭제', exact: true }).click(); // :248-256
    await expect(badge).toBeHidden();

    // GET /api/templates must no longer contain the template.
    const token = await getAuthToken(page);
    const res = await page.request.get('/api/templates', { headers: authHeaders(token) });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { templates: Array<{ name?: string; filename?: string }> };
    const stillThere = body.templates.some((t) => t.name === name || t.filename === `${name}.hbs`);
    expect(stillThere).toBe(false);
    // Seed templates untouched.
    for (const filename of SEED_FILENAMES) {
      expect(body.templates.some((t) => t.filename === filename)).toBe(true);
    }
  });

  // Plan Verification 2: coupang-product-review.hbs must carry the affiliate
  // disclosure (쿠팡 파트너스) at the top of its body
  // (templates/coupang-product-review.hbs:39-41). Checked on the raw preview
  // response — the UI preview dialog (iframe srcdoc) renders the same html.
  test('coupang-product-review preview response includes the affiliate disclosure', async ({
    page,
  }) => {
    const token = await getAuthToken(page);
    const res = await page.request.post('/api/templates/coupang-product-review/preview', {
      headers: authHeaders(token),
      data: {},
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { html?: string; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.html).toContain('쿠팡 파트너스');
  });
});
