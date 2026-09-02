import { test, expect } from '@playwright/test';
import { login } from './helpers/auth';

test.describe('keywords', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/keywords');
    // Keywords.tsx — <h1>키워드 리서치</h1>
    await expect(page.getByRole('heading', { level: 1, name: '키워드 리서치' })).toBeVisible();
  });

  // Research with a unique query: cache keys include the query
  // (NaverApiHubProvider.ts), so Date.now() uniqueness guarantees the
  // request reaches the mock instead of a cached entry. The blog-competitor
  // section renders the mock's echoed title.
  test('unique-query research shows mock echo title', async ({ page }) => {
    const query = `e2e-query-${Date.now()}`;
    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query);
    await page.getByRole('button', { name: '분석' }).click();

    // Result table row carries the queried keyword.
    const resultRow = page.getByRole('row').filter({ hasText: query });
    await expect(resultRow.first()).toBeVisible({ timeout: 25_000 });

    // 경쟁 블로그 section shows "[mock] <query> 블로그 N" titles
    // (mock.mjs produces the echo).
    await expect(page.getByText(`[mock] ${query} 블로그 1`)).toBeVisible({ timeout: 25_000 });
  });

  // 조건 조회 (Naver DataLab filter section below the search form). Unique query
  // again: the POST /api/keywords/trend request reaches the mock, which echoes
  // `request` back — so the echo line must show the exact startDate/endDate the
  // 최근 30일 preset resolves to. Expected dates are computed with the same
  // local-time logic as resolvePresetRange (today-29 ~ today, yyyy-mm-dd) so the
  // assertion is timezone-safe.
  test('search-trend condition query echoes the resolved preset range', async ({ page }) => {
    const query = `e2e-trend-${Date.now()}`;
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    const expectedStart = fmt(new Date(now.getTime() - 29 * DAY_MS));
    const expectedEnd = fmt(now);

    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query);
    await page.getByRole('button', { name: '검색어 트렌드' }).click(); // 소스
    await page.getByRole('button', { name: '최근 30일' }).click(); // 기간 preset
    await page.getByRole('button', { name: '월간' }).click(); // 집계주기
    await page.getByRole('button', { name: '조건 조회' }).click();

    // Result card with condition echo line.
    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(`${expectedStart} ~ ${expectedEnd}`)).toBeVisible();
    await expect(page.getByText('집계주기 월간')).toBeVisible();
  });

  // 쇼핑인사이트 path: criteria 키워드별 + category code required
  // (Keywords.tsx rejects an empty category). 카테고리는 select로 선택하고,
  // 미등록 코드는 "직접 입력…" 선택 시 병존하는 자유입력 Input으로 넣는다. The
  // mock's shared /shopping/v1/... handler echoes the keyword back as the group
  // title, rendered per-group in the 조건 조회 결과 card.
  test('shopping-insight condition query shows the keyword as group title', async ({ page }) => {
    const query = `e2e-shopping-${Date.now()}`;
    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query);
    await page.getByRole('button', { name: '쇼핑인사이트' }).click(); // 소스 toggle
    await page.getByRole('button', { name: '키워드별' }).click(); // 조회 기준
    await page.getByLabel('쇼핑 대분류 선택').selectOption({ label: '직접 입력…' }); // 자유입력 Input 병존 노출
    await page.getByPlaceholder('카테고리 코드 (예: 50000009)').fill('50000009'); // 카테고리
    await page.getByRole('button', { name: '조건 조회' }).click();

    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText(query).first()).toBeVisible({ timeout: 25_000 });
  });
});

