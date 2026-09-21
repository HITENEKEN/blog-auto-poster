import { getLogger } from '@core/logger';
import { kstCompact } from '../kst';
import { filterCandidates, isConsecutiveCategory } from '../policies';
import { researchCategory } from './research';
import { readLiveItems } from './selectTopic';
import type { PlanRow } from '../RobotStore';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/**
 * RESOLVE_ADS — 이 슬롯이 쓸 계획과 소재를 확정한다(설계 §5-1).
 *
 * 1) 이 슬롯의 `planned` 계획을 소비한다.
 * 2) 없으면 **인벤토리가 이미 충분한 카테고리**에 한해 RESEARCH·SELECT_TOPIC을 인라인 실행한다
 *    (소재 요청은 만들지 않는다). 인라인은 LLM 판단 호출을 쓰므로 실행당 호출 상한에 포함된다.
 * 3) 소재가 `minAds` 미만이면 계획을 `carried`로 넘기고 `skipped-no-ads`로 끝낸다.
 */
export const resolveAds: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const previous = ctx.store.lastPublishedRun();
  let plan: PlanRow | null = ctx.run.plan_id ? ctx.store.getPlan(ctx.run.plan_id) : null;
  if (!plan) plan = ctx.store.findPlanForPublishSlot(ctx.run.slot);

  if (plan && isConsecutiveCategory(previous?.category_id, plan.category_id)) {
    logger.info({ planId: plan.id }, '연속 카테고리 — 계획을 이월');
    ctx.store.updatePlan(plan.id, { status: 'carried' });
    plan = null;
  }

  if (!plan) {
    plan = await inlinePlan(ctx, previous?.category_id ?? null);
    if (!plan) {
      ctx.evidence.writeJson('ads/resolve.json', { reason: 'no-candidate-with-ads' });
      return { type: 'finish', outcome: 'skipped-no-ads' };
    }
  }

  const inventory = await ctx.api.adsInventory({
    keyword: plan.keyword,
    categoryId: plan.category_id ?? undefined,
    status: 'active',
  });
  const owned = inventory.items?.length ?? 0;
  if (owned < ctx.config.ads.minAds) {
    ctx.store.updatePlan(plan.id, { status: 'carried' });
    ctx.evidence.writeJson('ads/resolve.json', { planId: plan.id, keyword: plan.keyword, owned });
    ctx.notify.notify(`소재 부족: ${plan.keyword} (${owned}/${ctx.config.ads.minAds})`);
    return { type: 'finish', outcome: 'skipped-no-ads' };
  }

  ctx.store.updatePlan(plan.id, { status: 'consumed', publish_slot: ctx.run.slot });
  ctx.evidence.writeJson('ads/resolve.json', {
    planId: plan.id,
    keyword: plan.keyword,
    categoryId: plan.category_id,
    owned,
    ads: inventory.items.map((item) => ({ id: item.id, productName: item.productName })),
  });

  return {
    type: 'next',
    step: 'SNAPSHOT_LIVE',
    patch: { plan_id: plan.id, keyword: plan.keyword, category_id: plan.category_id ?? null },
  };
};

/**
 * 인라인 기획: 소재가 이미 있는 카테고리만 후보로 삼아 즉석에서 주제를 고른다.
 * 요청(ad_requests)은 만들지 않는다 — 사람이 붙여넣을 시간이 없기 때문이다.
 */
async function inlinePlan(
  ctx: StepContext,
  previousCategoryId: string | null,
): Promise<PlanRow | null> {
  if (!ctx.config.categories.length) return null;
  const live = readLiveItems(ctx);
  const now = ctx.clock.now();

  for (const category of ctx.config.categories) {
    const inventory = await ctx.api.adsInventory({ categoryId: category, status: 'active' });
    if ((inventory.items?.length ?? 0) < ctx.config.ads.minAds) continue;

    const candidates = await researchCategory(ctx, category);
    if (!candidates.length) continue;

    const filtered = filterCandidates(candidates, { live, now, previousCategoryId });
    if (!filtered.pass.length) continue;

    const judged = await ctx.judge.judgeTopics(
      filtered.pass.map((c) => ({ keyword: c.keyword, series: c.series })),
      live.map((l) => l.title),
    );
    const writable = new Set(judged.filter((j) => j.writable).map((j) => j.keyword));
    const selected = filtered.pass.find((c) => writable.has(c.keyword));
    if (!selected) continue;

    const verdict = judged.find((j) => j.keyword === selected.keyword);
    const planId = `plan-${kstCompact(now)}-inline`;
    return ctx.store.insertPlan({
      id: planId,
      runId: ctx.run.id,
      keyword: selected.keyword,
      categoryId: category,
      decision: {
        inline: true,
        score: null,
        candidates: filtered.pass.map((c) => c.keyword),
        rejected: filtered.rejected,
        productCriteria: verdict?.productCriteria ?? [],
        reason: verdict?.reason ?? null,
      },
      publishSlot: ctx.run.slot,
      status: 'planned',
      createdAt: now,
    });
  }

  return null;
}
