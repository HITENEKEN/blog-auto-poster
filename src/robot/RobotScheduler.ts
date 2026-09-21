import { getLogger } from '@core/logger';
import type { Notifier } from './notify';
import type { RobotStore, RunKind, RunRow, RunMode } from './RobotStore';
import { DAY_MS, kstCompact, kstIso, kstWeekStart, slotTimeMs, type KstWeekday } from './kst';
import { WEEKLY_HARD_CAP } from './policies';

const logger = getLogger('robot');

/**
 * 주간 슬롯 스케줄러(설계 §5-6). cron 문자열 대신 주간 슬롯 목록을 쓴다 —
 * 놓친 실행 계산이 쉽고 새 의존성이 필요 없다.
 *
 * 60초 틱마다:
 * 1) (slot + jitter) ≤ now < slot + catchUp 이고 행이 없는 슬롯 → 실행 생성
 * 2) 창을 이미 지난 슬롯에 행이 없으면 `skipped-missed-slot` 행 + 알림
 * 3) 동시 실행 1개 — 진행 중 실행이 있으면 이번 틱에는 만들지 않는다(다음 틱)
 * 4) 발행과 기획이 겹치면 발행이 우선
 *
 * 지터는 `hash(slot) % jitterMinutes`로 슬롯마다 고정된다 — 재시작해도 같은 시각이다.
 */

export interface SlotSpec {
  day: KstWeekday;
  time: string; // 'HH:MM' (KST)
}

export interface RobotSlotsConfig {
  enabled: boolean;
  mode: RunMode;
  /** 대상 카테고리 — 실행 생성 자체는 카테고리와 무관하지만 PREFLIGHT가 쓴다. */
  categories?: string[];
  slots: { plan: SlotSpec[]; publish: SlotSpec[] };
  catchUpMinutes: { plan: number; publish: number };
  jitterMinutes: number;
  approvalTimeoutMinutes?: number;
  codeVersion?: string;
}

export interface Clock {
  now(): Date;
}

export const SYSTEM_CLOCK: Clock = { now: () => new Date() };

/** 가짜 시계 — 테스트·드라이런에서 시간을 앞당긴다. */
export class FakeClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export interface SchedulerTickResult {
  /** 이번 틱에 생성된 실행 */
  created: RunRow[];
  /** 창을 지나 생성된 `skipped-missed-slot` 행 */
  missed: RunRow[];
  /** 창 안이지만 진행 중 실행 때문에 다음 틱으로 미룬 슬롯 */
  deferred: Array<{ kind: RunKind; slot: string }>;
}

