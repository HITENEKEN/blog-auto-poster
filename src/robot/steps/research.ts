import { getLogger } from '@core/logger';
import { HttpError, RobotAbort } from '../errors';
import { DAY_MS, kstDateString } from '../kst';
import type { TopicCandidate } from '../policies';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/**
 * RESEARCH — 수요 조회(실데이터, 추정 금지). 스킬 §4의 순서를 그대로 따른다.
 *
 * 카테고리마다 `category-overview`(8주·week) → 상위 키워드 5개 → `trend`(16주·week)
 * → `blogs`(sim·date). 원문 응답은 실행 증거에 그대로 남긴다.
 */
export const RESEARCH_WEEKS = 16;
export const OVERVIEW_WEEKS = 8;

export interface ResearchContext {
  api: StepContext['api'];
  evidence: StepContext['evidence'];
  clock: StepContext['clock'];
  keyword?: string;
}

/** 한 카테고리의 후보를 모은다. 조회 실패는 `aborted-research`(추정치 대체 금지). */
export async function researchCategory(
  ctx: Pick<StepContext, 'api' | 'evidence' | 'clock'>,
  category: string,
): Promise<TopicCandidate[]> {
  const nowMs = ctx.clock.now().getTime();
  const endDate = kstDateString(new Date(nowMs - DAY_MS));

  let overview: Awaited<ReturnType<StepContext['api']['categoryOverview']>>;
  try {
    overview = await ctx.api.categoryOverview({
      category,
      startDate: kstDateString(new Date(nowMs - OVERVIEW_WEEKS * 7 * DAY_MS)),
      endDate,
      timeUnit: 'week',
    });
  } catch (error) {
    if (error instanceof HttpError) {
      throw new RobotAbort('research', `category-overview(${category}) → ${error.status}`);
    }
    throw error;
  }
  ctx.evidence.writeJson(`keyword/overview-${category}.json`, overview);

  const top = (overview.keywords || [])
    .map((k) => String(k.keyword || ''))
    .filter(Boolean)
    .slice(0, 5);
  if (!top.length) return [];

  const trendStart = kstDateString(new Date(nowMs - RESEARCH_WEEKS * 7 * DAY_MS));
  const candidates: TopicCandidate[] = [];

  for (const keyword of top) {
    const trend = await ctx.api.searchTrend({
      source: 'search-trend',
      query: keyword,
      startDate: trendStart,
      endDate,
      timeUnit: 'week',
    });
    ctx.evidence.writeJson(`keyword/trend-${keyword}.json`, trend);
    const series = (trend.series?.[0]?.data || []).map((p) => ({
      period: String(p.period),
      ratio: Number(p.ratio) || 0,
    }));

    const sim = await ctx.api.keywordBlogs(keyword, { limit: 10, sort: 'sim' });
    const date = await ctx.api.keywordBlogs(keyword, { limit: 10, sort: 'date' });
    ctx.evidence.writeJson(`keyword/blogs-${keyword}.json`, { sim: sim.total, date: date.total });

    candidates.push({
      keyword,
      categoryId: category,
      series,
      categorySeries: (overview.clickTrend || []).map((p) => ({
        period: String(p.period),
        ratio: Number(p.ratio) || 0,
      })),
      blogs: { sim: Number(sim.total) || 0, date: Number(date.total) || 0 },
      adCount: 0,
    });
  }

  return candidates;
}

/** 여러 카테고리를 순회한다. 후보가 하나도 없으면 `aborted-research`. */
export async function researchCategories(
  ctx: Pick<StepContext, 'api' | 'evidence' | 'clock'>,
  categories: string[],
): Promise<TopicCandidate[]> {
  const all: TopicCandidate[] = [];
  for (const category of categories) {
    const candidates = await researchCategory(ctx, category);
    logger.debug({ category, candidates: candidates.length }, 'research category done');
    all.push(...candidates);
  }
  if (!all.length) {
    throw new RobotAbort('research', '후보 키워드를 하나도 얻지 못했습니다');
  }
  const merged = ctx.evidence.writeJson('keyword/candidates.json', all);
  logger.info({ file: merged, candidates: all.length }, 'candidates 저장');
  return all;
}

export const research: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.config.categories.length) {
    throw new RobotAbort('research', 'robot.categories가 비어 있습니다');
  }
  await researchCategories(ctx, ctx.config.categories);
  return { type: 'next', step: 'SELECT_TOPIC' };
};
