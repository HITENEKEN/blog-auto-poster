import { getLogger } from '@core/logger';
import { kstIso } from './kst';
import type { CommandRow, RobotStore } from './RobotStore';
import type { Clock } from './RobotScheduler';

const logger = getLogger('robot');

/**
 * 명령 검증(설계 §5-7). 검증은 **적용 시점**에 로봇이 한다 — web은 INSERT만 하고,
 * 로봇이 조건을 확인해 `applied`/`refused`와 사유를 남긴다.
 *
 * approve/reject는 여기서 소비하지 않는다. 조건이 맞으면 `pending`으로 남겨 두고
 * `AWAIT_APPROVAL` 단계 핸들러가 실제 전이를 수행한다(그래야 승인 시각·sha 검사가 한 곳에 모인다).
 */
export interface CommandDecision {
  applied: boolean;
  reason: string;
}

export function decideCommand(
  command: CommandRow,
  store: RobotStore,
  clock: Clock,
): CommandDecision {
  switch (command.type) {
    case 'pause': {
      store.setPaused(true, clock.now());
      return { applied: true, reason: '일시정지 — 새 실행을 만들지 않는다' };
    }
    case 'resume': {
      store.setPaused(false, clock.now());
      return { applied: true, reason: '재개' };
    }
    case 'approve':
    case 'reject': {
      const run = command.run_id ? store.getRun(command.run_id) : null;
      if (!run) return { applied: false, reason: 'runId가 없거나 실행을 찾을 수 없습니다' };
      if (run.status !== 'waiting' || run.step !== 'AWAIT_APPROVAL') {
        return {
          applied: false,
          reason: `AWAIT_APPROVAL 상태가 아닙니다 (${run.step}/${run.status})`,
        };
      }
      return { applied: true, reason: '승인 대기 실행 — 단계 핸들러가 적용한다' };
    }
    case 'cancel': {
      const run = command.run_id ? store.getRun(command.run_id) : null;
      if (!run) return { applied: false, reason: 'runId가 없거나 실행을 찾을 수 없습니다' };
      if (run.step === 'PUBLISHING' || run.publish_started_at) {
        return { applied: false, reason: 'PUBLISHING 이후에는 취소할 수 없습니다(발행은 비가역)' };
      }
      if (run.status !== 'running' && run.status !== 'waiting') {
        return { applied: false, reason: `이미 종료된 실행입니다 (${run.status})` };
      }
      store.updateRun(run.id, {
        status: 'aborted',
        outcome: 'aborted-cancelled',
        finished_at: kstIso(clock.now()),
      });
      return { applied: true, reason: 'aborted-cancelled' };
    }
    case 'adopt': {
      const logNo = command.payload?.logNo;
      if (!logNo) return { applied: false, reason: 'logNo가 필요합니다' };
      const run = command.run_id ? store.getRun(command.run_id) : null;
      if (!run) return { applied: false, reason: 'runId가 없거나 실행을 찾을 수 없습니다' };
      if (run.outcome !== 'aborted-unconfirmed') {
        return {
          applied: false,
          reason: `aborted-unconfirmed 실행이 아닙니다 (${run.outcome ?? '진행 중'})`,
        };
      }
      store.updateRun(run.id, {
        status: 'running',
        step: 'VERIFY',
        log_no: String(logNo),
        url: `https://blog.naver.com/${String(command.payload?.blogId ?? '')}/${String(logNo)}`,
        outcome: null,
        finished_at: null,
      });
      return { applied: true, reason: `logNo ${String(logNo)} 연결 — VERIFY부터 재개` };
    }
    case 'run-now': {
      // 실행 생성은 데몬 틱이 한다(로봇이 리스를 쥐고 있으므로 CLI가 직접 만들면 중복될 수 있다).
      return { applied: true, reason: '수동 실행 요청 접수 — 슬롯 manual-<epoch>로 생성' };
    }
    default:
      return { applied: false, reason: `알 수 없는 명령: ${String(command.type)}` };
  }
}

/** 대시보드가 취소한 실행이 PUBLISHING에 들어가지 않도록 러너가 매 단계 전에 확인한다. */
export function isRunActive(store: RobotStore, runId: string): boolean {
  const run = store.getRun(runId);
  if (!run) return false;
  return run.status === 'running' || run.status === 'waiting';
}

/** 처리 결과를 DB에 반영한다. approve/reject는 pending으로 남긴다. */
export function applyCommandResult(
  store: RobotStore,
  command: CommandRow,
  decision: CommandDecision,
  clock: Clock,
): void {
  if (!decision.applied) {
    store.markCommand(command.id, 'refused', decision.reason, clock.now());
    logger.info({ command: command.type, id: command.id }, `명령 거부: ${decision.reason}`);
    return;
  }
  if (command.type === 'approve' || command.type === 'reject') return; // 핸들러가 소비
  store.markCommand(command.id, 'applied', decision.reason, clock.now());
  logger.info({ command: command.type, id: command.id }, `명령 적용: ${decision.reason}`);
}
