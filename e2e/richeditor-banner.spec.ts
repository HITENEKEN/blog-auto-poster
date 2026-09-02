import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

// ── R6 에디터 광고 배너 e2e ──────────────────────────────────────────────────
//
// Posts 에디터(post 모드 RichEditor)에서 '+ 광고 배너' 툴바 버튼(RichEditor.tsx
// :219-229 — widgetKinds에 'ad-banner' 포함)으로 배너를 삽입하고, 저장된 본문
// HTML이 data-coupang-widget="ad-banner" 마커를 포함하는지 검증한다. 저장은
// 기존 포스트 HTML 흐름 그대로(PostEditor.tsx:71-76 PUT /api/posts/:id)이고,
// 발행 시 expandCoupangWidgets가 마커를 확장한다(CoupangWidgets.ts).

test.describe('editor ad-banner', () => {
  test('광고 배너 삽입 → 저장된 본문 HTML에 ad-banner 마커 포함', async ({ page }) => {
    test.setTimeout(120_000); // generate-from-keyword: template render + mock round-trips
    await login(page);
    const token = await getAuthToken(page);

    // Fresh draft — posts.spec.ts 패턴 재사용(외부 호출 없는 폴백 경로)
    const genRes = await page.request.post('/api/posts/generate-from-keyword', {
      headers: authHeaders(token),
      data: { keyword: '무선청소기', template: 'coupang-product-review' },
    });
    expect(genRes.status()).toBe(200);
    const genBody = (await genRes.json()) as { post?: { id?: string }; error?: string };
    const postId = genBody.post?.id;
    expect(postId, `generate-from-keyword failed: ${genBody.error}`).toBeTruthy();

    // 비동기 계약: POST는 id만 즉시 반환하고 실제 생성은 백그라운드에서 완료된다.
    // 에디터 진입/저장 전에 완료를 폴링으로 기다린다 — 배경 저장이 UI 저장 뒤에
    // 끼어들면 저장된 본문이 덮어써져 ad-banner 단언이 깨진다.
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

    // /posts/:id/edit — EditorImage 수정 이후로 정상 렌더(posts.spec.ts:112 전례)
    await page.goto(`/posts/${postId}/edit`);
    await expect(page.getByRole('heading', { name: '포스트 편집' })).toBeVisible();
    await expect(page.locator('.ProseMirror[contenteditable="true"]')).toBeVisible();

    // 툴바 '+ 광고 배너' 클릭 → 삽입 다이얼로그
    await page.getByRole('button', { name: '+ 광고 배너' }).click();
    const dialog = page.getByRole('dialog', { name: '광고 배너 삽입' });
    await expect(dialog).toBeVisible();

    // 배너 폼(RichEditor.tsx:260-293): 이미지 URL / 링크 URL / 대체텍스트·캡션
    await dialog.getByLabel('이미지 URL').fill('https://example.com/banner.jpg');
    await dialog.getByLabel('링크 URL').fill('https://link.coupang.com/a/e2e-banner');
    await dialog.getByLabel('대체텍스트·캡션 (선택)').fill('광고 상품 배너');
    await dialog.getByRole('button', { name: '삽입' }).click();

    // 에디터 칩(nodes.tsx addNodeView): 광고 배너 라벨 + 요약(props.text 우선) +
    // 이미지 썸네일 프리뷰(thumb.src = props.imageUrl)
    const chip = page.locator('.ProseMirror').getByText('광고 배너', { exact: true });
    await expect(chip).toBeVisible();
    await expect(
      page.locator('.ProseMirror img[src="https://example.com/banner.jpg"]'),
    ).toBeVisible();
    await expect(
      page.locator('.ProseMirror').getByText('광고 상품 배너', { exact: true }),
    ).toBeVisible();

    // 저장 → 토스트 확인
    await page.getByRole('button', { name: '저장' }).click();
    await expect(page.getByText('저장되었습니다')).toBeVisible({ timeout: 15_000 });

    // 저장된 본문 HTML에 ad-banner 마커 + props(url/imageUrl/text) 포함
    const getRes = await page.request.get(`/api/posts/${postId}`, {
      headers: authHeaders(token),
    });
    expect(getRes.status()).toBe(200);
    const { post } = (await getRes.json()) as { post: { content: string } };
    expect(post.content).toContain('data-coupang-widget="ad-banner"');
    // data-widget-props는 encodeURIComponent(JSON) — 도메인/파일명은 인코딩 후에도 식별 가능
    expect(post.content).toContain('link.coupang.com%2Fa%2Fe2e-banner');
    expect(post.content).toContain('example.com%2Fbanner.jpg');
  });
});
