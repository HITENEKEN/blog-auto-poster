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
    // Templates.tsx — <h1>템플릿 관리</h1>
    await expect(page.getByRole('heading', { level: 1, name: '템플릿 관리' })).toBeVisible();
  });

  // List view renders each template card + 이슈 #23 1-2: 한국어 표시 이름·필드 라벨,
  // and the coupang-product-review preview carries the affiliate disclosure with
  // no unimplemented stub text (이슈 #23 1-1).
  test('lists seeded templates with Korean display names, labels, disclosure', async ({ page }) => {
    for (const filename of SEED_FILENAMES) {
      await expect(page.getByText(filename, { exact: true })).toBeVisible();
    }
    // naver-coupang-review.hbs frontmatter displayName: "네이버 쿠팡 리뷰"
    await expect(
      page.getByRole('heading', { name: '네이버 쿠팡 리뷰', exact: true }),
    ).toBeVisible();
    // requiredFields productName / conclusion → 한국어 라벨 (templateFieldLabels.ts)
    const card = page.locator('div.grid > div', { hasText: 'naver-coupang-review.hbs' }).first();
    await expect(card.getByText('상품명', { exact: true })).toBeVisible();
    await expect(card.getByText('총평', { exact: true })).toBeVisible();

    const token = await getAuthToken(page);
    const res = await page.request.post('/api/templates/coupang-product-review/preview', {
      headers: authHeaders(token),
      data: {},
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { html?: string; error?: string };
    expect(body.error).toBeUndefined();
    expect(body.html).toContain('쿠팡 파트너스');
    expect(body.html).not.toContain('향후 구현 예정');
  });

  // 이슈 #23 1-3.1·1-3.2: 편집/신규 진입 모두 WYSIWYG가 기본이고 {{토큰}}이 칩으로 렌더된다.
  test('editor defaults to WYSIWYG for both edit and new', async ({ page }) => {
    // --- edit an existing template ---
    const card = page.locator('div.grid > div', { hasText: 'naver-coupang-review.hbs' }).first();
    await card.getByRole('button', { name: '편집' }).click();
    await expect(page.getByRole('heading', { name: /편집: naver-coupang-review/ })).toBeVisible();
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
    // source textarea is NOT the primary path
    await expect(page.locator('textarea')).toHaveCount(0);
    // Handlebars tokens render as non-editable atom chips showing the raw {{...}}.
    await expect(page.locator('.ProseMirror')).toContainText('{{productName}}');
    await expect(page.locator('.ProseMirror span[contenteditable="false"]').first()).toBeVisible();
    // frontmatter form prefilled with the Korean displayName
    await expect(page.getByPlaceholder('예: 네이버 쿠팡 리뷰')).toHaveValue('네이버 쿠팡 리뷰');

    // --- new template: WYSIWYG + seeded from the base template (총평 section) ---
    await page.getByRole('button', { name: '취소' }).click();
    await page.getByRole('button', { name: '새 템플릿' }).click();
    await expect(page.getByRole('heading', { name: '새 템플릿' })).toBeVisible();
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();
    await expect(page.locator('.ProseMirror')).toContainText('총평', { timeout: 10_000 });
  });

  // 이슈 #23 1-3: WYSIWYG 수정 → 저장 → 재진입 시 내용 보존(왕복 회귀) +
  // 저장 전 컴파일 검증(1-3.5): 깨진 Handlebars는 400으로 거부된다.
  test('WYSIWYG edit round-trips through save; broken Handlebars is rejected', async ({ page }) => {
    test.setTimeout(60_000);
    const token = await getAuthToken(page);

    // precompile guard: unclosed block → 400
    const broken = await page.request.post('/api/templates', {
      headers: authHeaders(token),
      data: {
        name: `e2e-broken-${Date.now()}`,
        content: '---\nname: "x"\n---\n<div>{{#if x}}<p>no close</div>',
      },
    });
    expect(broken.status()).toBe(400);
    expect(((await broken.json()) as { error?: string }).error).toMatch(
      /컴파일 실패|precompile|Handlebars/i,
    );

    // round-trip
    const name = `e2e-rt-${Date.now()}`;
    const raw = [
      '---',
      `name: "${name}"`,
      'displayName: "왕복 테스트"',
      'platforms: ["naver"]',
      'requiredFields:',
      '  - "productName"',
      'seo:',
      '  titleTemplate: "{{productName}} 추천"',
      '---',
      '',
      '<div class="rt"><h2>총평</h2><p>{{productName}} 기본 문구</p></div>',
      '',
    ].join('\n');
    const create = await page.request.post('/api/templates', {
      headers: authHeaders(token),
      data: { name, content: raw },
    });
    expect(create.ok()).toBeTruthy();

    await page.reload();
    const card = page.locator('div.grid > div', { hasText: `${name}.hbs` }).first();
    await card.getByRole('button', { name: '편집' }).click();
    const editor = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor).toContainText('기본 문구');

    await editor.getByText('기본 문구').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 편집됨');
    await expect(editor).toContainText('기본 문구 편집됨');
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByRole('heading', { level: 1, name: '템플릿 관리' })).toBeVisible();

    await card.getByRole('button', { name: '편집' }).click();
    const editor2 = page.locator('.ProseMirror[contenteditable="true"]');
    await expect(editor2).toContainText('편집됨');
    await expect(editor2).toContainText('{{productName}}');

    const res = await page.request.get(`/api/templates/${name}`, { headers: authHeaders(token) });
    const stored = (await res.json()) as { raw: string };
    expect(stored.raw).toContain('{{productName}}');
    expect(stored.raw).toContain('편집됨');

    await page.request.delete(`/api/templates/${name}`, { headers: authHeaders(token) });
  });

  // Create via UI advanced (source) mode, preview, then delete.
  test('creates via advanced source mode, previews, then deletes a template', async ({ page }) => {
    test.setTimeout(60_000);
    const name = `e2e-template-${Date.now()}`;

    await page.getByRole('button', { name: '새 템플릿' }).click();
    await expect(page.getByRole('heading', { name: '새 템플릿' })).toBeVisible();
    await page.getByPlaceholder('my-custom-template').fill(name);

    // Reveal the raw editor — frontmatter `name` must match the created filename
    // (the preview button calls POST /api/templates/<frontmatter name>/preview).
    await page.getByRole('button', { name: '고급(소스)' }).click();
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
    await page.getByRole('button', { name: '저장' }).click();
    const badge = page.getByText(`${name}.hbs`, { exact: true });
    await expect(badge).toBeVisible();
    const card = page.locator('div.grid > div', { hasText: name }).first();
    await card.getByRole('button', { name: '미리보기' }).click();
    await expect(page.getByRole('heading', { name: `미리보기: ${name}` })).toBeVisible();
    const frameBody = page.frameLocator('iframe[srcdoc]').locator('body');
    await expect(frameBody).toContainText('무선 청소기 프리미엄', { timeout: 20_000 });
    await page.getByRole('button', { name: '닫기' }).click();
    await expect(badge).toBeVisible();

    page.once('dialog', (dialog) => dialog.accept());
    await card.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(badge).toBeHidden();

    const token = await getAuthToken(page);
    const res = await page.request.get('/api/templates', { headers: authHeaders(token) });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { templates: Array<{ name?: string; filename?: string }> };
    const stillThere = body.templates.some((t) => t.name === name || t.filename === `${name}.hbs`);
    expect(stillThere).toBe(false);
    for (const filename of SEED_FILENAMES) {
      expect(body.templates.some((t) => t.filename === filename)).toBe(true);
    }
  });
});
