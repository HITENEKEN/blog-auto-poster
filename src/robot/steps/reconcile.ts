import { getLogger } from '@core/logger';
import { collectRssLogNos, findRecentlyPublishedRssItem } from '../../platforms/naver/NaverRss';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** RSS 재조회 시점(분) — 발행 시작 시각 기준(스킬 §8). */
export const RECONCILE_POLL_MINUTES = [1, 3, 6];
/** 제목 교차 확인 윈도우. */
export const RECONCILE_TITLE_WINDOW_MS = 60 * 60 * 1000;

function readLogNos(text: string | null): Set<string> {
  return new Set(
    (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * RECONCILE — 모호성 화해(스킬 §8, 설계 §5-1). **재호출 대신** 라이브 RSS를 보고 확정한다.
 *
 * - 신규 0건 → `aborted-unconfirmed` (사람이 확인하거나 다음 슬롯)
 * - 신규 1건 → `VERIFY` (+1분에 없고 +3분에 있으면 그때 확정)
 * - 신규 2건 이상 → `aborted-multiple` (로봇은 삭제하지 않는다 — 즉시 사람 이관)
 */
export const reconcile: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const now = ctx.clock.now();
  const startedIso = ctx.run.publish_started_at ?? null;
  const startedMs = startedIso ? Date.parse(startedIso) : now.getTime();
  const elapsedMs = now.getTime() - startedMs;

  const before = readLogNos(ctx.evidence.readText('live/logNos-before.txt'));
  const rssXml = await ctx.http.getText(ctx.env.rssUrl);
  ctx.evidence.writeText('live/rss-after.xml', rssXml);
  const after = collectRssLogNos(rssXml);
  ctx.evidence.writeText('live/logNos-after.txt', `${after.join('\n')}\n`);

  const newLogNos = after.filter((logNo) => !before.has(logNo));
  logger.info({ runId: ctx.run.id, newLogNos, elapsedMs }, 'RECONCILE');

  if (newLogNos.length >= 2) {
    ctx.notify.notify(`중복 발행 의심 ${newLogNos.length}건 — 사람 확인 필요`);
    return {
      type: 'finish',
      outcome: 'aborted-multiple',
      patch: { warnings: [...(ctx.run.warnings ?? []), `new-logNos:${newLogNos.join(',')}`] },
    };
  }

  if (newLogNos.length === 1) {
    const logNo = newLogNos[0];
    const title = ctx.evidence.readText('draft/title.txt')?.trim() ?? '';
    const item = title
      ? findRecentlyPublishedRssItem(rssXml, title, now, RECONCILE_TITLE_WINDOW_MS)
      : null;
    if (item && item.logNo && item.logNo !== logNo) {
      ctx.evidence.writeJson('live/reconcile-mismatch.json', {
        candidates: logNo,
        matched: item.logNo,
      });
      logger.warn({ logNo, matched: item.logNo }, '제목 교차 확인 불일치 — 미확정으로 둔다');
    } else {
      const url = `https://blog.naver.com/${ctx.env.blogId}/${logNo}`;
      return { type: 'next', step: 'VERIFY', patch: { log_no: logNo, url } };
    }
  }

  const lastPollMs = RECONCILE_POLL_MINUTES[RECONCILE_POLL_MINUTES.length - 1] * 60_000;
  if (elapsedMs < lastPollMs) {
    const nextPollMs =
      RECONCILE_POLL_MINUTES.map((m) => m * 60_000).find((ms) => ms > elapsedMs) ?? lastPollMs;
    return {
      type: 'wait',
      recheckAfterMs: Math.max(nextPollMs - elapsedMs, 15_000),
      reason: 'awaiting-rss',
    };
  }

  return { type: 'finish', outcome: 'aborted-unconfirmed' };
};
