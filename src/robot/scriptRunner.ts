import { spawn } from 'child_process';
import { getLogger } from '@core/logger';
import type { ScriptRunner } from './steps/types';

const logger = getLogger('robot');

/** 스크립트 타임아웃은 스킬 §9의 종료 코드 2(하네스 오류)로 취급한다. */
export const SCRIPT_TIMEOUT_EXIT = 2;

/**
 * 검증 스크립트(`scripts/inspect-published-post.mjs`, `scripts/verify-reader-view.mjs`)를
 * 자식 프로세스로 실행한다. 종료 코드 0/1/2를 그대로 돌려준다.
 */
export function createScriptRunner(): ScriptRunner {
  return {
    run: (command, args, opts = {}) => {
      const { promise, resolve } = Promise.withResolvers<{
        code: number;
        stdout: string;
        stderr: string;
      }>();
      const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
      let stdout = '';
      let stderr = '';
      let settled = false;

      const child = spawn(command, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        stderr += `\n[timeout] ${timeoutMs}ms 초과 — 프로세스를 종료합니다\n`;
        child.kill('SIGKILL');
        resolve({ code: SCRIPT_TIMEOUT_EXIT, stdout, stderr });
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf-8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8');
      });
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        logger.warn({ command, error: String(error) }, '스크립트 실행 실패');
        resolve({ code: SCRIPT_TIMEOUT_EXIT, stdout, stderr: `${stderr}${String(error)}` });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? SCRIPT_TIMEOUT_EXIT, stdout, stderr });
      });

      return promise;
    },
  };
}
