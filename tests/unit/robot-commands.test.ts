import { spawn } from 'child_process';
import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { applyCommandResult, decideCommand } from '../../src/robot/commands';
import { RobotDaemon, startRobotDaemon } from '../../src/robot/index';
import {
  ALREADY_RUNNING_MESSAGE,
  acquireLease,
  readActiveLease,
  writeLease,
} from '../../src/robot/lease';
import { kstIso } from '../../src/robot/kst';
import type { CommandType } from '../../src/robot/RobotStore';
import { createScenario, type Scenario } from './robot-helpers';

/** 명령 의미론(설계 §5-7)과 리스. */

function enqueue(
  scenario: Scenario,
  type: CommandType,
  input: { runId?: string; payload?: Record<string, unknown> } = {},
) {
  const id = scenario.store.enqueueCommand({
    type,
    runId: input.runId,
    payload: input.payload,
    source: 'cli',
  });
  return scenario.store.getCommand(id)!;
}

function apply(scenario: Scenario, id: number) {
  const command = scenario.store.getCommand(id)!;
  const decision = decideCommand(command, scenario.store, scenario.clock);
  applyCommandResult(scenario.store, command, decision, scenario.clock);
  return { decision, command: scenario.store.getCommand(id)! };
}

describe('commands — 승인·거절', () => {
  it('AWAIT_APPROVAL + waiting이 아니면 거부한다', () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    const command = enqueue(scenario, 'approve', {
      runId: run.id,
      payload: { previewSha256: 'x' },
    });

    const { decision, command: stored } = apply(scenario, command.id);
    expect(decision.applied).toBe(false);
    expect(stored.status).toBe('refused');
    expect(stored.result).toContain('AWAIT_APPROVAL');
  });

  it('조건이 맞으면 소비되지 않고 pending으로 남아 단계 핸들러가 적용한다', () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    scenario.store.updateRun(run.id, {
      status: 'waiting',
      step: 'AWAIT_APPROVAL',
      preview_sha256: 'sha-1',
    });
    const command = enqueue(scenario, 'approve', {
      runId: run.id,
      payload: { previewSha256: 'sha-1' },
    });

    const { decision, command: stored } = apply(scenario, command.id);
    expect(decision.applied).toBe(true);
    expect(stored.status).toBe('pending');
  });

  it('runId가 없으면 거부한다', () => {
    const scenario = createScenario();
    const command = enqueue(scenario, 'reject');
    const { decision } = apply(scenario, command.id);
    expect(decision.applied).toBe(false);
    expect(decision.reason).toContain('runId');
  });
});

describe('commands — pause/resume/cancel/adopt', () => {
  it('pause/resume는 항상 적용되고 상태를 바꾼다', () => {
    const scenario = createScenario();
    expect(scenario.store.isPaused()).toBe(false);

    apply(scenario, enqueue(scenario, 'pause').id);
    expect(scenario.store.isPaused()).toBe(true);

    apply(scenario, enqueue(scenario, 'resume').id);
    expect(scenario.store.isPaused()).toBe(false);
  });

  it('cancel은 PUBLISHING 이전에만 적용된다', () => {
    const scenario = createScenario();
    const cancellable = scenario.createRun('publish');
    const applied = apply(scenario, enqueue(scenario, 'cancel', { runId: cancellable.id }).id);
    expect(applied.decision.applied).toBe(true);
    const cancelled = scenario.store.getRun(cancellable.id)!;
    expect(cancelled.status).toBe('aborted');
    expect(cancelled.outcome).toBe('aborted-cancelled');

    const publishingRun = scenario.createRun('publish', { slot: 'manual-2' });
    scenario.store.updateRun(publishingRun.id, {
      step: 'PUBLISHING',
      publish_started_at: kstIso(scenario.clock.now()),
    });
    const refused = apply(scenario, enqueue(scenario, 'cancel', { runId: publishingRun.id }).id);
    expect(refused.decision.applied).toBe(false);
    expect(refused.command.status).toBe('refused');
    expect(refused.command.result).toContain('비가역');
  });

  it('adopt는 aborted-unconfirmed 실행에만 적용되고 VERIFY부터 재개한다', () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');

    const refused = apply(
      scenario,
      enqueue(scenario, 'adopt', { runId: run.id, payload: { logNo: '123' } }).id,
    );
    expect(refused.decision.applied).toBe(false);

    scenario.store.updateRun(run.id, { status: 'aborted', outcome: 'aborted-unconfirmed' });
    const applied = apply(
      scenario,
      enqueue(scenario, 'adopt', {
        runId: run.id,
        payload: { logNo: '123456789', blogId: 'hiteneken' },
      }).id,
    );
    expect(applied.decision.applied).toBe(true);
    const adopted = scenario.store.getRun(run.id)!;
    expect(adopted.status).toBe('running');
    expect(adopted.step).toBe('VERIFY');
    expect(adopted.log_no).toBe('123456789');
    expect(adopted.url).toBe('https://blog.naver.com/hiteneken/123456789');
  });

  it('logNo가 없으면 adopt를 거부한다', () => {
    const scenario = createScenario();
    const run = scenario.createRun('publish');
    scenario.store.updateRun(run.id, { status: 'aborted', outcome: 'aborted-unconfirmed' });
    const { decision } = apply(scenario, enqueue(scenario, 'adopt', { runId: run.id }).id);
    expect(decision.applied).toBe(false);
    expect(decision.reason).toContain('logNo');
  });

  it('run-now는 데몬이 실행을 만들도록 접수만 한다', () => {
    const scenario = createScenario();
    const { decision } = apply(
      scenario,
      enqueue(scenario, 'run-now', { payload: { kind: 'plan' } }).id,
    );
    expect(decision.applied).toBe(true);
  });
});

