import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import { login, getAuthToken, authHeaders } from './helpers/auth';

/**
 * 자동 포스팅(로봇) 패널 — `src/web/client/src/pages/Scheduler.tsx`.
 *
 * 이 스펙은 **로봇 패널**을 검증한다(설계 documents/24-auto-poster-robot-design.md §7-3).
 * e2e 프로필에는 `data/robot.sqlite`가 없으므로 먼저 `installed:false` 빈 상태를 확인하고,
 * 픽스처 DB를 심은 뒤 새로고침해 상태·승인 카드·최근 실행이 렌더링되는지 본다.
 * PUT /api/scheduler/config는 이 페이지에서 절대 나가지 않는다(스케줄러 설정은 로봇과 무관).
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** e2e 워크스페이스(`/tmp/blog-poster-e2e.*`)를 찾는다 — serve.sh가 pid 파일을 남긴다. */
function findWorkspace(): string {
  // serve.sh는 mktemp -d /tmp/... 로 만든다(macOS의 os.tmpdir()은 /var/folders/... 이므로 둘 다 본다).
  const roots = ['/tmp', os.tmpdir()];
  const entries = roots
    .flatMap((root) => {
      try {
        return fs
          .readdirSync(root)
          .filter((name) => name.startsWith('blog-poster-e2e.'))
          .map((name) => path.join(root, name));
      } catch {
        return [];
      }
    })
    .filter((dir) => fs.existsSync(path.join(dir, 'pid')))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!entries.length) {
    throw new Error(
      'e2e 워크스페이스를 찾지 못했습니다 (e2e/serve.sh가 만든 /tmp/blog-poster-e2e.*)',
    );
  }
  return entries[0].dir;
}

/** 실제 RobotStore로 픽스처 DB를 만든다(스키마 중복 정의 방지). */
function seedRobotFixture(workspace: string): string {
  // 컴파일된 dist를 스크립트와 같은 별칭 해석기로 로드한다(@core/* 등).
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 컴파일된 dist를 런타임에 로드한다
  require(path.join(REPO_ROOT, 'scripts', 'path-alias.js'));
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 컴파일된 dist를 런타임에 로드한다
  const { RobotStore } = require(path.join(REPO_ROOT, 'dist', 'robot', 'RobotStore.js'));

  const dbPath = path.join(workspace, 'data', 'robot.sqlite');
  const store = new RobotStore(dbPath);
  const now = new Date();

  const awaiting = store.createRun({
    kind: 'publish',
    slot: '2026-09-22T21:12:00+09:00',
    trigger: 'schedule',
    mode: 'manual',
    step: 'AWAIT_APPROVAL',
    startedAt: new Date(now.getTime() - 5 * 60_000),
    codeVersion: 'e2e-fixture',
  });
  store.updateRun(awaiting.row.id, {
    status: 'waiting',
    step: 'AWAIT_APPROVAL',
    keyword: '트위드자켓',
    category_id: '50000000',
    draft_id: 'post-e2e-fixture',
    preview_sha256: 'e2e-preview-sha-0001',
    approval_requested_at: new Date(now.getTime() - 60_000).toISOString(),
    plan_id: 'plan-e2e-fixture',
  });
  store.insertPlan({
    id: 'plan-e2e-fixture',
    runId: awaiting.row.id,
    keyword: '트위드자켓',
    categoryId: '50000000',
    decision: { reason: '최근 4주 견조, 문서량 중앙값 이하', productCriteria: ['안감', '사이즈'] },
    publishSlot: '2026-09-22T21:12:00+09:00',
    status: 'consumed',
    createdAt: now,
  });

  const published = store.createRun({
    kind: 'publish',
    slot: '2026-09-19T21:14:00+09:00',
    trigger: 'schedule',
    mode: 'manual',
    step: 'RECORD',
    startedAt: new Date(now.getTime() - 3 * 86_400_000),
    codeVersion: 'e2e-fixture',
  });
  store.updateRun(published.row.id, {
    status: 'done',
    outcome: 'published',
    keyword: '울코트',
    log_no: '224411764637',
    url: 'https://blog.naver.com/hiteneken/224411764637',
    finished_at: new Date(now.getTime() - 3 * 86_400_000 + 3_600_000).toISOString(),
  });

  // 승인 카드의 광고 목록은 로봇 증거(ads/placement.json)에서 온다.
  const evidenceDir = path.join(workspace, 'data', 'ops', 'runs', awaiting.row.id, 'ads');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, 'placement.json'),
    JSON.stringify(
      {
        keyword: '트위드자켓',
        slots: [{ kind: 'single', afterSection: 3, adIds: ['ad-e2e-1'] }],
        ads: [
          { id: 'ad-e2e-1', productName: '울 혼방 트위드 자켓' },
          { id: 'ad-e2e-2', productName: '안감 트위드 자켓' },
        ],
        disclosure: true,
      },
      null,
      2,
    ),
  );

  store.close();
  return awaiting.row.id;
}

