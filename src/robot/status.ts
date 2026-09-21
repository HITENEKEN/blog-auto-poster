import { computeSlots } from './RobotScheduler';
import type { LeaseState } from './index';
import type { RobotConfig } from './config';
import type { RobotStore, RunKind, RunRow } from './RobotStore';

/**
 * `GET /api/robot/status`와 `npm run robot -- status`가 같은 셰이프를 쓴다(설계 §4-1).
 * 로봇이 한 번도 돌지 않아 파일이 없으면 `installed:false`.
 */
export interface RobotStatus {
  installed: boolean;
  enabled: boolean;
  paused: boolean;
  mode: 'manual' | 'auto';
  lease: LeaseState | null;
  nextSlots: Array<{ kind: RunKind; at: string }>;
  current: RunRow | null;
  awaitingApproval: RunRow | null;
  recent: RunRow[];
  consecutivePasses: number;
  autoPromoteAfterPasses: number;
  /** 열린 소재 요청 수 — web 라우트가 채운다(로봇 DB에는 없다). */
  openAdRequests: number | null;
}

/** 파일이 없을 때의 빈 상태 — 대시보드는 이 셰이프로 "미설치"를 렌더링한다. */
export function emptyRobotStatus(config?: RobotConfig): RobotStatus {
  return {
    installed: false,
    enabled: config?.enabled ?? false,
    paused: false,
    mode: config?.mode ?? 'manual',
    lease: null,
    nextSlots: [],
    current: null,
    awaitingApproval: null,
    recent: [],
    consecutivePasses: 0,
    autoPromoteAfterPasses: config?.autoPromoteAfterPasses ?? 4,
    openAdRequests: null,
  };
}

export function buildRobotStatus(
  store: RobotStore,
  config: RobotConfig,
  now: Date = new Date(),
): RobotStatus {
  const active = store.listActiveRuns();
  const recent = store.listRuns(10);
  const awaiting =
    active.find((run) => run.step === 'AWAIT_APPROVAL' && run.status === 'waiting') ?? null;

  return {
    installed: true,
    enabled: config.enabled,
    paused: store.isPaused(),
    mode: config.mode,
    lease: store.getLease(),
    nextSlots: computeSlots(now, config.slots, config.jitterMinutes, [0, 1, 2, 3])
      .filter((slot) => slot.dueMs >= now.getTime())
      .slice(0, 4)
      .map((slot) => ({ kind: slot.kind, at: slot.slot })),
    current: active[0] ?? null,
    awaitingApproval: awaiting,
    recent,
    consecutivePasses: store.getConsecutivePasses(),
    autoPromoteAfterPasses: config.autoPromoteAfterPasses,
    openAdRequests: null,
  };
}
