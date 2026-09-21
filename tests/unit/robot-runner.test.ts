import * as fs from 'fs';
import { describe, expect, it } from 'vitest';
import { SimulatedCrash } from '../../src/robot/RobotRunner';
import { kstIso } from '../../src/robot/kst';
import { PUBLISH_STEPS, PLAN_STEPS } from '../../src/robot/steps/types';
import {
  BASE_RSS,
  RSS_URL,
  createFakeApi,
  createScenario,
  driveToEnd,
  evidenceFile,
  rssXml,
  stepNames,
  type Scenario,
} from './robot-helpers';

/** 발행 뒤에 확정되는 단계 — 첫 drive에서 도달하려면 승인 명령이 미리 필요하다. */
const POST_APPROVAL_STEPS = ['PUBLISHING', 'RECONCILE', 'VERIFY', 'RECORD'];
const NEW_LOG_NO = '222222222222';
const RSS_WITH_NEW_POST = rssXml([
  { title: '무선청소기 고르는 기준', logNo: '111111111111', pubDate: '2026-08-01T12:00:00+09:00' },
  { title: '트위드 자켓 구매 가이드', logNo: NEW_LOG_NO, pubDate: '2026-09-22T21:12:00+09:00' },
]);

/**
 * RobotRunner 크래시·재개 전수 테스트(설계 §8, §5-2).
 *
 * 강제 종료는 `onStepCommitted` 훅에서 `SimulatedCrash`를 던져 재현한다 — 단계가
 * 커밋된 직후(핸들러 실행 전) 프로세스가 죽는 상황과 같다. 재개는 **새 러너 인스턴스**로
 * 같은 스토어·증거 디렉터리를 사용해 수행한다(재기동과 동일).
 *
 * 불변식:
 * - publish 호출 횟수는 실행당 최대 1
 * - PUBLISHING 재진입(publish_started_at 있음) → publish 0회, RECONCILE로
 * - 발행 타임아웃·5xx → 재시도 0회
 * - 게이트 위반 → publish 0회
 */

function crashAt(scenario: Scenario, target: string) {
  return {
    onStepCommitted: (step: string, run: { id: string }) => {
      if (step !== target) return;
      if (step === 'PUBLISHING') {
        // 실제 강제 종료는 발행 응답을 기다리는 중에 일어난다 → 시작 시각이 이미 커밋돼 있다.
        scenario.store.updateRun(run.id, { publish_started_at: kstIso(scenario.clock.now()) });
      }
      throw new SimulatedCrash(step);
    },
  };
}

describe('RobotRunner — 발행 실행 강제 종료/재개', () => {
  for (const step of PUBLISH_STEPS) {
    it(`${step}에서 강제 종료 후 재개해도 publish 호출은 최대 1회`, async () => {
      const scenario = createScenario();
      const run = scenario.createRun('publish');
      if (POST_APPROVAL_STEPS.includes(step)) {
        // sha 없는 승인 → AWAIT_APPROVAL이 통과시킨다(sha 검사는 별도 테스트가 담당).
        scenario.store.enqueueCommand({
          type: 'approve',
          runId: run.id,
          payload: {},
          source: 'cli',
        });
      }

      const first = scenario.makeRunner(crashAt(scenario, step));
      await expect(first.drive(run)).rejects.toBeInstanceOf(SimulatedCrash);

      const committed = scenario.store.getRun(run.id)!;
      expect(committed.step).toBe(step);

      if (['RECONCILE', 'VERIFY', 'RECORD'].includes(step)) {
        // 발행 직전 스냅샷에는 없던 글이 뒤늦게 RSS에 나타난 상황
        scenario.http.setBody(RSS_URL, RSS_WITH_NEW_POST);
      }
      const finalRun = await driveToEnd(scenario, run.id);
      expect(scenario.api.publishCalls).toBeLessThanOrEqual(1);
      if (step === 'PUBLISHING') {
        // PUBLISHING 재진입은 publish를 부르지 않고 RSS 화해로 간다(§5-2).
        expect(scenario.api.publishCalls).toBe(0);
        expect(stepNames(scenario, run.id)).toContain('RECONCILE');
      }
      expect(['done', 'skipped', 'aborted']).toContain(finalRun.status);
    });
  }

  for (const step of PLAN_STEPS) {
    it(`기획 실행: ${step}에서 강제 종료 후 재개해 끝난다`, async () => {
      const scenario = createScenario();
      const run = scenario.createRun('plan', { plan: false });

      const first = scenario.makeRunner(crashAt(scenario, step));
      await expect(first.drive(run)).rejects.toBeInstanceOf(SimulatedCrash);

      const finalRun = await driveToEnd(scenario, run.id);
      expect(scenario.api.publishCalls).toBe(0);
      expect(['done', 'skipped', 'aborted']).toContain(finalRun.status);
    });
  }

  it('PUBLISHING 커밋 직전 종료(publish_started_at 없음)는 GATE로 되돌아간다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    scenario.store.enqueueCommand({ type: 'approve', runId: run.id, payload: {}, source: 'cli' });
    const crash = scenario.makeRunner({
      onStepCommitted: (step: string) => {
        if (step === 'PUBLISHING') throw new SimulatedCrash(step);
      },
    });
    await expect(crash.drive(run)).rejects.toBeInstanceOf(SimulatedCrash);
    expect(scenario.store.getRun(run.id)!.publish_started_at ?? null).toBeNull();

    // 재개: GATE부터 — 발행은 승인 뒤에만 일어난다.
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.status).toBe('done');
    expect(scenario.api.publishCalls).toBe(1);
  });
});

