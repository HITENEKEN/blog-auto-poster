import * as path from 'path';
import { getConfigManager } from '@core/config';
import { createContentGeneratorFromConfig } from '@content/ContentGenerator';
import { getLogger } from '@core/logger';
import { loadRobotConfig, RobotConfigError, type RobotConfig } from './config';
import { applyCommandResult, decideCommand } from './commands';
import { DashboardClient, type DashboardApi } from './DashboardClient';
import { createHttpClient, type HttpClient } from './http';
import { createJudge, type Judge } from './Judge';
import { UNKNOWN_CODE_VERSION, resolveCodeVersion } from './codeVersion';
import { createKeepAwake, type KeepAwake } from './keepAwake';
import { ALREADY_RUNNING_MESSAGE, acquireLease, writeLease, LEASE_RENEW_MS } from './lease';
import { kstIso } from './kst';
import { createNotifier, type Notifier } from './notify';
import { RobotRunner, type RunnerDeps } from './RobotRunner';
import { RobotScheduler, SYSTEM_CLOCK, type Clock, type RobotSlotsConfig } from './RobotScheduler';
import { RobotStore, type RunRow } from './RobotStore';
import { createScriptRunner } from './scriptRunner';
import type { CommandRow } from './RobotStore';
import type { RobotEnv } from './steps/types';

const logger = getLogger('robot');

/** 스케줄 틱 주기. */
export const TICK_MS = 60_000;
/** 슬롯 시작 전 keepAwake를 켜는 여유. */
export const KEEP_AWAKE_LEAD_MS = 15 * 60_000;
/** 종료 신호를 받은 뒤 강제 종료까지의 유예. */
export const SHUTDOWN_GRACE_MS = 10_000;

export {
  LEASE_RENEW_MS,
  LEASE_TTL_MS,
  LEASE_STATE_KEY,
  readActiveLease,
  isProcessAlive,
} from './lease';
export type { LeaseState } from './lease';
export { SYSTEM_CLOCK } from './RobotScheduler';

export interface DaemonDeps {
  config: RobotConfig;
  store: RobotStore;
  api: DashboardApi;
  judge: Judge;
  http: HttpClient;
  notify: Notifier;
  clock: Clock;
  env: RobotEnv;
  evidenceRoot?: string;
  keepAwake?: KeepAwake;
  sleep?: (ms: number) => Promise<void>;
  onStepCommitted?: RunnerDeps['onStepCommitted'];
}

export interface TickSummary {
  commands: Array<{ id: number; type: string; result: string }>;
  ranRuns: string[];
  createdRuns: string[];
  missedSlots: string[];
  deferred: string[];
}

/** 데몬과 CLI `once`가 같은 러너 구성을 쓴다. */
export function createRunner(deps: DaemonDeps, signal?: AbortSignal): RobotRunner {
  return new RobotRunner({
    store: deps.store,
    config: deps.config,
    api: deps.api,
    judge: deps.judge,
    clock: deps.clock,
    http: deps.http,
    notify: deps.notify,
    runScript: createScriptRunner(),
    env: deps.env,
    evidenceRoot: deps.evidenceRoot,
    sleep: deps.sleep,
    signal,
    onStepCommitted: deps.onStepCommitted,
  });
}

/**
 * 상주 데몬(설계 §1 index.ts).
 *
 * 60초 틱: ① 명령 적용 ② `waiting` 실행 재확인 ③ 스케줄 슬롯 실행 생성 ④ 새 실행 구동.
 * 동시 실행은 1개다. SIGTERM/SIGINT를 받으면 새 단계를 시작하지 않고 현재 단계를 커밋한 뒤
 * 10초 안에 종료한다(`PUBLISHING` 중이어도 기다리지 않는다 — web 서버가 발행을 끝낸다).
 */
