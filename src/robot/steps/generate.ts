import { RobotAbort } from '../errors';
import type { StepContext, StepHandler, StepResult } from './types';

/** 초안 생성 폴링(설계 §5-1): 15초 간격, 최대 15분. */
export const GENERATE_POLL_MS = 15_000;
export const GENERATE_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * GENERATE — `POST /api/posts/generate-from-keyword` → 폴링.
 * `draft_id`가 이미 있으면 POST를 생략하고 폴링만 한다(멱등 기준 §5-1).
 * `generationStatus=failed`면 `aborted-llm`으로 발행을 막는다(스킬 §12).
 */
export const generate: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.keyword) throw new RobotAbort('internal', 'keyword가 없습니다');
  ctx.evidence.ensure('draft');

  let draftId = ctx.run.draft_id ?? null;
  if (!draftId) {
    const { post } = await ctx.api.generateFromKeyword({
      keyword: ctx.run.keyword,
      template: ctx.env.template,
    });
    draftId = post?.id ?? null;
    if (!draftId) throw new RobotAbort('llm', '초안 생성 응답에 post.id가 없습니다');
    // 크래시 복구를 위해 즉시 커밋한다(이후 재개는 폴링만 한다).
    ctx.store.updateRun(ctx.run.id, { draft_id: draftId });
  }

  const deadline = ctx.clock.now().getTime() + GENERATE_TIMEOUT_MS;
  let post: Record<string, unknown> = {};
  for (;;) {
    ctx.signal.throwIfAborted();
    const response = await ctx.api.getPost(draftId);
    post = response.post ?? {};
    const status = String(post.generationStatus ?? '');
    if (status === 'failed') {
      throw new RobotAbort('llm', '초안 생성이 실패했습니다(generationStatus=failed)');
    }
    if (status !== 'generating' && post.content) break;
    if (ctx.clock.now().getTime() > deadline) {
      throw new RobotAbort('llm', '초안 생성이 15분 안에 끝나지 않았습니다');
    }
    await ctx.sleep(GENERATE_POLL_MS);
  }

  const html = String(post.content ?? '');
  if (!html) throw new RobotAbort('llm', '초안 본문이 비어 있습니다');
  ctx.evidence.writeText('draft/generated.html', html);
  ctx.evidence.writeJson('draft/meta.json', {
    draftId,
    title: post.title ?? null,
    generationStatus: post.generationStatus ?? null,
    fetchedAt: ctx.clock.now().toISOString(),
  });

  return { type: 'next', step: 'EDIT', patch: { draft_id: draftId } };
};