describe('RobotRunner — 발행 결과 처리', () => {
  it('발행 타임아웃은 재호출 없이 RECONCILE로 간다', async () => {
    const scenario = createScenario({ api: createFakeApi({ publishMode: 'timeout' }) });
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);

    expect(scenario.api.publishCalls).toBe(1);
    expect(stepNames(scenario, run.id)).toContain('RECONCILE');
    expect(finalRun.outcome).toBe('aborted-unconfirmed');
  });

  it('발행 5xx도 재호출 없이 RECONCILE로 간다', async () => {
    const scenario = createScenario({ api: createFakeApi({ publishMode: '500' }) });
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);

    expect(scenario.api.publishCalls).toBe(1);
    expect(finalRun.outcome).toBe('aborted-unconfirmed');
  });

  it('409 PREVIEW_CHANGED는 발행 전이므로 GATE로 되돌린다', async () => {
    const scenario = createScenario({ api: createFakeApi({ publishMode: '409' }) });
    const run = scenario.createRun('publish');
    scenario.store.enqueueCommand({ type: 'approve', runId: run.id, payload: {}, source: 'cli' });

    const after = await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);

    // GATE를 다시 통과하고 승인을 다시 요구한다(발행은 시작되지 않았다).
    expect(
      stepNames(scenario, run.id).filter((step) => step === 'GATE').length,
    ).toBeGreaterThanOrEqual(2);
    expect(after.step).toBe('AWAIT_APPROVAL');
    expect(after.publish_started_at ?? null).toBeNull();
    expect(scenario.api.publishCalls).toBe(1);
  });

  it('게이트 위반이면 publish를 한 번도 부르지 않는다', async () => {
    const scenario = createScenario({
      api: createFakeApi({
        gateResult: {
          ok: false,
          violations: [{ code: 'AD_COUNT', message: '광고 블록 수 불일치' }],
          previewSha256: 'sha-1',
        },
      }),
    });
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);

    expect(scenario.api.publishCalls).toBe(0);
    expect(finalRun.outcome).toBe('aborted-gate');
    expect(finalRun.status).toBe('aborted');
  });
});

