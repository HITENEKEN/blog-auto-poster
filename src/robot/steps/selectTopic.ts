import { getLogger } from '@core/logger';
import { RobotAbort } from '../errors';
import { kstCompact, kstIso } from '../kst';
import { nextSlotOfKind } from '../RobotScheduler';
import {
  filterCandidates,
  isDuplicate,
  normalizeKeyword,
  rankTopics,
  SEASONAL_DUPLICATE_WINDOW_DAYS,
  type RejectedTopic,
  type TopicCandidate,
} from '../policies';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** RESEARCH가 남긴 후보 원장. 단계가 독립적으로 재개될 수 있도록 증거 파일에서 읽는다. */
export function readCandidates(ctx: Pick<StepContext, 'evidence'>): TopicCandidate[] {
  const raw = ctx.evidence.readText('keyword/candidates.json');
  if (!raw) throw new RobotAbort('research', 'keyword/candidates.json이 없습니다');
  try {
    return JSON.parse(raw) as TopicCandidate[];
  } catch {
    throw new RobotAbort('research', 'keyword/candidates.json 파싱 실패');
  }
}

/** 라이브 항목(중복 판정 입력). SNAPSHOT_LIVE가 남긴 파일을 읽는다. */
export function readLiveItems(
  ctx: Pick<StepContext, 'evidence'>,
): Array<{ title: string; pubDate: Date | null }> {
  const raw = ctx.evidence.readText('live/live-items.json');
  if (!raw) return [];
  try {
    const items = JSON.parse(raw) as Array<{ title: string; pubDate: string | null }>;
    return items.map((i) => ({ title: i.title, pubDate: i.pubDate ? new Date(i.pubDate) : null }));
  } catch {
    return [];
  }
}

