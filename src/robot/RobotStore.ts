import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';
import { kstCompact, kstIso, kstWeekRange } from './kst';

const logger = getLogger('robot');

/**
 * `data/robot.sqlite` — 로봇 전용 상태 저장소(설계 §2-2).
 *
 * 접근 권한(§2-2 표):
 * - robot_runs/steps/plans: 로봇이 쓰고, web·CLI는 읽는다.
 * - robot_commands: web·CLI가 INSERT만, 로봇이 상태를 갱신한다.
 * - robot_state: 로봇이 쓰고, web·CLI는 읽는다.
 *
 * 스키마는 설계 §2-2의 SQL을 그대로 쓴다. web 서버는 이 파일이 없으면
 * `installed:false`를 돌려주므로 로봇이 한 번도 돌지 않아도 된다.
 */

export type RunKind = 'plan' | 'publish';
export type RunStatus = 'running' | 'waiting' | 'done' | 'skipped' | 'aborted';
export type RunTrigger = 'schedule' | 'catch-up' | 'manual';
export type RunMode = 'manual' | 'auto';
export type StepStatus = 'started' | 'ok' | 'failed' | 'waiting';
export type PlanStatus = 'planned' | 'consumed' | 'carried' | 'expired';
export type CommandType =
  'approve' | 'reject' | 'pause' | 'resume' | 'run-now' | 'cancel' | 'adopt';
export type CommandStatus = 'pending' | 'applied' | 'refused';

export interface RunRow {
  id: string;
  kind: RunKind;
  slot: string;
  trigger: RunTrigger;
  mode: RunMode;
  status: RunStatus;
  step: string;
  plan_id?: string | null;
  keyword?: string | null;
  category_id?: string | null;
  draft_id?: string | null;
  preview_sha256?: string | null;
  approval_requested_at?: string | null;
  publish_started_at?: string | null;
  log_no?: string | null;
  url?: string | null;
  outcome?: string | null;
  warnings: string[];
  code_version?: string | null;
  started_at: string;
  updated_at: string;
  finished_at?: string | null;
}

export interface StepRow {
  id: number;
  run_id: string;
  step: string;
  attempt: number;
  status: StepStatus;
  detail?: Record<string, unknown> | null;
  started_at: string;
  finished_at?: string | null;
}

export interface PlanRow {
  id: string;
  run_id: string;
  keyword: string;
  category_id?: string | null;
  decision: Record<string, unknown>;
  publish_slot: string;
  ad_request_id?: string | null;
  status: PlanStatus;
  created_at: string;
}

export interface CommandRow {
  id: number;
  type: CommandType;
  run_id?: string | null;
  payload?: Record<string, unknown> | null;
  source: 'dashboard' | 'cli';
  status: CommandStatus;
  result?: string | null;
  created_at: string;
  applied_at?: string | null;
}

export interface LeaseInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  expiresAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS robot_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  slot TEXT NOT NULL,
  trigger TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL,
  plan_id TEXT,
  keyword TEXT,
  category_id TEXT,
  draft_id TEXT,
  preview_sha256 TEXT,
  approval_requested_at TEXT,
  publish_started_at TEXT,
  log_no TEXT,
  url TEXT,
  outcome TEXT,
  warnings TEXT,
  code_version TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (kind, slot)
);

CREATE TABLE IF NOT EXISTS robot_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES robot_runs(id),
  step TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS robot_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  category_id TEXT,
  decision TEXT NOT NULL,
  publish_slot TEXT NOT NULL,
  ad_request_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS robot_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  run_id TEXT,
  payload TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);

