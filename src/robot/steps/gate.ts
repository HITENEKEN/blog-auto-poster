import * as fs from 'fs';
import { getLogger } from '@core/logger';
import { RobotAbort } from '../errors';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** 죽은 링크 때문에 PLACE_ADS로 되돌릴 수 있는 횟수(설계 §5-1 `GATE`, 최대 1회). */
export const MAX_PLACE_ADS_RETRIES = 1;

/** 링크 검사로 판정되는 위반 코드 — 死 링크만 있으면 광고를 다시 배치한다. */
export function isLinkViolation(code: string): boolean {
  return /LINK|URL|DEAD/i.test(code);
}

/**
 * GATE — 구조 게이트 + (선택) 링크 검사. 위반 0이면 `preview_sha256`과 미리보기 HTML을
 * 증거로 남긴다. 죽은 링크만 있으면 `PLACE_ADS`로 1회 되돌리고, 그 밖의 위반은
 * `aborted-gate`다.
 */
export const gate: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.draft_id) throw new RobotAbort('internal', 'draft_id가 없습니다');

  const result = await ctx.api.gate(ctx.run.draft_id, { checkLinks: true });
  ctx.evidence.writeJson('draft/gate.json', result);

  if (!result.ok && (result.violations || []).length) {
    const codes = result.violations.map((v) => v.code);
    const onlyLinks = codes.every(isLinkViolation);
    const attempts = ctx.store.countAttempts(ctx.run.id, 'PLACE_ADS');
    if (onlyLinks && attempts <= MAX_PLACE_ADS_RETRIES) {
      logger.warn({ codes }, '죽은 링크 — 광고 재배치');
      return {
        type: 'next',
        step: 'PLACE_ADS',
        patch: { warnings: [...(ctx.run.warnings ?? []), `dead-link-retry:${codes.join(',')}`] },
      };
    }
    throw new RobotAbort('gate', `광고 게이트 위반: ${codes.join(', ')}`);
  }

  const previewHtml =
    result.previewHtmlPath && fs.existsSync(result.previewHtmlPath)
      ? fs.readFileSync(result.previewHtmlPath, 'utf-8')
      : null;
  if (previewHtml) {
    ctx.evidence.writeText('draft/publish-preview.html', previewHtml);
    ctx.evidence.writeText('draft/publish-preview.html.sha256', `${result.previewSha256}\n`);
  }

  if (ctx.config.mode === 'auto') {
    return { type: 'next', step: 'PUBLISHING', patch: { preview_sha256: result.previewSha256 } };
  }

  // `once --kind publish --until GATE`: 게이트까지 확인하고 발행하지 않는다(드라이런).
  // 미리보기 sha는 승인 카드·증거가 쓰는 값이므로 드라이런에서도 남긴다.
  if (ctx.store.getState(`until:${ctx.run.id}`) === 'GATE') {
    return {
      type: 'finish',
      outcome: 'skipped-dry-run',
      patch: { preview_sha256: result.previewSha256 },
    };
  }

  return {
    type: 'next',
    step: 'AWAIT_APPROVAL',
    patch: { preview_sha256: result.previewSha256, approval_requested_at: null },
  };
};
