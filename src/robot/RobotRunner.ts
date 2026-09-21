import { getLogger } from '@core/logger';
import type { DashboardApi } from './DashboardClient';
import { RobotAbort, ShutdownError, TransientError, describeError } from './errors';
import { EvidenceWriter } from './evidence';
import { kstIso } from './kst';
import type {
  CommandInbox,
  RobotEnv,
  ScriptRunner,
  Step,
  StepHandler,
  StepResult,
} from './steps/types';
import { stepsFor } from './steps/types';
import { STEP_HANDLERS, statusForOutcome } from './steps';
import type { CommandRow, CommandType, RunRow, RobotStore } from './RobotStore';
import type { Clock } from './RobotScheduler';
import type { Judge } from './Judge';
import type { HttpClient } from './http';
import type { Notifier } from './notify';
import type { RobotConfig } from './config';
import type { StepContext } from './steps/types';

const logger = getLogger('robot');

/** 테스트 전용: 단계 커밋 직후 프로세스가 죽은 것처럼 만든다(드라이버가 잡지 않는다). */
export class SimulatedCrash extends Error {
  constructor(step: string) {
    super(`simulated crash at ${step}`);
    this.name = 'SimulatedCrash';
  }
}

export const TRANSIENT_RETRY_BACKOFF_MS = [30_000, 120_000, 300_000];
export const MAX_STEPS_PER_DRIVE = 64;

/** 창을 지나면 이어서 진행하지 않고 끝내는 단계(설계 §5-2 마지막 행). */
const WINDOW_GUARDED_STEPS: Step[] = [
  'PREFLIGHT',
  'RESOLVE_ADS',
  'SNAPSHOT_LIVE',
  'GENERATE',
  'EDIT',
  'PLACE_ADS',
  'GATE',
];

/** 실행에 붙는 명령만 인박스에 보인다(전역 명령은 데몬 틱이 처리한다). */
const RUN_SCOPED_COMMANDS = new Set<CommandType>(['approve', 'reject', 'cancel', 'adopt']);

export interface RunnerDeps {
  store: RobotStore;
  config: RobotConfig;
  api: DashboardApi;
  judge: Judge;
  clock: Clock;
  http: HttpClient;
  notify: Notifier;
  runScript: ScriptRunner;
  env: RobotEnv;
  /** 증거 루트(`data/ops`) — 테스트는 임시 디렉터리를 준다. */
  evidenceRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  steps?: Record<Step, StepHandler>;
  signal?: AbortSignal;
  /** 단계를 커밋한 직후, 핸들러 실행 전에 호출된다(강제 종료 테스트 훅). */
  onStepCommitted?: (step: Step, run: RunRow) => void;
}

const defaultSleep = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/**
 * RobotRunner — 상태 머신 드라이버 + 크래시 복구(설계 §5-1·§5-2).
 *
 * 드라이버 규칙:
 * 1. 단계 실행 전에 `robot_runs.step`과 `robot_steps(started)`를 커밋한다.
 * 2. `RobotAbort` → `finish(aborted-<reason>)`.
 * 3. `TransientError`는 같은 단계를 30초·2분·5분 간격으로 최대 3회 재시도한다.
 *    단 `PUBLISHING`은 재시도하지 않고 `RECONCILE`로 간다.
 * 4. 그 밖의 예외는 `aborted-internal`(스택은 로그로만).
 * 5. `finish`면 `RECORD`를 최선 노력으로 실행한 뒤 status를 확정한다.
 * 6. `wait`면 `status='waiting'`으로 두고 스케줄 틱이 다시 부른다(프로세스를 붙잡지 않는다).
 */
export class RobotRunner {
  private readonly steps: Record<Step, StepHandler>;

  constructor(private readonly deps: RunnerDeps) {
    this.steps = deps.steps ?? STEP_HANDLERS;
  }

  /** 실행을 (재개 지점부터) 끝까지 몬다. `wait`면 `waiting` 상태로 돌아온다. */
  async drive(run: RunRow): Promise<RunRow> {
    const { store } = this.deps;
    const started = store.getRun(run.id) ?? run;

    if (this.isWindowPassed(started)) {
      logger.warn({ runId: started.id }, '슬롯 창을 지났습니다 — skipped-window-passed');
      return this.finish(started, 'skipped-window-passed', (started.step as Step) || 'PREFLIGHT');
    }

    let current = this.resumeStep(started);
    for (let guard = 0; guard < MAX_STEPS_PER_DRIVE; guard += 1) {
      const fresh = store.getRun(run.id);
      if (!fresh) throw new Error(`실행을 찾을 수 없습니다: ${run.id}`);
      if (fresh.status !== 'running' && fresh.status !== 'waiting') {
        return fresh; // 외부(대시보드·CLI)에서 종료됨
      }

      const result = await this.executeStep(fresh, current);
      if (result.patch) store.updateRun(fresh.id, result.patch);

      if (result.type === 'next') {
        current = result.step;
        store.updateRun(fresh.id, { status: 'running' });
        continue;
      }
      if (result.type === 'wait') {
        logger.info({ runId: fresh.id, step: current, reason: result.reason }, '단계 대기');
        return store.updateRun(fresh.id, { status: 'waiting' });
      }
      return this.finish(store.getRun(fresh.id) ?? fresh, result.outcome, current);
    }
    throw new Error(`단계 전이가 ${MAX_STEPS_PER_DRIVE}회를 넘었습니다 (run ${run.id})`);
  }