CREATE TABLE IF NOT EXISTS robot_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_robot_runs_status ON robot_runs(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_robot_runs_outcome ON robot_runs(outcome, finished_at);
CREATE INDEX IF NOT EXISTS idx_robot_steps_run ON robot_steps(run_id, id);
CREATE INDEX IF NOT EXISTS idx_robot_plans_slot ON robot_plans(publish_slot, status);
CREATE INDEX IF NOT EXISTS idx_robot_commands_status ON robot_commands(status, id);
`;

const RUN_COLUMNS = [
  'id',
  'kind',
  'slot',
  'trigger',
  'mode',
  'status',
  'step',
  'plan_id',
  'keyword',
  'category_id',
  'draft_id',
  'preview_sha256',
  'approval_requested_at',
  'publish_started_at',
  'log_no',
  'url',
  'outcome',
  'warnings',
  'code_version',
  'started_at',
  'updated_at',
  'finished_at',
] as const;

const PLAN_COLUMNS = [
  'keyword',
  'category_id',
  'decision',
  'publish_slot',
  'ad_request_id',
  'status',
] as const;

type SqlValue = string | number | null;

function toRunRow(raw: Record<string, unknown>): RunRow {
  let warnings: string[] = [];
  if (typeof raw.warnings === 'string' && raw.warnings) {
    try {
      const parsed = JSON.parse(raw.warnings);
      if (Array.isArray(parsed)) warnings = parsed.map((v) => String(v));
    } catch {
      warnings = [String(raw.warnings)];
    }
  }
  return { ...(raw as unknown as RunRow), warnings };
}

function toStepRow(raw: Record<string, unknown>): StepRow {
  let detail: Record<string, unknown> | null = null;
  if (typeof raw.detail === 'string' && raw.detail) {
    try {
      detail = JSON.parse(raw.detail) as Record<string, unknown>;
    } catch {
      detail = { raw: String(raw.detail) };
    }
  }
  return { ...(raw as unknown as StepRow), detail };
}

function toPlanRow(raw: Record<string, unknown>): PlanRow {
  let decision: Record<string, unknown> = {};
  if (typeof raw.decision === 'string' && raw.decision) {
    try {
      decision = JSON.parse(raw.decision) as Record<string, unknown>;
    } catch {
      decision = { raw: String(raw.decision) };
    }
  }
  return { ...(raw as unknown as PlanRow), decision };
}

function toCommandRow(raw: Record<string, unknown>): CommandRow {
  let payload: Record<string, unknown> | null = null;
  if (typeof raw.payload === 'string' && raw.payload) {
    try {
      payload = JSON.parse(raw.payload) as Record<string, unknown>;
    } catch {
      payload = { raw: String(raw.payload) };
    }
  }
  return { ...(raw as unknown as CommandRow), payload };
}

export class RobotStore {
  private readonly db: Database.Database;

  constructor(dbPath: string, options: { readonly?: boolean } = {}) {
    const dir = path.dirname(path.resolve(dbPath));
    if (options.readonly) {
      // web 서버·CLI `status`는 파일이 없으면 열지 않고 호출부가 installed:false를 돌려준다.
      this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
      logger.debug({ dbPath }, 'robot store opened read-only');
      return;
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    logger.debug({ dbPath }, 'robot store opened');
  }

  close(): void {
    try {
      this.db.close();
    } catch (error) {
      logger.debug({ error: String(error) }, 'robot store close failed');
    }
  }

  // -------------------------------------------------------------------------
  // 실행(runs)
  // -------------------------------------------------------------------------

  /** 실행을 만든다. UNIQUE(kind, slot) 위반이면 기존 행을 그대로 돌려준다(created=false). */
  createRun(input: {
    kind: RunKind;
    slot: string;
    trigger: RunTrigger;
    mode: RunMode;
    step: string;
    startedAt?: Date;
    codeVersion?: string;
  }): { row: RunRow; created: boolean } {
    const now = input.startedAt ?? new Date();
    const iso = kstIso(now);
    const id = this.freeRunId(`${kstCompact(now)}-${input.kind}`, input.kind, input.slot);
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO robot_runs
           (id, kind, slot, trigger, mode, status, step, warnings, code_version, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', ?, '[]', ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.slot,
        input.trigger,
        input.mode,
        input.step,
        input.codeVersion ?? null,
        iso,
        iso,
      );

    const row = this.getRunBySlot(input.kind, input.slot);
    if (!row) throw new Error(`run insert failed for ${input.kind}/${input.slot}`);
    return { row, created: info.changes === 1 };
  }

  /**
   * 같은 초에 두 실행이 만들어지면(수동 실행 2회, 수동+슬롯 동시) 기본 id가 충돌한다.
   * 그때는 접미사를 붙여 서로 다른 행으로 남긴다 — UNIQUE(kind, slot)은 그대로 유지된다.
   */
  private freeRunId(base: string, kind: RunKind, slot: string): string {
    let candidate = base;
    for (let i = 2; i < 100; i += 1) {
      const existing = this.db
        .prepare('SELECT kind, slot FROM robot_runs WHERE id = ?')
        .get(candidate) as { kind: string; slot: string } | undefined;
      if (!existing) return candidate;
      if (existing.kind === kind && existing.slot === slot) return candidate;
      candidate = `${base}-${i}`;
    }
    return `${base}-${Date.now()}`;
  }

  getRun(id: string): RunRow | null {
    const raw = this.db.prepare('SELECT * FROM robot_runs WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return raw ? toRunRow(raw) : null;
  }

  getRunBySlot(kind: RunKind, slot: string): RunRow | null {
    const raw = this.db
      .prepare('SELECT * FROM robot_runs WHERE kind = ? AND slot = ?')
      .get(kind, slot) as Record<string, unknown> | undefined;
    return raw ? toRunRow(raw) : null;
  }

  /** 미완료 실행 — 크래시 복구(§5-2) 대상. */
  listActiveRuns(): RunRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM robot_runs WHERE status IN ('running','waiting') ORDER BY started_at ASC",
      )
      .all() as Record<string, unknown>[];
    return rows.map(toRunRow);
  }

  listRuns(limit = 10): RunRow[] {
    const rows = this.db
      .prepare('SELECT * FROM robot_runs ORDER BY started_at DESC LIMIT ?')
      .all(limit) as Record<string, unknown>[];
    return rows.map(toRunRow);
  }

  /** 마지막으로 발행에 성공한 실행 — 연속 카테고리 제한(§11)에 쓴다. */
  lastPublishedRun(): RunRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM robot_runs
          WHERE outcome IN ('published','published-with-warnings')
          ORDER BY COALESCE(finished_at, updated_at) DESC LIMIT 1`,
      )
      .get() as Record<string, unknown> | undefined;
    return raw ? toRunRow(raw) : null;
  }

  /** 이번 주(KST 월–일) 로봇 발행 수 — 주간 상한(§5-4)의 한 축. */
  countPublishedThisWeek(now: Date = new Date()): number {
    const { startMs, endMs } = kstWeekRange(now);
    const rows = this.db
      .prepare(
        `SELECT finished_at FROM robot_runs
          WHERE outcome IN ('published','published-with-warnings') AND finished_at IS NOT NULL`,
      )
      .all() as Array<{ finished_at: string }>;
    return rows.filter((r) => {
      const ms = Date.parse(r.finished_at);
      return !Number.isNaN(ms) && ms >= startMs && ms < endMs;
    }).length;
  }

  /** 미해결(사람 이관) 실행 수 — `doctor`·대시보드에 쓴다. */
  countUnresolved(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM robot_runs
          WHERE outcome LIKE 'aborted-%' AND (url IS NULL OR url = '')`,
      )
      .get() as { n: number };
    return row?.n ?? 0;
  }

  updateRun(id: string, patch: Partial<RunRow>): RunRow {
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    for (const key of RUN_COLUMNS) {
      if (key === 'id' || !(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      assignments.push(`${key} = ?`);
      if (key === 'warnings') values.push(JSON.stringify(value ?? []));
      else if (value === undefined || value === null) values.push(null);
      else values.push(String(value));
    }
    assignments.push('updated_at = ?');
    values.push(kstIso(new Date()));
    values.push(id);
    this.db.prepare(`UPDATE robot_runs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    const row = this.getRun(id);
    if (!row) throw new Error(`run not found: ${id}`);
    return row;
  }

  // -------------------------------------------------------------------------
  // 단계(steps)
  // -------------------------------------------------------------------------

  startStep(runId: string, step: string, attempt: number, now: Date = new Date()): number {
    const info = this.db
      .prepare(
        `INSERT INTO robot_steps (run_id, step, attempt, status, started_at) VALUES (?, ?, ?, 'started', ?)`,
      )
      .run(runId, step, attempt, kstIso(now));
    return Number(info.lastInsertRowid);
  }

  finishStep(
    id: number,
    status: StepStatus,
    detail?: Record<string, unknown>,
    now: Date = new Date(),
  ): void {
    this.db
      .prepare('UPDATE robot_steps SET status = ?, detail = ?, finished_at = ? WHERE id = ?')
      .run(status, detail ? JSON.stringify(detail) : null, kstIso(now), id);
  }

  listSteps(runId: string): StepRow[] {
    const rows = this.db
      .prepare('SELECT * FROM robot_steps WHERE run_id = ? ORDER BY id ASC')
      .all(runId) as Record<string, unknown>[];
    return rows.map(toStepRow);
  }

  countAttempts(runId: string, step: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM robot_steps WHERE run_id = ? AND step = ?')
      .get(runId, step) as { n: number };
    return row?.n ?? 0;
  }

  /** 마지막으로 시작한 단계가 아직 끝나지 않았는지(크래시 복구 판단). */
  lastStep(runId: string): StepRow | null {
    const raw = this.db
      .prepare('SELECT * FROM robot_steps WHERE run_id = ? ORDER BY id DESC LIMIT 1')
      .get(runId) as Record<string, unknown> | undefined;
    return raw ? toStepRow(raw) : null;
  }

  // -------------------------------------------------------------------------
  // 계획(plans)
  // -------------------------------------------------------------------------

  insertPlan(plan: {
    id: string;
    runId: string;
    keyword: string;
    categoryId?: string | null;
    decision: Record<string, unknown>;
    publishSlot: string;
    adRequestId?: string | null;
    status: PlanStatus;
    createdAt?: Date;
  }): PlanRow {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO robot_plans
           (id, run_id, keyword, category_id, decision, publish_slot, ad_request_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.runId,
        plan.keyword,
        plan.categoryId ?? null,
        JSON.stringify(plan.decision ?? {}),
        plan.publishSlot,
        plan.adRequestId ?? null,
        plan.status,
        kstIso(plan.createdAt ?? new Date()),
      );
    const row = this.getPlan(plan.id);
    if (!row) throw new Error(`plan insert failed: ${plan.id}`);
    return row;
  }

  getPlan(id: string): PlanRow | null {
    const raw = this.db.prepare('SELECT * FROM robot_plans WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return raw ? toPlanRow(raw) : null;
  }

  /**
   * 이 발행 슬롯이 소비할 계획. 우선순위:
   * 1) 같은 슬롯의 `planned` → 2) 다른 슬롯의 `planned`(가장 오래된 것, 수동 실행
   * `manual-*`은 슬롯이 겹치지 않으므로 `once --kind plan` 뒤에 이어 돌릴 수 있어야 한다)
   * → 3) `carried`(이월).
   */
  findPlanForPublishSlot(publishSlot: string): PlanRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM robot_plans WHERE status IN ('planned','carried')
          ORDER BY
            CASE WHEN status = 'planned' AND publish_slot = ? THEN 0
                 WHEN status = 'planned' THEN 1
                 ELSE 2 END,
            created_at ASC
          LIMIT 1`,
      )
      .get(publishSlot) as Record<string, unknown> | undefined;
    return raw ? toPlanRow(raw) : null;
  }

  updatePlan(id: string, patch: Partial<PlanRow>): PlanRow {
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    for (const key of PLAN_COLUMNS) {
      if (!(key in patch)) continue;
      const value = (patch as Record<string, unknown>)[key];
      assignments.push(`${key} = ?`);
      if (key === 'decision') values.push(JSON.stringify(value ?? {}));
      else if (value === undefined || value === null) values.push(null);
      else values.push(String(value));
    }
    if (assignments.length) {
      values.push(id);
      this.db
        .prepare(`UPDATE robot_plans SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values);
    }
    const row = this.getPlan(id);
    if (!row) throw new Error(`plan not found: ${id}`);
    return row;
  }

  // -------------------------------------------------------------------------
  // 명령(commands)
  // -------------------------------------------------------------------------

  enqueueCommand(input: {
    type: CommandType;
    runId?: string | null;
    payload?: Record<string, unknown>;
    source: 'dashboard' | 'cli';
    now?: Date;
  }): number {
    const info = this.db
      .prepare(
        `INSERT INTO robot_commands (type, run_id, payload, source, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        input.type,
        input.runId ?? null,
        input.payload ? JSON.stringify(input.payload) : null,
        input.source,
        kstIso(input.now ?? new Date()),
      );
    return Number(info.lastInsertRowid);
  }

  getCommand(id: number): CommandRow | null {
    const raw = this.db.prepare('SELECT * FROM robot_commands WHERE id = ?').get(id) as
      Record<string, unknown> | undefined;
    return raw ? toCommandRow(raw) : null;
  }

  /** 오래된 것부터 — 로봇이 틱마다 소비한다. */
  listPendingCommands(limit = 50): CommandRow[] {
    const rows = this.db
      .prepare("SELECT * FROM robot_commands WHERE status = 'pending' ORDER BY id ASC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map(toCommandRow);
  }

  markCommand(id: number, status: CommandStatus, result: string, now: Date = new Date()): void {
    this.db
      .prepare('UPDATE robot_commands SET status = ?, result = ?, applied_at = ? WHERE id = ?')
      .run(status, result, kstIso(now), id);
  }

  // -------------------------------------------------------------------------
  // 상태(state) — lease / paused / consecutive_pass
  // -------------------------------------------------------------------------

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM robot_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setState(key: string, value: string, now: Date = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO robot_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, kstIso(now));
  }

  getLease(): LeaseInfo | null {
    const raw = this.getState('lease');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LeaseInfo;
    } catch {
      return null;
    }
  }

  setLease(lease: LeaseInfo, now: Date = new Date()): void {
    this.setState('lease', JSON.stringify(lease), now);
  }

  clearLease(now: Date = new Date()): void {
    this.setState('lease', '', now);
  }

  isPaused(): boolean {
    return this.getState('paused') === 'true';
  }

  setPaused(paused: boolean, now: Date = new Date()): void {
    this.setState('paused', paused ? 'true' : 'false', now);
  }

  getConsecutivePasses(): number {
    const raw = this.getState('consecutive_pass');
    const n = raw ? parseInt(raw, 10) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  setConsecutivePasses(value: number, now: Date = new Date()): void {
    this.setState('consecutive_pass', String(Math.max(0, value)), now);
  }
}
