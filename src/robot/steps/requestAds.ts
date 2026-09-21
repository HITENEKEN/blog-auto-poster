import { RobotAbort } from '../errors';
import type { StepContext, StepHandler, StepResult } from './types';

/** 소재 부족 시 요청할 여유분(설계 §5-1 `needed = minAds + 2 - 보유`). */
export const AD_REQUEST_MARGIN = 2;

/**
 * REQUEST_ADS — 이 슬롯의 계획에 쓸 소재가 충분한지 보고, 부족하면 대시보드에
 * 소재 요청을 만든다(사람이 파트너스 링크를 붙여넣는다). 결과는 `planned` 또는
 * `planned-needs-ads`다.
 */
export const requestAds: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.plan_id) throw new RobotAbort('internal', 'plan_id가 없습니다');
  const plan = ctx.store.getPlan(ctx.run.plan_id);
  if (!plan) throw new RobotAbort('internal', `계획을 찾을 수 없습니다: ${ctx.run.plan_id}`);

  const inventory = await ctx.api.adsInventory({
    keyword: plan.keyword,
    categoryId: plan.category_id ?? undefined,
    status: 'active',
  });
  const owned = inventory.items?.length ?? 0;
  const minAds = ctx.config.ads.minAds;

  if (owned >= minAds) {
    ctx.evidence.writeJson('ads/request.json', { keyword: plan.keyword, owned, needed: 0 });
    return { type: 'next', step: 'RECORD', patch: { outcome: 'planned' } };
  }

  const criteria = (plan.decision?.productCriteria as string[] | undefined)?.filter(Boolean) ?? [];
  const needed = minAds + AD_REQUEST_MARGIN - owned;
  const { request } = await ctx.api.createAdRequest({
    keyword: plan.keyword,
    categoryId: plan.category_id ?? undefined,
    needed,
    criteria,
    dueAt: plan.publish_slot,
    robotRunId: ctx.run.id,
  });

  const requestId = request && typeof request.id === 'string' ? request.id : null;
  ctx.store.updatePlan(plan.id, { ad_request_id: requestId });
  ctx.evidence.writeJson('ads/request.json', {
    keyword: plan.keyword,
    owned,
    needed,
    criteria,
    dueAt: plan.publish_slot,
    requestId,
  });

  ctx.notify.notify(`소재 요청: ${plan.keyword} ${needed}개 (${plan.publish_slot.slice(0, 10)})`);
  return { type: 'next', step: 'RECORD', patch: { outcome: 'planned-needs-ads' } };
};