/** 슬롯 문자열의 안정 해시(FNV-1a 32bit) — 지터 계산용. */
export function hashSlot(slot: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slot.length; i += 1) {
    hash ^= slot.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** 슬롯별 고정 지터(ms). `jitterMinutes=0`이면 0. */
export function slotJitterMs(slot: string, jitterMinutes: number): number {
  if (!jitterMinutes || jitterMinutes <= 0) return 0;
  return (hashSlot(slot) % jitterMinutes) * 60_000;
}

interface CandidateSlot {
  kind: RunKind;
  /** 실행 행의 slot 값(지터 적용 후 시각) */
  slot: string;
  /** 지터 적용 후 실행 시각(ms) */
  dueMs: number;
  catchUpMs: number;
}

/**
 * 지정한 주 오프셋들의 슬롯을 계산한다(순수 함수). 스케줄러와 계획 단계
 * (`robot_plans.publish_slot`)가 **같은 슬롯 문자열**을 만들어야 계획이 슬롯에 붙는다.
 */
export function computeSlots(
  now: Date,
  slots: { plan: SlotSpec[]; publish: SlotSpec[] },
  jitterMinutes: number,
  weekOffsets: number[],
): CandidateSlot[] {
  const out: CandidateSlot[] = [];
  for (const weekOffset of weekOffsets) {
    const weekStart = new Date(kstWeekStart(now).getTime() + weekOffset * 7 * DAY_MS);
    for (const kind of ['plan', 'publish'] as RunKind[]) {
      for (const spec of slots?.[kind] || []) {
        const baseMs = slotTimeMs(weekStart, spec.day, spec.time);
        const baseSlot = kstIso(new Date(baseMs));
        const jitter = slotJitterMs(baseSlot, jitterMinutes);
        out.push({
          kind,
          slot: kstIso(new Date(baseMs + jitter)),
          dueMs: baseMs + jitter,
          catchUpMs: 0,
        });
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.dueMs - b.dueMs ||
      // 같은 시각이면 발행이 우선이다(설계 §5-6).
      (a.kind === b.kind ? 0 : a.kind === 'publish' ? -1 : 1),
  );
}

/** `now` 이후 가장 가까운 특정 종류의 슬롯(지터 적용 후). 계획의 `publish_slot`에 쓴다. */
export function nextSlotOfKind(
  now: Date,
  slots: { plan: SlotSpec[]; publish: SlotSpec[] },
  jitterMinutes: number,
  kind: RunKind,
): { slot: string; at: Date } | null {
  const candidates = computeSlots(now, slots, jitterMinutes, [0, 1, 2, 3, 4]).filter(
    (c) => c.kind === kind && c.dueMs > now.getTime(),
  );
  const first = candidates[0];
  return first ? { slot: first.slot, at: new Date(first.dueMs) } : null;
}

export class RobotScheduler {
  constructor(
    private readonly deps: {
      store: RobotStore;
      config: RobotSlotsConfig;
      clock: Clock;
      notifier?: Notifier;
    },
  ) {}

  private candidates(now: Date): CandidateSlot[] {
    const config = this.deps.config;
    // catchUp은 최대 10시간이므로 지난 주 1주 + 이번 주만 보면 충분하다.
    return computeSlots(now, config.slots, config.jitterMinutes, [-1, 0]).map((slot) => ({
      ...slot,
      catchUpMs: (config.catchUpMinutes?.[slot.kind] ?? 0) * 60_000,
    }));
  }

  /**
   * 틱 1회. 시각 판단은 전부 주입된 시계에서만 나온다(테스트 가능).
   * 반환값은 이번 틱에 만들어진 행 목록이다.
   */
  tick(): SchedulerTickResult {
    const result: SchedulerTickResult = { created: [], missed: [], deferred: [] };
    const config = this.deps.config;
    if (!config.enabled) return result;

    const now = this.deps.clock.now();
    const nowMs = now.getTime();
    const candidates = this.candidates(now);
    const activeRun = this.deps.store.listActiveRuns()[0] ?? null;
    let busy = activeRun !== null;

    // 1) 창을 지난 슬롯 → skipped-missed-slot (최근 2일 이내만; 그 이전은 과거 이력)
    for (const candidate of candidates) {
      const windowEnd = candidate.dueMs + candidate.catchUpMs;
      if (windowEnd > nowMs) continue;
      if (nowMs - windowEnd > 2 * DAY_MS) continue;
      if (this.deps.store.getRunBySlot(candidate.kind, candidate.slot)) continue;
      const row = this.recordMissed(candidate, now);
      result.missed.push(row);
    }

    // 2) 창 안에 있고 아직 행이 없는 슬롯 → 실행 생성 (published 우선 = dueMs 오름차순)
    for (const candidate of candidates) {
      if (candidate.dueMs > nowMs) continue;
      const windowEnd = candidate.dueMs + candidate.catchUpMs;
      if (windowEnd <= nowMs) continue; // 위에서 missed로 처리됐다
      if (this.deps.store.getRunBySlot(candidate.kind, candidate.slot)) continue;
      if (busy) {
        result.deferred.push({ kind: candidate.kind, slot: candidate.slot });
        continue;
      }
      const row = this.createScheduledRun(candidate, now);
      result.created.push(row);
      busy = row.status === 'running';
    }

    return result;
  }

  private createScheduledRun(candidate: CandidateSlot, now: Date): RunRow {
    const trigger = now.getTime() - candidate.dueMs <= 60_000 ? 'schedule' : 'catch-up';

    // 주간 상한은 슬롯 생성 시점에도 확인한다(§5-4). PREFLIGHT가 같은 판정을 다시 한다.
    if (candidate.kind === 'publish') {
      const published = this.deps.store.countPublishedThisWeek(now);
      if (published >= WEEKLY_HARD_CAP) {
        const { row } = this.deps.store.createRun({
          kind: candidate.kind,
          slot: candidate.slot,
          trigger,
          mode: this.deps.config.mode,
          step: 'PREFLIGHT',
          startedAt: now,
          codeVersion: this.deps.config.codeVersion,
        });
        const skipped = this.deps.store.updateRun(row.id, {
          status: 'skipped',
          outcome: 'skipped-weekly-cap',
          finished_at: kstIso(now),
        });
        logger.warn({ runId: skipped.id, published }, '주간 상한 도달 — 발행 실행을 건너뛴다');
        this.deps.notifier?.notify(`주간 상한(${WEEKLY_HARD_CAP}회) 도달 — 발행 슬롯을 건너뜀`);
        return skipped;
      }
    }

    const { row, created } = this.deps.store.createRun({
      kind: candidate.kind,
      slot: candidate.slot,
      trigger,
      mode: this.deps.config.mode,
      step: 'PREFLIGHT',
      startedAt: now,
      codeVersion: this.deps.config.codeVersion,
    });
    logger.info(
      { runId: row.id, kind: row.kind, trigger, created },
      created ? '슬롯 실행 생성' : '슬롯 실행이 이미 존재',
    );
    return row;
  }

  private recordMissed(candidate: CandidateSlot, now: Date): RunRow {
    const { row, created } = this.deps.store.createRun({
      kind: candidate.kind,
      slot: candidate.slot,
      trigger: 'catch-up',
      mode: this.deps.config.mode,
      step: 'PREFLIGHT',
      startedAt: now,
      codeVersion: this.deps.config.codeVersion,
    });
    const skipped = created
      ? this.deps.store.updateRun(row.id, {
          status: 'skipped',
          outcome: 'skipped-missed-slot',
          finished_at: kstIso(now),
        })
      : row;
    if (created) {
      logger.warn({ runId: skipped.id, slot: candidate.slot }, '놓친 슬롯');
      this.deps.notifier?.notify(
        `놓친 슬롯이 있습니다 (${candidate.kind}, ${candidate.slot.slice(0, 16)})`,
      );
    }
    return skipped;
  }

  /** 다음 실행 예정 시각(대시보드 표시용) — 슬롯·종류·지터 적용 시각. */
  nextSlots(now: Date = this.deps.clock.now(), count = 4): Array<{ kind: RunKind; at: string }> {
    return computeSlots(
      now,
      this.deps.config.slots,
      this.deps.config.jitterMinutes,
      [0, 1, 2, 3, 4],
    )
      .filter((slot) => slot.dueMs >= now.getTime())
      .slice(0, count)
      .map((slot) => ({ kind: slot.kind, at: slot.slot }));
  }

  /** 슬롯 id(수동 실행용) — `manual-<epoch>`. */
  manualSlot(now: Date = this.deps.clock.now()): string {
    return `manual-${kstCompact(now)}`;
  }
}