// ── 쇼핑인사이트 개편(2026-08) 신규 e2e ──────────────────────────────────────
//
// 별도 describe로 분리해 로그인을 1회만 수행한다 — /api/auth/login은 분당 20회
// �이트리밋(src/web/server/middleware/auth.ts)이라 테스트마다 UI 로그인하면
// 스위트 후반(templates.spec)에서 상한을 넘는다. API 로그인으로 토큰을 발급받아
// addInitScript로 주입하면 AuthContext가 동일하게 /api/auth/me로 부트한다
// (AuthContext.tsx).
test.describe('keywords shopping-insight (신규 UI)', () => {
  let token: string;
  test.beforeAll(async ({ request }) => {
    const resp = await request.post('/api/auth/login', {
      data: {
        username: process.env.E2E_ADMIN_USER ?? 'e2e-admin',
        password: process.env.E2E_ADMIN_PASS ?? 'e2e-pass-1234',
      },
    });
    expect(resp.ok()).toBeTruthy();
    token = ((await resp.json()) as { token: string }).token;
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((t) => localStorage.setItem('token', t), token);
    await page.goto('/keywords');
    await expect(page.getByRole('heading', { level: 1, name: '키워드 리서치' })).toBeVisible();
  });

  // 소스 기본값: useState('shopping-insight') (Keywords.tsx). 선택 토글은
  // Button variant 'default'(bg-primary) vs 'outline'(border-input) —
  // ui/Button.tsx 클래스로 variant를 단언한다.
  test('쇼핑인사이트가 기본 소스로 선택되어 있다', async ({ page }) => {
    const shopping = page.getByRole('button', { name: '쇼핑인사이트' });
    await expect(shopping).toBeVisible();
    await expect(shopping).toHaveClass(/bg-primary/); // variant="default"
    const searchTrend = page.getByRole('button', { name: '검색어 트렌드' });
    await expect(searchTrend).toHaveClass(/border-input/); // variant="outline"
    await expect(searchTrend).not.toHaveClass(/bg-primary/);
  });

  // 분야 select에서 패션잡화(50000001) 선택 → criteria '분야별'은 query 불요
  // (Keywords.tsx trendNeedsQuery 조건화) — 조건 조회 버튼이 query 빈값으로
  // 활성화되고 POST /api/keywords/trend 본문 echo를 검증한다(이슈 #14).
  // 하단 TOP 20 카드는 삭제되었으므로 분야 선택은 재조회를 트리거하지 않는다.
  test('분야 선택 후 query 없이 조건 조회한다', async ({ page }) => {
    const trendBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/keywords/trend', async (route) => {
      trendBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });

    // query를 채우지 않는다 — 분야-level criteria('분야별')는 조건 조회 버튼이
    // query 없이도 활성화된다.
    await page.getByRole('button', { name: '분야별' }).click(); // query 불요 criteria
    await page.getByLabel('쇼핑 대분류 선택').selectOption({ label: '패션잡화' });

    // 결과 카드는 조건 조회 버튼을 눌러야 렌더 — query 빈값으로도 활성화·성공
    const searchButton = page.getByRole('button', { name: '조건 조회' });
    await expect(searchButton).toBeEnabled();
    await searchButton.click();
    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('조회기준 분야별')).toBeVisible();
    // POST /api/keywords/trend 본문 echo — query 없이 분야 코드만으로 조회
    const categoryBody = trendBodies.find((b) => b.criteria === 'category');
    expect(categoryBody?.category).toBe('50000001');
    expect(categoryBody?.query).toBe('');
  });

  // 년/월/일 select ×2(Keywords.tsx, aria-label "시작일/종료일 연도·월·일")로
  // 기간 지정 → 조건 조회 echo에 그대로 표시. 종료<시작이면 조회 버튼 disabled +
  // 인라인 경고(Keywords.tsx).
  test('년/월/일 select로 지정한 기간이 조건 조회 에코에 표시된다', async ({ page }) => {
    const query = `e2e-range-${Date.now()}`;
    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query);
    // shopping-insight는 criteria와 무관하게 분야 필수(Keywords.tsx)
    await page.getByLabel('쇼핑 대분류 선택').selectOption({ label: '패션잡화' });

    // 종료(7/1) < 시작(기본 최근 30일 시작일, today-29) → 비활성 + 경고
    await page.getByLabel('종료일 월').selectOption('7');
    await page.getByLabel('종료일 일').selectOption('1');
    await expect(page.getByText('종료일이 시작일보다 이릅니다')).toBeVisible();
    const searchButton = page.getByRole('button', { name: '조건 조회' });
    await expect(searchButton).toBeDisabled();

    // 시작 2026-08-01 ~ 종료 2026-08-29
    await page.getByLabel('시작일 연도').selectOption('2026');
    await page.getByLabel('시작일 월').selectOption('8');
    await page.getByLabel('시작일 일').selectOption('1');
    await page.getByLabel('종료일 연도').selectOption('2026');
    await page.getByLabel('종료일 월').selectOption('8');
    await page.getByLabel('종료일 일').selectOption('29');
    await expect(searchButton).toBeEnabled();
    await searchButton.click();

    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText('2026-08-01 ~ 2026-08-29')).toBeVisible();
  });

  // 조건 조회(shopping-insight) 시 fetchPieData(Keywords.tsx)가 criteria
  // device/gender/ages 3회를 병렬 조회하고 recharts PieChart 도넛 3개가 렌더된다
  // — ResponsiveContainer라 svg.recharts-surface(차트 svg)와
  // g.recharts-pie-sector로 단언한다.
  test('조건 조회 결과에 분야 비중 도넛 3개가 렌더된다', async ({ page }) => {
    const query = `e2e-donut-${Date.now()}`;
    await page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)').fill(query);
    await page.getByLabel('쇼핑 대분류 선택').selectOption({ label: '패션잡화' });
    await page.getByRole('button', { name: '조건 조회' }).click();

    // 패널 비중 도넛(자동조회 성공 시 렌더)과 구분되도록 결과 카드 범위로 단언
    const resultCard = page.locator('#keyword-trend-result');
    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(resultCard.getByText('기기별 비중', { exact: true })).toBeVisible({
      timeout: 25_000,
    });
    await expect(resultCard.getByText('성별 비중', { exact: true })).toBeVisible();
    await expect(resultCard.getByText('연령별 비중', { exact: true })).toBeVisible();
    await expect(resultCard.locator('svg.recharts-surface:has(g.recharts-pie-sector)')).toHaveCount(
      3,
    );
    await expect(resultCard.locator('g.recharts-pie-sector').first()).toBeVisible();
  });

  // ── 쇼핑인사이트 2단 select (이슈 #14) ──
  // 대분류 select(Keywords.tsx)에 children이 있는 분야를 선택하면 2분류 select가
  // 노출된다 — 코드표(GET /api/keywords/shopping-categories) 기반 2단 연쇄.
  test('children 있는 대분류 선택 시 2분류 select가 노출된다', async ({ page }) => {
    const parentSelect = page.getByLabel('쇼핑 대분류 선택');
    await expect(parentSelect).toBeVisible();
    await parentSelect.selectOption({ label: '패션잡화' });
    // 패션잡화(50000001)는 children 18개를 가져 2분류 select가 렌더된다
    await expect(page.getByLabel('쇼핑 2분류 선택')).toBeVisible();
  });

  // ── 우측 인기검색어 클릭 → 검색어 트렌드 조건 조회(이슈 #14) ──
  // 패널(GET /api/keywords/category-overview) 응답을 스텁해 우측 인기검색어 목록을
  // 만들고, 항목 클릭 → POST /api/keywords/trend(source 'search-trend',
  // query=클릭 검색어, 패널 기간/필터) → 하단 📈 조건 조회 결과 카드 렌더를 검증한다.
  test('우측 인기검색어 클릭 시 검색어 트렌드 조건 조회 결과가 렌더된다', async ({ page }) => {
    const trendBodies: Array<Record<string, unknown>> = [];
    await page.route('**/api/keywords/trend', async (route) => {
      trendBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.continue();
    });
    // 패널 오버뷰 스텁 — 첫 진입 자동조회(첫 리프 분야) 응답에 인기검색어를 심는다.
    // 스텁 후 리로드해 자동조회가 스텁을 타게 한다(beforeEach가 이미 goto했다).
    await page.route('**/api/keywords/category-overview*', async (route) => {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          category: '50021299',
          categoryName: '풀오버',
          categoryValid: true,
          clickTrend: [],
          shares: { device: [], gender: [], ages: [] },
          keywords: [
            {
              keyword: '여자 원피스',
              volume: 500,
              competition: 0.2,
              trend: 'rising',
              related: [],
              source: 'naver-api-hub',
            },
          ],
        }),
      });
    });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: '키워드 리서치' })).toBeVisible();

    // 우측 패널 인기검색어 — 스텁 응답의 키워드가 클릭 버튼으로 렌더된다
    const keywordButton = page.getByRole('button', { name: '여자 원피스' });
    await expect(keywordButton).toBeVisible({ timeout: 25_000 });

    await keywordButton.click();

    // 하단 📈 조건 조회 결과 카드(id=keyword-trend-result) — mock /search-trend
    // echo(groupName=키워드)로 그룹 title이 렌더된다
    const resultCard = page.locator('#keyword-trend-result');
    await expect(page.getByText('📈 조건 조회 결과')).toBeVisible({ timeout: 25_000 });
    await expect(resultCard.getByText('여자 원피스')).toBeVisible();

    // POST 본문 — 검색어 트렌드 소스 + 클릭 검색어 + 패널 기간(1m: today-30 ~ yesterday)
    const clickBody = trendBodies.find(
      (b) => b.source === 'search-trend' && b.query === '여자 원피스',
    );
    expect(clickBody).toBeTruthy();
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    expect(clickBody?.startDate).toBe(fmt(new Date(now.getTime() - 30 * DAY_MS)));
    expect(clickBody?.endDate).toBe(fmt(new Date(now.getTime() - DAY_MS)));

    // 필터 폼 동기화 — 소스가 검색어 트렌드로 바뀌고 query input에 검색어가 채워진다
    await expect(page.getByRole('button', { name: '검색어 트렌드' })).toHaveClass(/bg-primary/);
    await expect(page.getByPlaceholder('키워드 입력 (예: 무선청소기 추천)')).toHaveValue(
      '여자 원피스',
    );
  });
});
