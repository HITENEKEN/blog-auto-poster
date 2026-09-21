import { getLogger } from '@core/logger';
import { HttpError, RobotAbort, describeError } from '../errors';
import { kstIso } from '../kst';
import { collectRssLogNos } from '../../platforms/naver/NaverRss';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** 발행 잠금(423)·미리보기 변경(409)은 **아직 발행 전**이므로 게이트로 되돌린다. */
const PRE_PUBLISH_STATUSES = [409, 423];

/**
 * PUBLISHING — 비가역 단계(설계 §5-1, 스킬 §7).
 *
 * - `publish_started_at`을 **먼저** 커밋한 뒤 RSS 직전 스냅샷을 남기고 1회 호출한다.
 * - 이미 `publish_started_at`이 있으면 다시 호출하지 않는다(크래시 재개 → `RECONCILE`).
 * - 타임아웃·5xx·응답 없음 → **재호출 금지**, `RECONCILE`이 RSS로 확정한다.
 */
export const publishing: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.draft_id) throw new RobotAbort('internal', 'draft_id가 없습니다');

  if (ctx.run.publish_started_at) {
    logger.warn({ runId: ctx.run.id }, 'PUBLISHING 재진입 — publish를 다시 호출하지 않는다');
    return { type: 'next', step: 'RECONCILE' };
  }

  const now = ctx.clock.now();
  ctx.store.updateRun(ctx.run.id, { publish_started_at: kstIso(now) });
  ctx.evidence.ensure('publish', 'live');

  const rssXml = await ctx.http.getText(ctx.env.rssUrl);
  ctx.evidence.writeText('live/rss-before.xml', rssXml);
  ctx.evidence.writeText('live/logNos-before.txt', `${collectRssLogNos(rssXml).join('\n')}\n`);

  try {
    const result = await ctx.api.publish(ctx.run.draft_id, {
      platform: 'naver',
      visibility: 'public',
      aiPolish: false,
      strict: true,
      expectedPreviewSha256: ctx.run.preview_sha256,
      robotRunId: ctx.run.id,
    });
    ctx.evidence.writeJson('publish/response.json', result);

    const first = result.results?.[0];
    const warnings = [...(first?.warnings ?? []), ...(first?.widgetWarnings ?? [])];
    if (first?.success === false) {
      logger.error({ error: first.error }, '발행 응답이 실패를 보고했습니다');
    }
    return {
      type: 'next',
      step: 'RECONCILE',
      patch: { warnings: [...(ctx.run.warnings ?? []), ...warnings] },
    };
  } catch (error) {
    const status = error instanceof HttpError ? error.status : null;
    ctx.evidence.writeJson('publish/error.json', { status, message: describeError(error) });

    if (status !== null && PRE_PUBLISH_STATUSES.includes(status)) {
      // 발행이 시작되지 않았다 — 게이트로 되돌려 다시 확인한다.
      ctx.store.updateRun(ctx.run.id, { publish_started_at: null });
      return {
        type: 'next',
        step: 'GATE',
        patch: { warnings: [...(ctx.run.warnings ?? []), `publish-refused:${status}`] },
      };
    }

    // 타임아웃·5xx·응답 없음: 재호출하지 않고 RSS로 확정한다(스킬 §7·§8).
    return {
      type: 'next',
      step: 'RECONCILE',
      patch: {
        warnings: [...(ctx.run.warnings ?? []), `publish-ambiguous:${describeError(error)}`],
      },
    };
  }
};
