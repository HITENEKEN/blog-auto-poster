import * as os from 'os';
import { getLogger } from '@core/logger';
import { kstIso } from './kst';
import type { Clock } from './RobotScheduler';
import type { RobotStore } from './RobotStore';

const logger = getLogger('robot');

/** 리스(설계 §5-7): 20초마다 +60초로 갱신한다. 기동 시 유효한 리스의 pid가 살아 있으면 즉시 종료. */
export const LEASE_STATE_KEY = 'lease';
/** 다른 인스턴스가 실행 중일 때의 거부 메시지(exit 0으로 조용히 끝난다). */
export const ALREADY_RUNNING_MESSAGE = 'already running';
export const LEASE_RENEW_MS = 20_000;
export const LEASE_TTL_MS = 60_000;

export interface LeaseState {
  pid: number;
  hostname: string;
  startedAt: string;
  expiresAt: string;
}

/** pid가 살아 있는지(다른 사용자 프로세스는 EPERM → 살아 있는 것으로 본다). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** 유효한 리스(만료되지 않았고, 같은 호스트에서 pid가 살아 있음)만 돌려준다. */
export function readActiveLease(store: RobotStore, now: Date): LeaseState | null {
  const raw = store.getState(LEASE_STATE_KEY);
  if (!raw) return null;
  let lease: LeaseState;
  try {
    lease = JSON.parse(raw) as LeaseState;
  } catch {
    return null;
  }
  if (!lease?.pid) return null;
  if (Date.parse(lease.expiresAt) < now.getTime()) return null;
  if (lease.hostname !== os.hostname()) return null;
  return isProcessAlive(lease.pid) ? lease : null;
}

export function writeLease(store: RobotStore, now: Date, pid: number = process.pid): LeaseState {
  const lease: LeaseState = {
    pid,
    hostname: os.hostname(),
    startedAt: kstIso(now),
    expiresAt: kstIso(new Date(now.getTime() + LEASE_TTL_MS)),
  };
  store.setLease(lease, now);
  return lease;
}

/**
 * 리스 획득. 다른 인스턴스가 유효한 리스를 잡고 있으면 false(호출부는 exit 0 + "already running").
 */
export function acquireLease(store: RobotStore, clock: Clock, pid: number = process.pid): boolean {
  const existing = readActiveLease(store, clock.now());
  if (existing && existing.pid !== pid) {
    logger.warn({ lease: existing }, ALREADY_RUNNING_MESSAGE);
    return false;
  }
  writeLease(store, clock.now(), pid);
  return true;
}
