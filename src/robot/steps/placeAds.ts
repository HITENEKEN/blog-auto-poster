import { RobotAbort } from '../errors';
import type { StepContext, StepHandler, StepResult } from './types';

/**
 * PLACE_ADS — 서버가 `stripAutoAds` 후 재배치한다(멱등). 슬롯·상품·결과를
 * `ads/placement.json` 증거로 남긴다(설계 §2-3).
 */
export const placeAds: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.draft_id) throw new RobotAbort('internal', 'draft_id가 없습니다');

  const result = await ctx.api.placeAds(ctx.run.draft_id, {
    keyword: ctx.run.keyword,
    categoryId: ctx.run.category_id ?? undefined,
    policy: ctx.config.ads,
  });

  ctx.evidence.writeJson('ads/placement.json', {
    at: ctx.clock.now().toISOString(),
    keyword: ctx.run.keyword,
    slots: result.slots ?? [],
    ads: result.ads ?? [],
    disclosure: result.disclosure ?? null,
    notes: result.notes ?? null,
  });

  // 사용 상품 id는 ads/placement.json 증거에 남는다 — RECORD가 그것을 읽어 PATCH markUsed를 부른다.
  return { type: 'next', step: 'GATE' };
};
