import * as path from 'path';
import { getLogger } from '@core/logger';
import { RobotAbort } from '../errors';
import { checkEditedDraft, extractH2Titles, extractImageSrcs, extractLinkHrefs } from '../policies';
import { pickUsableImages, probeImageFiles } from '../imageProbe';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

export const EDIT_ATTEMPTS = 3;

/** 로컬 생성 이미지 경로(`output/images/...` 또는 `/output/images/...`)를 절대 경로로 바꾼다. */
export function resolveLocalImagePath(
  src: string,
  env: { repoRoot: string; outputDir: string },
): string | null {
  const cleaned = src.split('?')[0];
  if (cleaned.startsWith('/output/'))
    return path.join(env.outputDir, cleaned.slice('/output/'.length));
  if (cleaned.startsWith('output/')) return path.join(env.repoRoot, cleaned);
  if (cleaned.startsWith('/images/'))
    return path.join(env.outputDir, cleaned.slice('/images/'.length));
  return null;
}

function removeImageTags(html: string, sources: Set<string>): string {
  if (!sources.size) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\bsrc=("([^"]*)"|'([^']*)')/i.exec(tag);
    const src = m ? (m[2] ?? m[3] ?? '') : '';
    return sources.has(src) ? '' : tag;
  });
}

/**
 * 이미지 정책(설계 §5-3): 손상 검사는 항상, 적합성 판정은 `review`에 따른다.
 * `drop`은 AI 이미지를 아예 쓰지 않고, `human`은 손상된 파일만 떼고 적합성은 승인 카드가 본다.
 */
async function applyImagePolicy(
  ctx: StepContext,
  html: string,
): Promise<{ html: string; notes: Record<string, unknown> }> {
  const srcs = extractImageSrcs(html).filter((src) => resolveLocalImagePath(src, ctx.env));
  const files = srcs.map((src) => resolveLocalImagePath(src, ctx.env) as string);

  if (ctx.config.images.review === 'drop') {
    return {
      html: removeImageTags(html, new Set(srcs)),
      notes: { review: 'drop', removed: srcs.length, images: [] },
    };
  }

  const probes = probeImageFiles(files);
  const broken = new Set(
    probes
      .filter((p) => !p.ok)
      .map((p) => srcs[files.indexOf(p.file)])
      .filter(Boolean),
  );

  let judgedNotes: unknown = null;
  if (ctx.config.images.review === 'vision' && probes.some((p) => p.ok)) {
    // 비전 입력 지원 여부가 확인되지 않았으므로(설계 §10-2) 픽셀 대신 섹션 맥락으로 판정한다.
    const verdicts = await ctx.judge.judgeImages({
      sectionTitles: extractH2Titles(html),
      images: pickUsableImages(files).map((p) => ({ file: path.basename(p.file) })),
    });
    judgedNotes = verdicts;
    for (const verdict of verdicts) {
      if (verdict.fits) continue;
      const src = srcs.find((s) => path.basename(s) === verdict.file);
      if (src) broken.add(src);
    }
  }

  const kept = srcs.filter((s) => !broken.has(s));
  return {
    html: removeImageTags(html, broken),
    notes: {
      review: ctx.config.images.review,
      probed: probes.map((p) => ({
        file: path.basename(p.file),
        ok: p.ok,
        width: p.width,
        height: p.height,
        bytes: p.bytes,
        reason: p.reason ?? null,
      })),
      removed: [...broken],
      kept: kept.length,
      judged: judgedNotes,
    },
  };
}

/** 본문 링크 확인 — 2xx/3xx만 통과. 실패 목록을 돌려준다. */
async function checkBodyLinks(ctx: StepContext, html: string): Promise<string[]> {
  const hrefs = [...new Set(extractLinkHrefs(html))].filter((href) => /^https?:\/\//i.test(href));
  const failures: string[] = [];
  for (const href of hrefs) {
    const status = await ctx.http.status(href, { timeoutMs: 20_000 });
    if (status < 200 || status >= 400) failures.push(`${href} → ${status}`);
  }
  return failures;
}

/**
 * EDIT — LLM 편집 → 규칙 검증 → 링크·이미지 확인 → 저장(설계 §5-1).
 * 매 시도는 원본(`draft/generated.html`)에서 시작한다. 위반을 되먹여 최대 3회,
 * 그래도 남으면 `aborted-edit-gate`.
 */
export const edit: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  if (!ctx.run.draft_id) throw new RobotAbort('internal', 'draft_id가 없습니다');
  const original = ctx.evidence.readText('draft/generated.html');
  if (!original) throw new RobotAbort('internal', 'draft/generated.html이 없습니다');

  const plan = ctx.run.plan_id ? ctx.store.getPlan(ctx.run.plan_id) : null;
  const decisionSummary = plan
    ? `${plan.keyword} / ${String(plan.decision?.reason ?? '수요·포화·중복 조건 통과')}`
    : (ctx.run.keyword ?? '');

  let violations: string[] = [];
  for (let attempt = 1; attempt <= EDIT_ATTEMPTS; attempt += 1) {
    ctx.signal.throwIfAborted();
    const judged = await ctx.judge.editDraft({
      html: original,
      keyword: ctx.run.keyword ?? '',
      decisionSummary,
      violations,
    });

    const checks = checkEditedDraft(original, judged.html);
    if (checks.length) {
      violations = checks.map((v) => v.message);
      ctx.evidence.writeJson(`draft/edit-attempt-${attempt}.json`, {
        violations: checks,
        title: judged.title,
      });
      logger.warn({ attempt, violations }, '편집 게이트 위반 — 재시도');
      continue;
    }

    const linkFailures = await checkBodyLinks(ctx, judged.html);
    if (linkFailures.length) {
      violations = linkFailures.map((f) => `broken-link: ${f}`);
      ctx.evidence.writeJson(`draft/edit-attempt-${attempt}.json`, { linkFailures });
      continue;
    }

    const images = await applyImagePolicy(ctx, judged.html);
    ctx.evidence.writeText('draft/edited.html', images.html);
    ctx.evidence.writeText('draft/title.txt', judged.title);
    ctx.evidence.writeJson('draft/images.json', images.notes);
    ctx.evidence.writeJson(`draft/edit-attempt-${attempt}.json`, { ok: true, title: judged.title });

    await ctx.api.putPost(ctx.run.draft_id, {
      title: judged.title,
      content: images.html,
      tags: judged.tags,
    });

    const removed = (images.notes.removed as string[] | undefined) ?? [];
    return {
      type: 'next',
      step: 'PLACE_ADS',
      patch: {
        warnings: [
          ...(ctx.run.warnings ?? []),
          ...removed.map((src) => `image-removed:${path.basename(src)}`),
        ],
      },
    };
  }

  ctx.evidence.writeJson('draft/edit-gate.json', { violations });
  throw new RobotAbort('edit-gate', `편집 게이트를 통과하지 못했습니다: ${violations.join('; ')}`);
};