  /** 크래시 복구 매핑(§5-2). 마지막 커밋 단계에서 이어간다. */
  resumeStep(run: RunRow): Step {
    const step = (run.step || 'PREFLIGHT') as Step;
    if (!stepsFor(run.kind).includes(step)) return 'PREFLIGHT';
    if (step === 'PUBLISHING') {
      // publish를 다시 호출하지 않는다. 시작 시각이 없으면(커밋 직전 종료) 발행 전으로 본다.
      return run.publish_started_at ? 'RECONCILE' : 'GATE';
    }
    return step;
  }

  /**
   * 발행 실행이 슬롯 창(§5-6) 밖으로 밀렸는지. 수동 실행(`manual-*`)은 창 제한이 없다.
   * AWAIT_APPROVAL은 자체 제한 시간이 있으므로 제외한다.
   */
  private isWindowPassed(run: RunRow): boolean {
    if (run.kind !== 'publish') return false;
    if (run.slot.startsWith('manual-')) return false;
    const step = (run.step || '') as Step;
    if (!WINDOW_GUARDED_STEPS.includes(step)) return false;
    const slotMs = Date.parse(run.slot);
    if (Number.isNaN(slotMs)) return false;
    const windowEnd = slotMs + (this.deps.config.catchUpMinutes.publish ?? 0) * 60_000;
    return this.deps.clock.now().getTime() > windowEnd;
  }

  private createInbox(runId: string): CommandInbox {
    const { store, clock } = this.deps;
    return {
      pending: () =>
        store
          .listPendingCommands(50)
          .filter(
            (command: CommandRow) =>
              RUN_SCOPED_COMMANDS.has(command.type) &&
              (command.run_id === null || command.run_id === runId),
          ),
      resolve: (id, status, result) => store.markCommand(id, status, result, clock.now()),
    };
  }

  private createContext(run: RunRow): StepContext {
    return {
      run,
      config: this.deps.config,
      api: this.deps.api,
      judge: this.deps.judge,
      store: this.deps.store,
      evidence: new EvidenceWriter(run.id, this.deps.evidenceRoot),
      clock: this.deps.clock,
      commands: this.createInbox(run.id),
      signal: this.deps.signal ?? new AbortController().signal,
      http: this.deps.http,
      notify: this.deps.notify,
      runScript: this.deps.runScript,
      sleep: this.deps.sleep ?? defaultSleep,
      env: this.deps.env,
    };
  }

  /** 단계 1회 실행(재시도 포함). 예외는 규칙에 따라 결과로 바꾼다. */
  private async executeStep(run: RunRow, step: Step): Promise<StepResult> {
    const { store, clock } = this.deps;
    const attempt = store.countAttempts(run.id, step) + 1;
    const committed = store.updateRun(run.id, { step, status: 'running' });
    const stepId = store.startStep(run.id, step, attempt, clock.now());

    // 테스트 훅 — 핸들러 실행 전에 프로세스가 죽는 상황을 재현한다.
    this.deps.onStepCommitted?.(step, committed);

    const handler = this.steps[step];
    if (!handler) throw new Error(`단계 핸들러가 없습니다: ${step}`);

    try {
      const result = await handler(this.createContext(committed));
      store.finishStep(
        stepId,
        result.type === 'wait' ? 'waiting' : 'ok',
        result.type === 'finish'
          ? { outcome: result.outcome }
          : result.type === 'wait'
            ? { reason: result.reason }
            : { next: result.step },
        clock.now(),
      );
      return result;
    } catch (error) {
      store.finishStep(stepId, 'failed', { error: describeError(error) }, clock.now());

      if (error instanceof SimulatedCrash) throw error;
      if (error instanceof ShutdownError) throw error;

      if (error instanceof RobotAbort) {
        logger.warn({ runId: run.id, step, reason: error.reason }, '단계 중단');
        return { type: 'finish', outcome: `aborted-${error.reason}` };
      }

      if (error instanceof TransientError) {
        if (step === 'PUBLISHING') {
          logger.warn({ runId: run.id }, 'PUBLISHING 일시 오류 — 재시도 없이 RECONCILE');
          return { type: 'next', step: 'RECONCILE' };
        }
        if (attempt <= TRANSIENT_RETRY_BACKOFF_MS.length) {
          const backoff = TRANSIENT_RETRY_BACKOFF_MS[attempt - 1];
          logger.warn({ runId: run.id, step, attempt, backoff }, '일시 오류 — 같은 단계 재시도');
          await (this.deps.sleep ?? defaultSleep)(backoff);
          return this.executeStep(run, step);
        }
        return { type: 'finish', outcome: 'aborted-transient' };
      }

      logger.error(
        { runId: run.id, step, error: describeError(error), stack: (error as Error)?.stack },
        '단계 내부 오류',
      );
      return { type: 'finish', outcome: 'aborted-internal' };
    }
  }

  /** finish 처리: RECORD를 최선 노력으로 돌리고 status를 확정한다. */
  private async finish(run: RunRow, outcome: string, lastStep: Step): Promise<RunRow> {
    const { store, clock } = this.deps;
    let current = store.updateRun(run.id, { outcome });

    if (lastStep !== 'RECORD') {
      try {
        current = store.getRun(run.id) ?? current;
        await this.executeStep(current, 'RECORD');
      } catch (error) {
        if (error instanceof SimulatedCrash || error instanceof ShutdownError) throw error;
        logger.error({ runId: run.id, error: describeError(error) }, 'RECORD 최선 노력 실패');
      }
    }

    const finalRun = store.getRun(run.id) ?? current;
    const status = statusForOutcome(finalRun.outcome ?? outcome);
    logger.info({ runId: run.id, outcome: finalRun.outcome ?? outcome, status }, '실행 종료');
    return store.updateRun(run.id, {
      status,
      finished_at: finalRun.finished_at ?? kstIso(clock.now()),
    });
  }
}