function decisionMarkdown(input: {
  now: Date;
  candidates: TopicCandidate[];
  rejected: RejectedTopic[];
  selected?: TopicCandidate;
  reason: string;
  seasonal?: boolean;
}): string {
  const lines: string[] = [
    '# 주제 선정 근거',
    '',
    `- 출처: 네이버 쇼핑인사이트(분야 인기검색어·클릭지수) + 검색어트렌드(SCH_TRND) + 블로그 문서량`,
    `- 조회 시각: ${kstIso(input.now)} (UTC ${input.now.toISOString()})`,
    `- 조회 기간: 검색어트렌드 16주 · 분야 클릭지수 8주 (주 단위)`,
    `- 표기: 모든 지수는 **상대 지수**(구간 내 최댓값 = 100)이며 절대 검색량이 아니다`,
    '',
    '## 후보별 수치',
    '',
    '| 키워드 | 최근 4주 평균 | 최근 4주 마지막 | blogs.sim | blogs.date | 판정 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const candidate of input.candidates) {
    const recent = candidate.series.slice(-4);
    const avg = recent.length ? recent.reduce((s, p) => s + p.ratio, 0) / recent.length : 0;
    const last = recent.length ? recent[recent.length - 1].ratio : 0;
    const rejection = input.rejected.find((r) => r.keyword === candidate.keyword);
    const verdict = rejection ? `탈락 (${rejection.reasons.join(', ')})` : '통과';
    lines.push(
      `| ${candidate.keyword} | ${avg.toFixed(2)} | ${last.toFixed(2)} | ${candidate.blogs?.sim ?? ''} | ${
        candidate.blogs?.date ?? ''
      } | ${verdict} |`,
    );
  }

  lines.push('', '## 탈락 사유', '');
  if (!input.rejected.length) lines.push('- 없음');
  for (const rejection of input.rejected) {
    lines.push(`- ${rejection.keyword}: ${rejection.reasons.join(', ')}`);
  }

  lines.push('', '## 선정', '');
  if (input.selected) {
    lines.push(`- 키워드: ${input.selected.keyword}`);
    lines.push(`- 카테고리: ${input.selected.categoryId ?? '(미지정)'}`);
    lines.push(`- 근거: ${input.reason}`);
    lines.push(`- 계절 키워드: ${input.seasonal ? '예 (중복 윈도우 365일)' : '아니오'}`);
  } else {
    lines.push(`- 선정 없음: ${input.reason}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * SELECT_TOPIC — 1차 필터(수치) → LLM 판단 → 순위(설계 §5-1).
 * 후보가 하나도 남지 않으면 **발행하지 않고** `skipped-no-candidate`로 끝낸다(스킬 §5).
 */
export const selectTopic: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const now = ctx.clock.now();
  const candidates = readCandidates(ctx);
  const live = readLiveItems(ctx);
  const previous = ctx.store.lastPublishedRun();

  const filtered = filterCandidates(candidates, {
    live,
    now,
    previousCategoryId: previous?.category_id ?? null,
  });

  if (!filtered.pass.length) {
    ctx.evidence.writeText(
      'keyword/decision.md',
      decisionMarkdown({
        now,
        candidates,
        rejected: filtered.rejected,
        reason: '1차 필터를 통과한 후보가 없습니다',
      }),
    );
    ctx.evidence.writeJson('keyword/decision.json', {
      rejected: filtered.rejected,
      selected: null,
    });
    return { type: 'finish', outcome: 'skipped-no-candidate' };
  }

  const judged = await ctx.judge.judgeTopics(
    filtered.pass.map((c) => ({ keyword: c.keyword, series: c.series })),
    live.map((l) => l.title),
  );
  const judgedByKeyword = new Map(judged.map((j) => [j.keyword, j]));

  const rejected = [...filtered.rejected];
  const surviving: TopicCandidate[] = [];
  for (const candidate of filtered.pass) {
    const verdict = judgedByKeyword.get(candidate.keyword);
    if (!verdict) {
      rejected.push({ keyword: candidate.keyword, reasons: ['judge-missing'] });
      continue;
    }
    if (!verdict.writable) {
      rejected.push({ keyword: candidate.keyword, reasons: ['judge-not-writable'] });
      continue;
    }
    if (
      verdict.seasonal &&
      isDuplicate(candidate.keyword, live, SEASONAL_DUPLICATE_WINDOW_DAYS, now)
    ) {
      rejected.push({ keyword: candidate.keyword, reasons: ['duplicate-seasonal-365d'] });
      continue;
    }
    surviving.push({
      ...candidate,
      writable: verdict.writable,
      seasonal: verdict.seasonal,
      angle: verdict.angle,
      reason: verdict.reason,
      productCriteria: verdict.productCriteria,
    });
  }

  if (!surviving.length) {
    ctx.evidence.writeText(
      'keyword/decision.md',
      decisionMarkdown({
        now,
        candidates,
        rejected,
        reason: 'LLM 판단에서 쓸 수 있는 주제가 없습니다',
      }),
    );
    return { type: 'finish', outcome: 'skipped-no-candidate' };
  }

  // 소재 보유 가점을 위해 인벤토리를 조회한다(설계 §5-1 REQUEST_ADS와 같은 조회).
  for (const candidate of surviving) {
    try {
      const inventory = await ctx.api.adsInventory({
        keyword: candidate.keyword,
        categoryId: candidate.categoryId,
        status: 'active',
      });
      candidate.adCount = inventory.items?.length ?? 0;
    } catch (error) {
      logger.warn({ keyword: candidate.keyword, error: String(error) }, '소재 조회 실패');
      candidate.adCount = 0;
    }
  }

  const ranked = rankTopics(surviving);
  const winner = ranked[0];
  const selected = winner.candidate;

  const slot = nextSlotOfKind(
    ctx.clock.now(),
    ctx.config.slots,
    ctx.config.jitterMinutes,
    'publish',
  );
  if (!slot) throw new RobotAbort('internal', '다음 발행 슬롯을 계산할 수 없습니다');

  const decision = {
    candidates: ranked.map((r) => ({
      keyword: r.candidate.keyword,
      score: r.score,
      adCount: r.candidate.adCount,
      categoryId: r.candidate.categoryId,
      series: r.candidate.series,
      blogs: r.candidate.blogs,
    })),
    rejected,
    selected: selected.keyword,
    angle: selected.angle ?? null,
    reason: selected.reason ?? null,
    productCriteria: selected.productCriteria ?? [],
    seasonal: selected.seasonal === true,
    publishSlot: slot.slot,
    normalized: normalizeKeyword(selected.keyword),
  };

  const planId = `plan-${kstCompact(ctx.clock.now())}`;
  ctx.store.insertPlan({
    id: planId,
    runId: ctx.run.id,
    keyword: selected.keyword,
    categoryId: selected.categoryId,
    decision,
    publishSlot: slot.slot,
    status: 'planned',
    createdAt: ctx.clock.now(),
  });

  ctx.evidence.writeJson('keyword/decision.json', decision);
  ctx.evidence.writeText(
    'keyword/decision.md',
    decisionMarkdown({
      now,
      candidates,
      rejected,
      selected,
      reason: selected.reason || '수요·포화·중복 조건을 모두 통과한 최상위 점수',
      seasonal: selected.seasonal,
    }),
  );

  return {
    type: 'next',
    step: 'REQUEST_ADS',
    patch: {
      plan_id: planId,
      keyword: selected.keyword,
      category_id: selected.categoryId ?? null,
    },
  };
};
