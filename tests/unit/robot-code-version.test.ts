import { describe, expect, it } from 'vitest';
import { UNKNOWN_CODE_VERSION, resolveCodeVersion } from '../../src/robot/codeVersion';

/** 실행 코드 버전 해석(설계 §2-2 `code_version`): env → git HEAD(+dirty) → unknown. */

function fakeGit(head: string, porcelain: string) {
  return async (_command: string, args: string[]) =>
    args[0] === 'rev-parse' ? `${head}\n` : porcelain;
}

describe('resolveCodeVersion', () => {
  it('env가 있으면 그대로 쓴다', async () => {
    const env = { BLOG_POSTER_CODE_VERSION: 'from-env' };
    expect(await resolveCodeVersion('/repo', { env, exec: fakeGit('abc', '') })).toBe('from-env');
  });

  it('워킹트리가 깨끗하면 HEAD 해시', async () => {
    expect(await resolveCodeVersion('/repo', { env: {}, exec: fakeGit('abc1234', '') })).toBe(
      'abc1234',
    );
  });

  it('변경이 있으면 -dirty가 붙는다', async () => {
    const dirty = await resolveCodeVersion('/repo', {
      env: {},
      exec: fakeGit('abc1234', ' M src/robot/index.ts\n'),
    });
    expect(dirty).toBe('abc1234-dirty');
  });

  it('git 실패·저장소 아님은 unknown(빈 문자열 금지)', async () => {
    const failing = async () => {
      throw new Error('not a git repository');
    };
    expect(await resolveCodeVersion('/repo', { env: {}, exec: failing })).toBe(
      UNKNOWN_CODE_VERSION,
    );
    expect(UNKNOWN_CODE_VERSION).not.toBe('');
  });
});