describe('daemon — 명령 틱과 리스', () => {
  it('run-now 명령은 다음 틱에 manual 슬롯 실행을 만든다', async () => {
    const scenario = createScenario();
    const daemon = new RobotDaemon(scenario.daemonDeps());
    scenario.store.enqueueCommand({
      type: 'run-now',
      payload: { kind: 'plan' },
      source: 'dashboard',
    });

    const summary = await daemon.tickOnce();
    expect(summary.commands).toHaveLength(1);
    const manual = scenario.store.listRuns(10).filter((run) => run.trigger === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0].kind).toBe('plan');
    expect(manual[0].slot.startsWith('manual-')).toBe(true);
    await daemon.stop();
  });

  it('다른 인스턴스가 유효한 리스를 잡고 있으면 시작하지 않는다(exit 0)', async () => {
    const scenario = createScenario();
    // 살아 있는 다른 프로세스(부모)가 리스를 쥐고 있는 상황
    writeLease(scenario.store, scenario.clock.now(), process.ppid);
    expect(readActiveLease(scenario.store, scenario.clock.now())?.pid).toBe(process.ppid);

    const daemon = new RobotDaemon(scenario.daemonDeps());
    expect(daemon.start()).toBe(false);
    expect(scenario.store.getLease()?.pid).toBe(process.ppid);

    // 두 번째 인스턴스는 exit 0으로 조용히 끝난다.
    const exitCode = await startRobotDaemon({ deps: scenario.daemonDeps() });
    expect(exitCode).toBe(0);
    expect(ALREADY_RUNNING_MESSAGE).toBe('already running');
  });

  it('만료된 리스나 죽은 pid의 리스는 무시하고 잡는다', async () => {
    const scenario = createScenario();
    const expired = {
      pid: process.ppid,
      hostname: os.hostname(),
      startedAt: '2026-09-22T20:00:00+09:00',
      expiresAt: '2026-09-22T20:01:00+09:00',
    };
    scenario.store.setLease(expired, scenario.clock.now());
    expect(readActiveLease(scenario.store, scenario.clock.now())).toBeNull();
    expect(acquireLease(scenario.store, scenario.clock)).toBe(true);
    scenario.store.clearLease();

    const deadPid = await spawnDeadProcess();
    writeLease(scenario.store, scenario.clock.now(), deadPid);
    expect(readActiveLease(scenario.store, scenario.clock.now())).toBeNull();
    expect(acquireLease(scenario.store, scenario.clock)).toBe(true);
    expect(scenario.store.getLease()?.pid).toBe(process.pid);
  });

  it('stop하면 리스를 반납한다', async () => {
    const scenario = createScenario();
    const daemon = new RobotDaemon(scenario.daemonDeps());
    expect(daemon.start()).toBe(true);
    expect(scenario.store.getLease()?.pid).toBe(process.pid);
    await daemon.stop();
    expect(scenario.store.getLease()).toBeNull();
  });
});

/** 종료가 끝난 프로세스의 pid를 얻는다(살아 있지 않은 pid 확보). */
async function spawnDeadProcess(): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const child = spawn('node', ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  child.on('exit', () => {
    if (child.pid) resolve(child.pid);
  });
  return promise;
}