export class RobotDaemon {
  private readonly store: RobotStore;
  private readonly runner: RobotRunner;
  private readonly scheduler: RobotScheduler;
  private readonly keepAwake: KeepAwake;
  private readonly abort = new AbortController();
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private leaseTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: DaemonDeps) {
    this.store = deps.store;
    this.keepAwake = deps.keepAwake ?? createKeepAwake();
    this.runner = createRunner(deps, this.abort.signal);
    const slotsConfig: RobotSlotsConfig = {
      enabled: deps.config.enabled,
      mode: deps.config.mode,
      categories: deps.config.categories,
      slots: deps.config.slots,
      catchUpMinutes: deps.config.catchUpMinutes,
      jitterMinutes: deps.config.jitterMinutes,
      approvalTimeoutMinutes: deps.config.approvalTimeoutMinutes,
      codeVersion: deps.env.codeVersion,
    };
    this.scheduler = new RobotScheduler({
      store: deps.store,
      config: slotsConfig,
      clock: deps.clock,
      notifier: deps.notify,
    });
  }

  /** 틱 1회 — 테스트가 직접 부를 수 있게 분리했다. */
  async tickOnce(): Promise<TickSummary> {
    const summary: TickSummary = {
      commands: [],
      ranRuns: [],
      createdRuns: [],
      missedSlots: [],
      deferred: [],
    };
    const now = this.deps.clock.now();

    // ① 명령 적용 — 승인/거절은 단계 핸들러가 소비하도록 pending으로 남긴다.
    for (const command of this.store.listPendingCommands(50)) {
      const decision = decideCommand(command, this.store, this.deps.clock);
      applyCommandResult(this.store, command, decision, this.deps.clock);
      summary.commands.push({ id: command.id, type: command.type, result: decision.reason });
      if (decision.applied && command.type === 'run-now') {
        this.createManualRun(command, now);
      }
    }

    // ② 진행 중(waiting 포함) 실행 재확인 — 동시 실행 1개.
    for (const run of this.store.listActiveRuns()) {
      if (this.stopping) break;
      if (run.status === 'waiting') {
        const recheck = shouldRecheck(run, now);
        if (!recheck) continue;
      }
      const result = await this.runner.drive(run);
      summary.ranRuns.push(`${result.id}:${result.step}:${result.status}`);
    }

    // ③ 스케줄 슬롯 — 활성 실행이 남아 있으면 스케줄러가 알아서 다음 틱으로 미룬다.
    const tick = this.scheduler.tick();
    summary.missedSlots = tick.missed.map((run) => run.id);
    summary.deferred = tick.deferred.map((slot) => `${slot.kind}:${slot.slot}`);
    summary.createdRuns = tick.created.map((run) => run.id);

    // ④ 새로 만든 실행 구동
    for (const runId of summary.createdRuns) {
      if (this.stopping) break;
      const run = this.store.getRun(runId);
      if (!run || (run.status !== 'running' && run.status !== 'waiting')) continue;
      const result = await this.runner.drive(run);
      summary.ranRuns.push(`${result.id}:${result.step}:${result.status}`);
    }

    this.updateKeepAwake();
    return summary;
  }

  private createManualRun(command: CommandRow, now: Date): void {
    const payload = command.payload ?? {};
    const kind = payload.kind === 'publish' ? 'publish' : 'plan';
    const slot = `manual-${kstIso(now)}`;
    const { row } = this.store.createRun({
      kind,
      slot,
      trigger: 'manual',
      mode: this.deps.config.mode,
      step: 'PREFLIGHT',
      startedAt: now,
      codeVersion: this.deps.env.codeVersion,
    });
    this.store.updateRun(row.id, { step: 'PREFLIGHT' });
    if (payload.until === 'GATE') {
      // 드라이런: 게이트 직후 `skipped-dry-run`으로 끝나도록 GATE 단계가 읽는다.
      this.store.setState(`until:${row.id}`, 'GATE', now);
    }
  }

  private updateKeepAwake(): void {
    const now = this.deps.clock.now();
    const active = this.store.listActiveRuns().length > 0;
    const upcoming = this.scheduler.nextSlots(now, 1)[0];
    const soon = !!upcoming && Date.parse(upcoming.at) - now.getTime() <= KEEP_AWAKE_LEAD_MS;
    if (active || soon) {
      if (!this.keepAwake.isRunning()) this.keepAwake.start();
      return;
    }
    if (this.keepAwake.isRunning()) this.keepAwake.stop();
  }

  private renewLease(): void {
    writeLease(this.store, this.deps.clock.now());
  }

  /** 리스를 잡고 루프를 시작한다. 다른 인스턴스가 있으면 false를 돌려주고 아무것도 하지 않는다. */
  start(): boolean {
    if (!acquireLease(this.store, this.deps.clock)) {
      // 두 번째 인스턴스는 exit 0으로 조용히 끝난다(§5-7).
      return false;
    }
    this.leaseTimer = setInterval(() => this.renewLease(), LEASE_RENEW_MS);
    this.timer = setInterval(() => {
      void this.tickOnce().catch((error) => {
        logger.error({ error: String(error) }, '틱 실패');
      });
    }, TICK_MS);
    logger.info(
      { enabled: this.deps.config.enabled, mode: this.deps.config.mode, pid: process.pid },
      '로봇 데몬 시작',
    );
    return true;
  }

  /** 종료: 새 단계를 시작하지 않는다. 진행 중 단계는 커밋되고 10초 뒤 프로세스가 끝난다. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.timer = null;
    this.leaseTimer = null;
    this.keepAwake.stop();
    this.store.clearLease();
    logger.info('로봇 데몬 종료 중');
  }
}

/** `waiting` 실행 재확인 — 1분마다, RECONCILE은 `publish_started_at` 기준으로 더 자주 본다. */
export function shouldRecheck(run: RunRow, now: Date): boolean {
  const updatedMs = Date.parse(run.updated_at);
  if (Number.isNaN(updatedMs)) return true;
  const interval = run.step === 'RECONCILE' ? 30_000 : TICK_MS;
  return now.getTime() - updatedMs >= interval;
}

