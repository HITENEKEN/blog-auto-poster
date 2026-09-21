import { getLogger } from '@core/logger';
import type { PublishLogEntry } from '../evidence';
import { kstIso } from '../kst';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** 실행 outcome → `robot_runs.status`. */
export function statusForOutcome(outcome: string): 'done' | 'skipped' | 'aborted' {
  if (outcome.startsWith('aborted')) return 'aborted';
  if (outcome.startsWith('skipped')) return 'skipped';
  return 'done';
}

function readJson(ctx: StepContext, relative: string): Record<string, unknown> | null {
  const raw = ctx.evidence.readText(relative);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 사용한 소재 id를 실행 증거(`ads/placement.json`)에서 뽑는다. */
export function placedAdIds(placement: Record<string, unknown> | null): string[] {
  const ads = placement?.ads;
  if (!Array.isArray(ads)) return [];
  const ids: string[] = [];
  for (const ad of ads) {
    if (!ad || typeof ad !== 'object') continue;
    const id = String((ad as Record<string, unknown>).id ?? '');
    if (id) ids.push(id);
  }
  return ids;
}

/**
 * 인벤토리 `used_count` 반영(설계 §5-1 RECORD "인벤토리 used_count 반영").
 * 로봇은 DB를 직접 쓰지 않으므로 `PATCH /api/ads/inventory/:id {markUsed:true}`를 부른다.
 *
 * 멱등성: RECORD는 `finish` 뒤 최선 노력으로 한 번 더 돌 수 있고 재개될 수도 있으므로
 * **실행·광고별**로 `robot_state`에 `ads-used:<runId>:<adId>`를 남겨 이중 집계를 막는다.
 * 실제로 발행된 실행(outcome published / published-with-warnings)에서만 호출한다.
 */
async function reflectUsedAds(ctx: StepContext, outcome: string): Promise<string[]> {
  const warnings: string[] = [];
  if (ctx.run.kind !== 'publish') return warnings;
  if (outcome !== 'published' && outcome !== 'published-with-warnings') return warnings;

  const ids = placedAdIds(readJson(ctx, 'ads/placement.json'));
  for (const adId of ids) {
    const guardKey = `ads-used:${ctx.run.id}:${adId}`;
    if (ctx.store.getState(guardKey)) continue;
    try {
      await ctx.api.markAdUsed(adId);
      ctx.store.setState(guardKey, ctx.clock.now().toISOString(), ctx.clock.now());
    } catch (error) {
      logger.warn({ adId, error: String(error) }, 'used_count 반영 실패');
      warnings.push(`ads-mark-used-failed:${adId}`);
    }
  }
  return warnings;
}

/**
 * RECORD — 증거·판정 기록(스킬 §10, 설계 §5-1). `finish`가 나면 드라이버가
 * **최선 노력**으로 한 번 더 부르므로 멱등해야 한다(`publish-log.jsonl`은 runId로,
 * used_count 반영은 실행·광고별 상태 키로 중복을 막는다).
 */
export const record: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const now = ctx.clock.now();
  const outcome = ctx.run.outcome ?? 'done';
  const steps = ctx.store.listSteps(ctx.run.id);
  ctx.evidence.ensure('robot');

  // 0) 사용한 소재의 used_count 반영(멱등)
  const adsWarnings = await reflectUsedAds(ctx, outcome);
  if (adsWarnings.length) {
    ctx.store.updateRun(ctx.run.id, { warnings: [...(ctx.run.warnings ?? []), ...adsWarnings] });
  }
  const current = ctx.store.getRun(ctx.run.id) ?? ctx.run;

  // 1) 단계 덤프 + 실행 원장(스킬 §10: run.json은 런 디렉터리 루트)
  ctx.evidence.writeJson('robot/steps.json', steps);

  // 2) 연속 통과 수 — 자동 전환 "권장" 판단에만 쓴다(실제 전환은 사람이 mode를 바꾼다).
  if (current.kind === 'publish') {
    const passed = outcome === 'published';
    const next = passed ? ctx.store.getConsecutivePasses() + 1 : 0;
    ctx.store.setConsecutivePasses(next, now);
    if (passed && next === ctx.config.autoPromoteAfterPasses) {
      ctx.notify.notify(`${next}회 연속 통과 — 자동 모드 전환을 검토하세요`);
    }
  }

  // 3) publish-log.jsonl (스킬 §10 1줄 규약). 발행 실행만 남긴다.
  if (ctx.run.kind === 'publish') {
    const decision = readJson(ctx, 'keyword/decision.json') ?? readJson(ctx, 'ads/resolve.json');
    const gateResult = readJson(ctx, 'draft/gate.json');
    const verifyResults = readJson(ctx, 'verify/results.json');
    const entry: PublishLogEntry = {
      runId: ctx.run.id,
      codeVersion: current.code_version || ctx.env.codeVersion,
      keyword: current.keyword ?? null,
      keywordDecision: decision,
      draftId: current.draft_id ?? null,
      content: { htmlSha256: current.preview_sha256 ?? null, aiPolish: false },
      images: readJson(ctx, 'draft/images.json'),
      publish: {
        attempts: current.publish_started_at ? 1 : 0,
        visibility: 'public',
        logNo: current.log_no ?? null,
        url: current.url ?? null,
        warnings: current.warnings ?? [],
      },
      verification: { results: verifyResults, gate: gateResult },
      outcome,
      unresolved: current.warnings ?? [],
    };
    ctx.evidence.appendPublishLog(entry);
  }

  // 4) 실행 행을 먼저 확정하고, 그 값으로 run.json을 쓴다(증거가 'running'으로 남지 않도록).
  const finishedAt = current.finished_at ?? kstIso(now);
  const finalStatus = statusForOutcome(outcome);
  const finalRun = ctx.store.updateRun(ctx.run.id, {
    outcome,
    status: finalStatus,
    finished_at: finishedAt,
  });
  ctx.evidence.writeJson('run.json', finalRun);

  // 5) 한국어 운영 보고
  ctx.evidence.writeReport([
    `# 실행 보고 — ${ctx.run.id}`,
    '',
    `- 종류: ${ctx.run.kind} / 트리거: ${ctx.run.trigger} / 모드: ${ctx.run.mode}`,
    `- 슬롯: ${ctx.run.slot}`,
    `- 키워드: ${current.keyword ?? '(없음)'}`,
    `- 초안: ${current.draft_id ?? '(없음)'}`,
    `- logNo: ${current.log_no ?? '(없음)'}`,
    `- URL: ${current.url ?? '(없음)'}`,
    `- 결과: ${finalRun.outcome ?? outcome} (status ${finalRun.status})`,
    `- 경고: ${(current.warnings ?? []).join(', ') || '없음'}`,
    `- 시작: ${finalRun.started_at} / 종료: ${finishedAt}`,
    '',
    '## 단계',
    '',
    ...steps.map((step) => `- ${step.step} #${step.attempt} ${step.status} (${step.started_at})`),
  ]);

  ctx.notify.notify(`실행 종료: ${outcome}${ctx.run.keyword ? ` (${ctx.run.keyword})` : ''}`);
  logger.info({ runId: ctx.run.id, outcome }, 'RECORD 완료');

  return { type: 'finish', outcome };
};
