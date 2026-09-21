import type { CommandRow, RunKind, RunRow, RobotStore } from '../RobotStore';
import type { Clock } from '../RobotScheduler';
import type { DashboardApi } from '../DashboardClient';
import type { HttpClient } from '../http';
import type { Judge } from '../Judge';
import type { RobotConfig } from '../config';
import type { EvidenceWriter } from '../evidence';
import type { Notifier } from '../notify';

/** 실행 상태 머신의 단계(설계 §5-1). 순서가 곧 진행 순서다. */
export type Step =
  | 'PREFLIGHT'
  | 'SNAPSHOT_LIVE'
  | 'RESEARCH'
  | 'SELECT_TOPIC'
  | 'REQUEST_ADS'
  | 'RESOLVE_ADS'
  | 'GENERATE'
  | 'EDIT'
  | 'PLACE_ADS'
  | 'GATE'
  | 'AWAIT_APPROVAL'
  | 'PUBLISHING'
  | 'RECONCILE'
  | 'VERIFY'
  | 'RECORD';

/** 스킬 §10의 outcome 어휘. `aborted-<reason>` 형태를 포함한다. */
export type Outcome = string;

export type StepResult =
  | { type: 'next'; step: Step; patch?: Partial<RunRow> }
  | { type: 'wait'; recheckAfterMs: number; reason: string; patch?: Partial<RunRow> }
  | { type: 'finish'; outcome: Outcome; patch?: Partial<RunRow> };

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

/** 이 실행에 해당하는 미처리 명령만 보이게 하는 인박스(소비는 드라이버가 표시한다). */
export interface CommandInbox {
  pending(): CommandRow[];
  resolve(id: number, status: 'applied' | 'refused', result: string): void;
}

/** 자식 프로세스 실행기(검증 스크립트) — 테스트에서 가짜로 바꾼다. */
export interface ScriptRunner {
  run(
    command: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<{ code: number; stdout: string; stderr: string }>;
}

/** 단계 핸들러가 쓰는 실행 환경(경로·식별자) — 값은 기동 시 한 번 해석한다. */
export interface RobotEnv {
  repoRoot: string;
  outputDir: string;
  dataDir: string;
  blogId: string;
  /** 초안 생성 템플릿(스킬 §6 예시와 동일) */
  template: string;
  codeVersion: string;
  /** 네이버 RSS 주소 */
  rssUrl: string;
  /** `imageProviders.budget.dailyImageLimit` (0 = 무제한) */
  imageDailyLimit: number;
}

export interface StepContext {
  run: RunRow;
  config: RobotConfig;
  api: DashboardApi;
  judge: Judge;
  store: RobotStore;
  evidence: EvidenceWriter;
  clock: Clock;
  commands: CommandInbox;
  signal: AbortSignal;
  http: HttpClient;
  notify: Notifier;
  runScript: ScriptRunner;
  /** 폴링 간격 대기 — 테스트에서는 즉시 반환하는 함수를 주입한다. */
  sleep: (ms: number) => Promise<void>;
  env: RobotEnv;
}

/** 실행 종류별로 진입 가능한 단계(테스트·검증용 표). */
export const PLAN_STEPS: Step[] = [
  'PREFLIGHT',
  'SNAPSHOT_LIVE',
  'RESEARCH',
  'SELECT_TOPIC',
  'REQUEST_ADS',
  'RECORD',
];

export const PUBLISH_STEPS: Step[] = [
  'PREFLIGHT',
  'RESOLVE_ADS',
  'SNAPSHOT_LIVE',
  'GENERATE',
  'EDIT',
  'PLACE_ADS',
  'GATE',
  'AWAIT_APPROVAL',
  'PUBLISHING',
  'RECONCILE',
  'VERIFY',
  'RECORD',
];

export function stepsFor(kind: RunKind): Step[] {
  return kind === 'plan' ? PLAN_STEPS : PUBLISH_STEPS;
}