describe('RobotRunner — 승인 대기', () => {
  it('승인하면 PUBLISHING으로 진행해 발행한다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');

    // GATE까지 진행시킨 뒤 대기 상태를 확인한다.
    const runner = scenario.makeRunner();
    let current = await runner.drive(run);
    while (current.status === 'running' && current.step !== 'AWAIT_APPROVAL') {
      current = await runner.drive(current);
    }
    expect(current.step).toBe('AWAIT_APPROVAL');
    expect(current.status).toBe('waiting');
    expect(scenario.api.publishCalls).toBe(0);

    scenario.store.enqueueCommand({
      type: 'approve',
      runId: run.id,
      payload: { previewSha256: current.preview_sha256 },
      source: 'cli',
    });
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.outcome).toBe('published');
    expect(scenario.api.publishCalls).toBe(1);
  });

  it('승인 sha가 다르면 거부하고 GATE로 돌아간다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const runner = scenario.makeRunner();
    let current = await runner.drive(run);
    while (current.status === 'running' && current.step !== 'AWAIT_APPROVAL') {
      current = await runner.drive(current);
    }

    const commandId = scenario.store.enqueueCommand({
      type: 'approve',
      runId: run.id,
      payload: { previewSha256: 'different-sha' },
      source: 'cli',
    });
    await runner.drive(scenario.store.getRun(run.id)!);
    // 거부된 승인은 GATE를 다시 통과해 AWAIT_APPROVAL로 돌아온다(재확인 요구).
    expect(stepNames(scenario, run.id).filter((s) => s === 'GATE').length).toBeGreaterThanOrEqual(
      2,
    );
    const command = scenario.store.getCommand(commandId)!;
    expect(command.status).toBe('refused');
    expect(command.result).toContain('previewSha256');
  });

  it('거절하면 aborted-rejected로 끝나고 발행하지 않는다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const runner = scenario.makeRunner();
    let current = await runner.drive(run);
    while (current.status === 'running' && current.step !== 'AWAIT_APPROVAL') {
      current = await runner.drive(current);
    }

    scenario.store.enqueueCommand({
      type: 'reject',
      runId: run.id,
      payload: { reason: '이미지가 맞지 않음' },
      source: 'cli',
    });
    const finalRun = await runner.drive(scenario.store.getRun(run.id)!);
    expect(finalRun.outcome).toBe('aborted-rejected');
    expect(finalRun.status).toBe('aborted');
    expect(scenario.api.publishCalls).toBe(0);
  });

  it('120분이 지나면 aborted-no-approval로 끝난다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const runner = scenario.makeRunner();
    let current = await runner.drive(run);
    while (current.status === 'running' && current.step !== 'AWAIT_APPROVAL') {
      current = await runner.drive(current);
    }
    scenario.clock.advanceMs(121 * 60_000);
    const finalRun = await runner.drive(scenario.store.getRun(run.id)!);
    expect(finalRun.outcome).toBe('aborted-no-approval');
    expect(scenario.api.publishCalls).toBe(0);
  });
});

