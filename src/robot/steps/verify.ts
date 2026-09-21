import * as path from 'path';
import { getLogger } from '@core/logger';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

export const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;

interface VerifyScript {
  name: string;
  args: string[];
  /** 스킬 §9의 종료 코드 0/1/2를 그대로 기록한다. */
  logFile: (runId: string) => string;
}

/**
 * VERIFY — 스킬 §9의 검증 하네스를 자식 프로세스로 돌린다(설계 §5-1).
 * 각 5분 타임아웃, 종료 코드 0 통과 / 1 실패 / 2 하네스 오류.
 * 1이 하나라도 있으면 `published-with-warnings`, 2는 1회 재실행 후 같으면 기록한다.
 * 발행물은 수정할 수 없으므로 **재발행하지 않는다**(스킬 §12).
 */
export const verify: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  const logNo = ctx.run.log_no;
  if (!logNo) throw new Error('log_no 없이 VERIFY에 진입했습니다');
  ctx.evidence.ensure('verify');

  const verifyDir = ctx.evidence.pathIn('verify');
  const draftDir = path.join(ctx.env.outputDir, 'posts', ctx.run.draft_id ?? '');
  const scriptRunner = (script: string, extra: string[]) => [
    path.join(ctx.env.repoRoot, 'scripts', script),
    logNo,
    ctx.env.blogId,
    '--out',
    verifyDir,
    ...extra,
  ];

  const scripts: VerifyScript[] = [
    {
      name: 'inspector',
      args: [
        path.join(ctx.env.repoRoot, 'scripts', 'inspect-published-post.mjs'),
        logNo,
        ctx.env.blogId,
      ],
      logFile: () => `${logNo}-inspector.txt`,
    },
    {
      name: 'reader',
      args: scriptRunner('verify-reader-view.mjs', ['--json']),
      logFile: (runId) => `${runId}-reader.log`,
    },
    {
      name: 'links',
      args: scriptRunner('verify-reader-view.mjs', ['--links']),
      logFile: (runId) => `${runId}-links.log`,
    },
    {
      name: 'compliance',
      args: scriptRunner('verify-reader-view.mjs', ['--compliance', draftDir]),
      logFile: (runId) => `${runId}-compliance.log`,
    },
    {
      name: 'anon',
      args: scriptRunner('verify-reader-view.mjs', ['--anon']),
      logFile: (runId) => `${runId}-anon.log`,
    },
  ];

  const results: Record<string, number> = {};
  const warnings: string[] = [];

  for (const script of scripts) {
    ctx.signal.throwIfAborted();
    let outcome = await ctx.runScript.run('node', script.args, {
      timeoutMs: VERIFY_TIMEOUT_MS,
      cwd: ctx.env.repoRoot,
    });
    if (outcome.code === 2) {
      // 하네스 오류는 1회 재실행 후 같은 결과면 그대로 기록한다(스킬 §9).
      logger.warn({ script: script.name }, '검증 하네스 오류 — 1회 재실행');
      outcome = await ctx.runScript.run('node', script.args, {
        timeoutMs: VERIFY_TIMEOUT_MS,
        cwd: ctx.env.repoRoot,
      });
    }
    results[script.name] = outcome.code;
    ctx.evidence.writeText(
      `verify/${script.logFile(ctx.run.id)}`,
      `${outcome.stdout}${outcome.stderr ? `\n[stderr]\n${outcome.stderr}` : ''}`,
    );
    if (outcome.code !== 0) warnings.push(`verify-${script.name}:${outcome.code}`);
  }

  ctx.evidence.writeJson('verify/results.json', results);
  const allPassed = Object.values(results).every((code) => code === 0);
  return {
    type: 'next',
    step: 'RECORD',
    patch: {
      outcome: allPassed ? 'published' : 'published-with-warnings',
      warnings: [...(ctx.run.warnings ?? []), ...warnings],
    },
  };
};