test.describe('robot panel', () => {
  test('미설치 빈 상태 → 설치된 상태(승인 카드·최근 실행)를 렌더링한다', async ({ page }) => {
    const statusRequests: string[] = [];
    const schedulerConfigPuts: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/robot/status')) statusRequests.push(req.url());
      if (req.method() === 'PUT' && req.url().includes('/api/scheduler/config')) {
        schedulerConfigPuts.push(req.url());
      }
    });

    // 재시도나 이전 실행이 남긴 픽스처를 지워 e2e 프로필의 '미설치' 상태를 보장한다.
    const workspace = findWorkspace();
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(workspace, 'data', `robot.sqlite${suffix}`), { force: true });
    }

    await login(page);
    await page.goto('/scheduler');

    // 1) e2e 프로필에는 robot.sqlite가 없다 → installed:false 빈 상태
    await expect(page.getByRole('heading', { level: 1, name: '자동 포스팅' })).toBeVisible();
    await expect(page.getByText('로봇이 아직 실행되지 않았습니다')).toBeVisible();
    await expect(page.getByText('npm run robot -- status')).toBeVisible();
    // 미설치 상태에서는 명령 버튼이 없다(빈 상태만 렌더링).
    await expect(page.getByRole('button', { name: '기획 지금 실행' })).toHaveCount(0);
    expect(statusRequests.length).toBeGreaterThan(0);

    // 2) 픽스처 DB를 심고 새로고침 → 설치된 상태
    const runId = seedRobotFixture(workspace);
    expect(runId).toContain('publish');
    await page.reload();

    await expect(page.getByText('활성화:')).toBeVisible();
    await expect(page.getByText('켜짐').or(page.getByText('꺼짐'))).toBeVisible();
    await expect(page.getByText('manual', { exact: true })).toBeVisible();
    await expect(page.getByText('다음 슬롯')).toBeVisible();
    await expect(page.getByText('현재 실행')).toBeVisible();
    // 현재 실행 카드와 최근 실행 표에 같은 단계명이 나오므로 표 셀로 특정한다.
    await expect(page.getByRole('cell', { name: 'AWAIT_APPROVAL' })).toBeVisible();
    await expect(page.getByText('트위드자켓').first()).toBeVisible();

    // 승인 카드: 미리보기 sha · 선정 근거 · 광고 목록 · 승인/거절
    await expect(page.getByText(/승인 대기 — 트위드자켓/)).toBeVisible();
    await expect(page.getByText(/sha256 e2e-preview-sha-/)).toBeVisible();
    await expect(page.getByText('최근 4주 견조, 문서량 중앙값 이하')).toBeVisible();
    await expect(page.getByText('광고 상품 (2개)')).toBeVisible();
    await expect(page.getByText('울 혼방 트위드 자켓 (ad-e2e-1)')).toBeVisible();
    await expect(page.getByRole('button', { name: '승인하고 발행' })).toBeVisible();
    await expect(page.getByRole('button', { name: '거절' })).toBeVisible();

    // 최근 실행 표: 성공 1건 + 승인 대기 1건
    await expect(page.getByText('최근 실행 (2건)')).toBeVisible();
    await expect(page.getByRole('link', { name: '224411764637' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'published' })).toBeVisible();

    // 3) API 수준 계약
    const token = await getAuthToken(page);
    const statusRes = await page.request.get('/api/robot/status', { headers: authHeaders(token) });
    expect(statusRes.ok()).toBeTruthy();
    const status = (await statusRes.json()) as {
      installed: boolean;
      mode: string;
      nextSlots: Array<{ kind: string; at: string }>;
      awaitingApproval: { id: string; step: string } | null;
      recent: Array<{ id: string }>;
    };
    expect(status.installed).toBe(true);
    expect(status.mode).toBe('manual');
    expect(status.nextSlots.length).toBeGreaterThan(0);
    expect(status.awaitingApproval?.step).toBe('AWAIT_APPROVAL');
    expect(status.recent.length).toBeGreaterThanOrEqual(2);

    const detailRes = await page.request.get(`/api/robot/runs/${runId}`, {
      headers: authHeaders(token),
    });
    expect(detailRes.ok()).toBeTruthy();
    const detail = (await detailRes.json()) as {
      placement: { ads: Array<{ id: string }> } | null;
      plan: { decision: { reason: string } } | null;
    };
    expect(detail.placement?.ads.map((ad) => ad.id)).toEqual(['ad-e2e-1', 'ad-e2e-2']);
    expect(detail.plan?.decision.reason).toContain('견조');

    // 이 페이지는 스케줄러 설정을 절대 건드리지 않는다.
    expect(schedulerConfigPuts).toHaveLength(0);
  });
});