export interface StartOptions {
  configDir?: string;
  evidenceRoot?: string;
  /** 테스트 주입용 — 주면 설정 로드/DB 생성을 건너뛴다. */
  deps?: DaemonDeps;
}

/**
 * 실행 코드 버전 — cwd 우선, 'unknown'이면 코드가 놓인 저장소에서 재시도.
 * 임시 워크스페이스(테스트·드라이런)에서 돌려도 증거에 실제 커밋이 남는다(설계 §2-2).
 */
export async function resolveCodeVersionForRobot(
  cwd: string = process.cwd(),
  codeRoot: string = path.resolve(__dirname, '..', '..'),
): Promise<string> {
  const fromCwd = await resolveCodeVersion(cwd);
  if (fromCwd !== UNKNOWN_CODE_VERSION) return fromCwd;
  return resolveCodeVersion(codeRoot);
}

/** 프로덕션 의존성 묶음 — 데몬과 CLI가 공유한다. */
export async function buildProductionDeps(evidenceRoot?: string): Promise<DaemonDeps> {
  const config = await loadRobotConfig();
  const manager = getConfigManager();
  const blogId = String(
    manager.get('platforms.naver.blogId', '') || process.env.BLOG_POSTER_NAVER_BLOG_ID || '',
  );
  if (!blogId) throw new Error('platforms.naver.blogId가 설정되지 않았습니다');

  const env: RobotEnv = {
    repoRoot: process.cwd(),
    outputDir: String(manager.get('app.outputDir', `${process.cwd()}/output`)),
    dataDir: String(manager.get('app.dataDir', `${process.cwd()}/data`)),
    blogId,
    template: 'coupang-buying-guide',
    // git rev-parse HEAD (+dirty). 증거가 코드를 가리켜야 하므로 cwd가 저장소가 아니면
    // 로봇 코드가 있는 저장소(dist/robot/../../)에서 다시 시도한다.
    codeVersion: await resolveCodeVersionForRobot(),
    rssUrl: `https://rss.blog.naver.com/${blogId}.xml`,
    imageDailyLimit: Number(manager.get('imageProviders.budget.dailyImageLimit', 0)) || 0,
  };

  const generator = createContentGeneratorFromConfig();
  return {
    config,
    store: new RobotStore(config.dbPath),
    api: new DashboardClient({ apiBase: config.apiBase }),
    judge: createJudge(generator, {
      maxCallsPerRun: config.llm.maxCallsPerRun,
      timeoutSeconds: config.llm.timeoutSeconds,
    }),
    http: createHttpClient(),
    notify: createNotifier(),
    clock: SYSTEM_CLOCK,
    env,
    evidenceRoot,
  };
}

/** 프로덕션 엔트리 — 설정 검증 → 스토어 → 리스 → 루프. */
export async function startRobotDaemon(options: StartOptions = {}): Promise<number> {
  const deps = options.deps ?? (await buildProductionDeps(options.evidenceRoot));
  const daemon = new RobotDaemon(deps);

  if (!daemon.start()) {
    deps.store.close();
    logger.warn(`${ALREADY_RUNNING_MESSAGE} — 종료`);
    return 0;
  }

  const shutdown = (): void => {
    void daemon.stop().finally(() => {
      setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  return 0;
}

async function main(): Promise<void> {
  try {
    process.exitCode = await startRobotDaemon();
  } catch (error) {
    if (error instanceof RobotConfigError) {
      logger.error({ errors: error.errors }, '설정 검증 실패 — 기동 거부');
      process.exitCode = 1;
      return;
    }
    logger.error({ error: String(error) }, '데몬 기동 실패');
    process.exitCode = 1;
  }
}

// 직접 실행(`node dist/robot/index.js`)일 때만 데몬을 띄운다 — import 시에는 부작용이 없어야 한다.
if (require.main === module) {
  void main();
}