describe('RobotRunner — RECONCILE', () => {
  async function driveUntilReconcile(scenario: Scenario, runId: string): Promise<void> {
    const runner = scenario.makeRunner();
    let current = scenario.store.getRun(runId)!;
    for (let i = 0; i < 30; i += 1) {
      current = await runner.drive(current);
      if (current.step === 'RECONCILE' || current.status === 'done' || current.status === 'aborted')
        return;
      if (current.step === 'AWAIT_APPROVAL') {
        scenario.store.enqueueCommand({
          type: 'approve',
          runId,
          payload: { previewSha256: current.preview_sha256 },
          source: 'cli',
        });
      }
    }
    throw new Error('RECONCILE에 도달하지 못했습니다');
  }

  it('신규 1건이면 VERIFY로 진행한다', async () => {
    const scenario = createScenario({ rssReflectsPublish: false });
    const run = scenario.createRun('publish');
    await driveUntilReconcile(scenario, run.id);
    expect(scenario.store.getRun(run.id)!.log_no ?? null).toBeNull();

    scenario.http.setBody(
      RSS_URL,
      rssXml([
        {
          title: '무선청소기 고르는 기준',
          logNo: '111111111111',
          pubDate: '2026-08-01T12:00:00+09:00',
        },
        {
          title: '트위드 자켓 구매 가이드',
          logNo: NEW_LOG_NO,
          pubDate: '2026-09-22T21:12:00+09:00',
        },
      ]),
    );
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.log_no).toBe(NEW_LOG_NO);
    expect(finalRun.url).toBe(`https://blog.naver.com/hiteneken/${NEW_LOG_NO}`);
    expect(finalRun.outcome).toBe('published');
  });

  it('RSS가 늦게 반영되면(+1분 없음 → +3분 있음) 그때 확정한다', async () => {
    const scenario = createScenario({ rssReflectsPublish: false });
    const run = scenario.createRun('publish');
    await driveUntilReconcile(scenario, run.id);

    // +1분: 아직 신규 0건 → wait
    scenario.clock.advanceMs(60_000);
    const waiting = await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    expect(waiting.status).toBe('waiting');
    expect(waiting.step).toBe('RECONCILE');

    // +3분: 반영됨
    scenario.clock.advanceMs(120_000);
    scenario.http.setBody(
      RSS_URL,
      rssXml([
        {
          title: '무선청소기 고르는 기준',
          logNo: '111111111111',
          pubDate: '2026-08-01T12:00:00+09:00',
        },
        {
          title: '트위드 자켓 구매 가이드',
          logNo: NEW_LOG_NO,
          pubDate: '2026-09-22T21:12:00+09:00',
        },
      ]),
    );
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.log_no).toBe(NEW_LOG_NO);
    expect(finalRun.outcome).toBe('published');
  });

  it('신규 0건이고 +6분이 지나면 aborted-unconfirmed', async () => {
    const scenario = createScenario({ rssReflectsPublish: false });
    const run = scenario.createRun('publish');
    await driveUntilReconcile(scenario, run.id);
    scenario.clock.advanceMs(7 * 60_000);
    const finalRun = await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    expect(finalRun.outcome).toBe('aborted-unconfirmed');
    expect(scenario.api.publishCalls).toBe(1);
  });

  it('신규 2건 이상이면 aborted-multiple', async () => {
    const scenario = createScenario({ rssReflectsPublish: false });
    const run = scenario.createRun('publish');
    await driveUntilReconcile(scenario, run.id);
    scenario.http.setBody(
      RSS_URL,
      rssXml([
        {
          title: '무선청소기 고르는 기준',
          logNo: '111111111111',
          pubDate: '2026-08-01T12:00:00+09:00',
        },
        {
          title: '트위드 자켓 구매 가이드',
          logNo: NEW_LOG_NO,
          pubDate: '2026-09-22T21:12:00+09:00',
        },
        { title: '다른 글', logNo: '333333333333', pubDate: '2026-09-22T21:13:00+09:00' },
      ]),
    );
    const finalRun = await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    expect(finalRun.outcome).toBe('aborted-multiple');
  });
});

