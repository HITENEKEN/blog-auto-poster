import { kstIso } from '../kst';
import type { StepContext, StepHandler, StepResult } from './types';

/** 승인 대기 재확인 간격(초과 판정은 `approval_requested_at` 기준 — §5-2). */
export const APPROVAL_RECHECK_MS = 60_000;

/**
 * AWAIT_APPROVAL — `mode=manual`에서만 지나간다(설계 §5-1).
 * 알림 → `approve{previewSha256}`/`reject` 대기. 승인 sha가 현재와 다르면 그 명령을
 * 거부하고 `GATE`로 돌아간다(초안이 바뀌었을 수 있으므로). 제한 시간(기본 120분)을
 * 넘으면 `aborted-no-approval`로 끝나고 초안은 남는다.
 */
export const awaitApproval: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const now = ctx.clock.now();
  let requestedAt = ctx.run.approval_requested_at ?? null;
  if (!requestedAt) {
    requestedAt = kstIso(now);
    ctx.store.updateRun(ctx.run.id, { approval_requested_at: requestedAt });
    ctx.notify.notify(`승인 대기: ${ctx.run.keyword ?? '초안'} — 미리보기를 확인하세요`);
  }

  const requestedMs = Date.parse(requestedAt);
  const timeoutMs = ctx.config.approvalTimeoutMinutes * 60_000;
  if (Number.isFinite(requestedMs) && now.getTime() - requestedMs > timeoutMs) {
    return { type: 'finish', outcome: 'aborted-no-approval' };
  }

  for (const command of ctx.commands.pending()) {
    if (command.type === 'cancel') {
      ctx.commands.resolve(command.id, 'applied', 'cancelled');
      return { type: 'finish', outcome: 'aborted-cancelled' };
    }
    if (command.type === 'reject') {
      ctx.commands.resolve(command.id, 'applied', String(command.payload?.reason ?? 'rejected'));
      return { type: 'finish', outcome: 'aborted-rejected' };
    }
    if (command.type === 'approve') {
      const sha = String(command.payload?.previewSha256 ?? '');
      if (sha && ctx.run.preview_sha256 && sha !== ctx.run.preview_sha256) {
        ctx.commands.resolve(command.id, 'refused', 'previewSha256 불일치 — 게이트 재실행');
        return { type: 'next', step: 'GATE' };
      }
      ctx.commands.resolve(command.id, 'applied', 'approved');
      return { type: 'next', step: 'PUBLISHING' };
    }
  }

  return { type: 'wait', recheckAfterMs: APPROVAL_RECHECK_MS, reason: 'awaiting-approval' };
};
