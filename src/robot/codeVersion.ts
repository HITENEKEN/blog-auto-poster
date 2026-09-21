import { execFile } from 'child_process';

/**
 * 실행 코드 버전(설계 §2-2 `code_version`): `git rev-parse HEAD` (+dirty).
 * 우선순위: env `BLOG_POSTER_CODE_VERSION` → git → 'unknown'(git 실패·저장소 아님).
 * 규칙이 코드로 옮겨 왔으므로 스킬 §10의 `rulesHash`를 이 값이 대체한다(설계 §2-3).
 */

export const UNKNOWN_CODE_VERSION = 'unknown';

export interface CodeVersionOptions {
  env?: Record<string, string | undefined>;
  /** 테스트 주입용 — 실패 시 reject. */
  exec?: (command: string, args: string[], cwd: string) => Promise<string>;
}

const defaultExec = (command: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 10_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

/** 빈 문자열은 절대 돌려주지 않는다(증거·run 행에 ''가 남으면 원인 추적이 불가능하다). */
export async function resolveCodeVersion(
  repoRoot: string,
  options: CodeVersionOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const fromEnv = (env.BLOG_POSTER_CODE_VERSION || '').trim();
  if (fromEnv) return fromEnv;

  const exec = options.exec ?? defaultExec;
  try {
    const head = (await exec('git', ['rev-parse', 'HEAD'], repoRoot)).trim();
    if (!head) return UNKNOWN_CODE_VERSION;
    const status = (await exec('git', ['status', '--porcelain'], repoRoot)).trim();
    return status ? `${head}-dirty` : head;
  } catch {
    return UNKNOWN_CODE_VERSION;
  }
}