describe('RobotRunner — 기록·증거', () => {
  it('성공 실행은 증거 패킷과 publish-log 1줄을 남기고 재실행해도 중복 기록하지 않는다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.outcome).toBe('published');

    expect(evidenceFile(scenario, run.id, 'run.json')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'report.md')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'robot/steps.json')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'ads/placement.json')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'ads/resolve.json')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'draft/generated.html')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'publish/response.json')).toBeTruthy();
    expect(evidenceFile(scenario, run.id, 'verify/results.json')).toBeTruthy();

    // RECORD를 한 번 더 돌려도 로그는 늘지 않는다.
    await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    const logPath = `${scenario.evidenceRoot}/publish-log.jsonl`;
    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).runId).toBe(run.id);
  });

  it('run.json은 종료 상태·시각을 담고, RECORD를 다시 돌려도 같은 값을 유지한다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.status).toBe('done');

    const first = JSON.parse(evidenceFile(scenario, run.id, 'run.json')!) as {
      status: string;
      outcome: string;
      finished_at: string;
      code_version: string;
    };
    expect(first.status).toBe('done');
    expect(first.outcome).toBe('published');
    expect(first.finished_at).toBe(finalRun.finished_at);
    expect(first.code_version).toBe('test-sha');

    // 반드시 최선 노력 RECORD가 다시 돌 수 있다 — 같은 status/finished_at 이어야 한다.
    await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    const second = JSON.parse(evidenceFile(scenario, run.id, 'run.json')!) as {
      status: string;
      outcome: string;
      finished_at: string;
    };
    expect(second.status).toBe(first.status);
    expect(second.outcome).toBe(first.outcome);
    expect(second.finished_at).toBe(first.finished_at);

    // report.md의 결과/종료 줄도 run.json과 일치한다
    const report = evidenceFile(scenario, run.id, 'report.md')!;
    expect(report).toContain(`- 결과: published (status done)`);
    expect(report).toContain(`종료: ${first.finished_at}`);
  });

  it('중단 실행의 run.json도 aborted로 확정된다', async () => {
    const scenario = createScenario({
      api: createFakeApi({
        gateResult: {
          ok: false,
          violations: [{ code: 'AD_COUNT', message: '불일치' }],
          previewSha256: 'sha-1',
        },
      }),
    });
    const run = scenario.createRun('publish');
    await driveToEnd(scenario, run.id);
    const packet = JSON.parse(evidenceFile(scenario, run.id, 'run.json')!) as {
      status: string;
      finished_at: string | null;
    };
    expect(packet.status).toBe('aborted');
    expect(packet.finished_at).toBeTruthy();
  });

  it('RECORD는 발행된 실행의 사용 소재만 markUsed로 반영하고, 두 번 돌아도 광고당 1회다', async () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);
    expect(finalRun.outcome).toBe('published');

    // placement.json의 광고 2건에 대해 정확히 1회씩
    expect(scenario.api.markUsedCalls).toEqual(['ad-1', 'ad-2']);
    expect(scenario.store.getState(`ads-used:${run.id}:ad-1`)).toBeTruthy();

    // RECORD 재실행(크래시 재개·최선 노력 경로)에도 이중 집계되지 않는다
    await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    await scenario.makeRunner().drive(scenario.store.getRun(run.id)!);
    expect(scenario.api.markUsedCalls).toEqual(['ad-1', 'ad-2']);
    // 광고 사용 기록은 경고가 아니다(실패했을 때만 ads-mark-used-failed가 붙는다).
    expect((finalRun.warnings ?? []).filter((w) => w.startsWith('ad-used:'))).toEqual([]);
    expect((finalRun.warnings ?? []).filter((w) => w.startsWith('ads-mark-used-failed:'))).toEqual(
      [],
    );
  });

  it('건너뜀·중단 실행은 markUsed를 한 번도 부르지 않는다', async () => {
    const skipped = createScenario({
      api: createFakeApi({
        gateResult: {
          ok: false,
          violations: [{ code: 'AD_COUNT', message: '광고 수 불일치' }],
          previewSha256: 'sha-1',
        },
      }),
    });
    const skippedRun = skipped.createRun('publish');
    const aborted = await driveToEnd(skipped, skippedRun.id);
    expect(aborted.outcome).toBe('aborted-gate');
    expect(skipped.api.markUsedCalls).toEqual([]);

    const planning = createScenario();
    const planRun = planning.createRun('plan', { plan: false });
    await driveToEnd(planning, planRun.id);
    expect(planning.api.markUsedCalls).toEqual([]);
  });

  it('markUsed 실패는 진짜 경고로 남는다', async () => {
    const scenario = createScenario({ api: createFakeApi({ markUsedFails: true }) });
    const run = scenario.createRun('publish');
    const finalRun = await driveToEnd(scenario, run.id);

    expect(finalRun.warnings?.some((w) => w.startsWith('ads-mark-used-failed:'))).toBe(true);
    // 실패한 광고는 상태 키를 남기지 않아 다음 시도에서 재시도된다
    expect(scenario.store.getState(`ads-used:${run.id}:ad-1`)).toBeNull();
  });

  it('기획 실행은 소재가 충분하면 planned, 부족하면 planned-needs-ads로 끝난다', async () => {
    const enough = createScenario();
    const plannedRun = enough.createRun('plan', { plan: false });
    const planned = await driveToEnd(enough, plannedRun.id);
    expect(planned.outcome).toBe('planned');

    const lacking = createScenario({
      api: createFakeApi({ adCounts: { '50000000': 1, 트위드자켓: 1 } }),
    });
    const needsAdsRun = lacking.createRun('plan', { plan: false });
    const needsAds = await driveToEnd(lacking, needsAdsRun.id);
    expect(needsAds.outcome).toBe('planned-needs-ads');
    expect(lacking.api.calls).toContain('createAdRequest');
    expect(lacking.notify.messages.join(' ')).toContain('소재 요청');
  });

  it('BASE_RSS 픽스처는 중복 제목을 갖지 않는다(테스트 전제 확인)', () => {
    expect(BASE_RSS).not.toContain('트위드자켓');
  });
});
