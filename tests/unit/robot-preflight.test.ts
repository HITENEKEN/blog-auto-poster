import { describe, expect, it } from 'vitest';
import { createFakeApi, createScenario, driveToEnd, type FakeApi } from './robot-helpers';

/**
 * PREFLIGHT 깨우기(설계 §0·§4-1): 재기동 직후 `/health`가 아직 플랫폼 어댑터를 실현하지
 * 못해 `platforms.naver`가 true가 아닐 때, `/api/blogs`를 1회 호출해 깨운 뒤 `/health`를
 * 최대 2회 재조회한다. 그래도 안 되면 중단한다.
 */

/**
 * `health()`를 상태를 갖는 가짜로 바꾼다 — `readyAfterCall`번째 호출부터
 * `platforms.naver: true`를 돌려준다(그 전에는 누락 상태를 흉내 낸다).
 */
function createStatefulHealthApi(readyAfterCall: number): FakeApi {
  const api = createFakeApi();
  let calls = 0;
  api.health = async () => {
    calls += 1;
    api.calls.push('health');
    const naverReady = calls >= readyAfterCall;
    return {
      status: 'ok',
      services: {
        // naver 키를 통째로 빼서 "재기동 직후 실현되지 않은" 상태를 흉내 낸다.
        platforms: naverReady
          ? { naver: true, tistory: false, wordpress: false, 'youtube-shorts': false }
          : {},
        scheduler: 'stopped',
        naverSession: { expiresAt: '2027-01-01T00:00:00.000Z', daysLeft: 30 },
      },
    };
  };
  return api;
}

describe('PREFLIGHT — 플랫폼 어댑터 깨우기', () => {
  it('두 번째 health() 재조회에서 naver가 true가 되면 깨우기 1회로 정상 진행한다', async () => {
    const api = createStatefulHealthApi(2); // 1번째 호출은 아직, 2번째부터 true
    const scenario = createScenario({ api });
    const run = scenario.createRun('plan', { plan: false });

    const result = await driveToEnd(scenario, run.id);

    expect(result.outcome).toBe('planned');
    expect(api.calls.filter((c) => c === 'blogs').length).toBe(1);
    expect(api.calls.filter((c) => c === 'health').length).toBe(2);
  });

  it('최대 재조회(2회)를 다 써도 naver가 없으면 중단한다', async () => {
    // 4번째 호출부터 true가 되도록 해, 깨우기의 재조회 2회(총 3회 호출) 안에 들지 못하게 한다.
    const api = createStatefulHealthApi(4);
    const scenario = createScenario({ api });
    const run = scenario.createRun('plan', { plan: false });

    const result = await driveToEnd(scenario, run.id);

    expect(result.outcome).toBe('aborted-health');
    expect(api.calls.filter((c) => c === 'blogs').length).toBe(1);
    // 최초 1회 + 재조회 2회 = 3회에서 멈춘다(4번째는 호출하지 않는다).
    expect(api.calls.filter((c) => c === 'health').length).toBe(3);
  });

  it('처음부터 naver가 true면 깨우기를 시도하지 않는다', async () => {
    const scenario = createScenario(); // 기본 FakeApi는 처음부터 platforms.naver: true
    const run = scenario.createRun('plan', { plan: false });

    const result = await driveToEnd(scenario, run.id);

    expect(result.outcome).toBe('planned');
    expect(scenario.api.calls.filter((c) => c === 'blogs').length).toBe(0);
    expect(scenario.api.calls.filter((c) => c === 'health').length).toBe(1);
  });
});
