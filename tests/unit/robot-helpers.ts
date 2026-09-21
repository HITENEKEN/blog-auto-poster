import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RobotRunner, type RunnerDeps } from '../../src/robot/RobotRunner';
import type { DaemonDeps } from '../../src/robot/index';
import { kstCompact } from '../../src/robot/kst';
import { FakeClock } from '../../src/robot/RobotScheduler';
import { RobotStore, type PlanStatus, type RunKind, type RunRow } from '../../src/robot/RobotStore';
import type {
  AdInventoryItem,
  CategoryOverviewResult,
  DashboardApi,
  GateResult,
  HealthResponse,
  KeywordBlogsResult,
  PlaceAdsResult,
  PublishResult,
  TrendResult,
} from '../../src/robot/DashboardClient';
import type { HttpClient } from '../../src/robot/http';
import { HttpError, TransientError } from '../../src/robot/errors';
import type { Judge, JudgedDraft, JudgedImage, JudgedTopic } from '../../src/robot/Judge';
import type { RobotConfig } from '../../src/robot/config';
import { ROBOT_CONFIG_DEFAULTS } from '../../src/robot/config';
import type { ScriptRunner } from '../../src/robot/steps/types';
import type { Notifier } from '../../src/robot/notify';

/**
 * 로봇 유닛 테스트용 가짜 구현 모음. 모든 가짜는 **실제 네트워크·블로그를 건드리지 않는다**
 * (설계 §8: 발행 호출 횟수는 실행당 최대 1, 테스트는 실제 네이버 블로그에 접촉 금지).
 */

export const RSS_URL = 'https://rss.blog.naver.com/hiteneken.xml';
export const POST_LIST_URL =
  'https://blog.naver.com/PostList.naver?blogId=hiteneken&widgetTypeCall=true&noTrackingCode=true&directAccess=false';

export function tempDir(prefix = 'robot-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FakeApi extends DashboardApi {
  publishCalls: number;
  calls: string[];
  /** markUsed 호출 기록(멱등성 검증용). */
  markUsedCalls: string[];
  markUsedFails?: boolean;
  /** 발행 성공 시 호출된다 — 시나리오가 라이브 RSS에 새 글을 반영하는 데 쓴다. */
  onPublished?: () => void;
  /** publish 동작: ok | timeout(TransientError) | 500 | 409(PREVIEW_CHANGED) */
  publishMode: 'ok' | 'timeout' | '500' | '409';
  gateResult: GateResult;
  /** keyword/categoryId 별 소재 수 */
  adCounts: Record<string, number>;
  generationStatus: string;
  warnings: string[];
}

export function createFakeApi(overrides: Partial<FakeApi> = {}): FakeApi {
  const api: Partial<FakeApi> = {
    publishCalls: 0,
    calls: [],
    markUsedCalls: [],
    publishMode: 'ok',
    adCounts: {},
    generationStatus: 'ready',
    warnings: [],
  };

  const recorded = <T>(name: string, value: T): T => {
    api.calls!.push(name);
    return value;
  };

  Object.assign(api, {
    ensureToken: async () => recorded('ensureToken', undefined),
    health: async (): Promise<HealthResponse> =>
      recorded('health', {
        status: 'ok',
        services: {
          platforms: { naver: true, tistory: false, wordpress: false, 'youtube-shorts': false },
          scheduler: 'stopped',
          naverSession: { expiresAt: '2027-01-01T00:00:00.000Z', daysLeft: 30 },
        },
      }),
    adsInventory: async (params: { keyword?: string; categoryId?: string; status?: string }) => {
      const key = params.keyword ?? params.categoryId ?? 'default';
      const count = api.adCounts![key] ?? 3;
      const items: AdInventoryItem[] = Array.from({ length: count }, (_, i) => ({
        id: `ad-${key}-${i}`,
        source: 'manual',
        productName: `상품 ${i}`,
        url: `https://link.coupang.com/a/${key}${i}`,
        keywords: [key],
        status: 'active',
        usedCount: 0,
      }));
      return recorded('adsInventory', { items });
    },
    createAdRequest: async (input: { keyword: string }) =>
      recorded('createAdRequest', { request: { id: `req-${input.keyword}` } }),
    categoryOverview: async (): Promise<CategoryOverviewResult> =>
      recorded('categoryOverview', {
        categoryValid: true,
        clickTrend: weeklySeries(8, 50),
        keywords: [{ keyword: '트위드자켓' }, { keyword: '울코트' }],
      }),
    searchTrend: async (): Promise<TrendResult> =>
      recorded('searchTrend', { series: [{ data: weeklySeries(16, 60) }] }),
    keywordBlogs: async (): Promise<KeywordBlogsResult> => recorded('keywordBlogs', { total: 100 }),
    generateFromKeyword: async () => recorded('generateFromKeyword', { post: { id: 'post-1' } }),
    getPost: async () =>
      recorded('getPost', {
        post: {
          id: 'post-1',
          title: '트위드 자켓 구매 가이드',
          generationStatus: api.generationStatus,
          content: SAMPLE_HTML,
        },
      }),
    putPost: async () => recorded('putPost', {}),
    markAdUsed: async (adId: string) => {
      api.calls!.push(`markAdUsed:${adId}`);
      api.markUsedCalls!.push(adId);
      if (api.markUsedFails) throw new HttpError(500, 'markUsed failed');
      return { item: { id: adId, usedCount: 1 } };
    },
    placeAds: async (): Promise<PlaceAdsResult> =>
      recorded('placeAds', {
        html: SAMPLE_HTML,
        slots: [{ afterSection: 3 }],
        ads: [{ id: 'ad-1' }, { id: 'ad-2' }],
        disclosure: true,
      }),
    gate: async (): Promise<GateResult> => recorded('gate', api.gateResult!),
    publish: async (): Promise<PublishResult> => {
      api.publishCalls = (api.publishCalls ?? 0) + 1;
      api.calls!.push('publish');
      if (api.publishMode === 'timeout') throw new TransientError('publish timeout');
      if (api.publishMode === '500') throw new TransientError('publish → 500');
      if (api.publishMode === '409')
        throw new HttpError(409, 'PREVIEW_CHANGED', { error: 'PREVIEW_CHANGED' });
      api.onPublished?.();
      return { results: [{ platform: 'naver', success: true, warnings: api.warnings ?? [] }] };
    },
  });

  api.gateResult = {
    ok: true,
    violations: [],
    previewSha256: 'sha-1',
    previewHtmlPath: undefined,
  };

  // 스프레드로 새 객체를 만들면 클로저가 원본을 계속 가리키므로 **같은 객체를 변형**한다.
  Object.assign(api, overrides);
  return api as FakeApi;
}

export function weeklySeries(
  count: number,
  base: number,
): Array<{ period: string; ratio: number }> {
  return Array.from({ length: count }, (_, i) => ({
    period: `2026-W${String(i + 1).padStart(2, '0')}`,
    ratio: base + i,
  }));
}

export const SAMPLE_HTML = [
  '<h2>1. 소재</h2><p>본문</p><img src="output/images/a.png">',
  '<h2>2. 기준</h2><p>본문</p>',
  '<h2>3. 선택</h2><p>본문</p>',
  '<h2>4. 관리</h2><p>본문</p>',
  '<h2>5. 사이즈</h2><p>본문</p>',
  '<h2>6. 가격</h2><p>본문</p>',
  '<h2>7. 자주 묻는 질문</h2><p>본문</p>',
].join('\n');

export function rssXml(items: Array<{ title: string; logNo: string; pubDate: string }>): string {
  const blocks = items
    .map(
      (item) => `<item><title><![CDATA[${item.title}]]></title>
<link>https://blog.naver.com/hiteneken/${item.logNo}</link>
<pubDate>${item.pubDate}</pubDate></item>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
<title>hiteneken</title>
${blocks}
</channel></rss>`;
}

export const BASE_RSS_ITEMS = [
  { title: '무선청소기 고르는 기준', logNo: '111111111111', pubDate: '2026-08-01T12:00:00+09:00' },
];

export const BASE_RSS = rssXml(BASE_RSS_ITEMS);

/** 시나리오가 발행 성공을 반영할 때 쓰는 logNo. */
export const DEFAULT_PUBLISHED_LOG_NO = '222222222222';

export interface FakeHttp extends HttpClient {
  bodies: Record<string, string>;
  statuses: Record<string, number>;
  requests: string[];
  setBody(url: string, body: string): void;
}

export function createFakeHttp(bodies: Record<string, string> = {}): FakeHttp {
  const http: FakeHttp = {
    bodies: { [RSS_URL]: BASE_RSS, [POST_LIST_URL]: '<html></html>', ...bodies },
    statuses: {},
    requests: [],
    setBody(url: string, body: string) {
      http.bodies[url] = body;
    },
    async getText(url: string) {
      http.requests.push(url);
      const body = http.bodies[url];
      if (body === undefined) throw new TransientError(`no fake body for ${url}`);
      return body;
    },
    async status(url: string) {
      http.requests.push(`HEAD ${url}`);
      return http.statuses[url] ?? 200;
    },
  };
  return http;
}

export function createFakeJudge(overrides: Partial<Judge> = {}): Judge {
  const judge = {
    judgeTopics: async (): Promise<JudgedTopic[]> => [
      {
        keyword: '트위드자켓',
        writable: true,
        seasonal: false,
        angle: '소재와 사이즈 기준',
        reason: '최근 4주 견조, 문서량 낮음',
        productCriteria: ['안감 있는 울 혼방', '55-66 사이즈', '무료 반품'],
      },
    ],
    editDraft: async (input: { html: string }): Promise<JudgedDraft> => ({
      title: '트위드 자켓 구매 가이드',
      html: input.html,
      tags: ['트위드자켓', '구매가이드'],
    }),
    judgeImages: async (): Promise<JudgedImage[]> => [],
    ...overrides,
  };
  return judge as unknown as Judge;
}

export function createFakeRunScript(codes: Record<string, number> = {}): ScriptRunner & {
  runs: string[];
} {
  const runner = {
    runs: [] as string[],
    run: async (command: string, args: string[]) => {
      const script = args[0] ?? command;
      runner.runs.push(script);
      return { code: codes[path.basename(script)] ?? 0, stdout: `ran ${script}`, stderr: '' };
    },
  };
  return runner;
}

/** 테스트에서 주입하는 구성 — 기본값은 설계 §6과 같다. */
export function makeConfig(overrides: Partial<RobotConfig> = {}): RobotConfig {
  return {
    ...ROBOT_CONFIG_DEFAULTS,
    categories: ['50000000'],
    enabled: true,
    mode: 'manual',
    ...overrides,
  };
}

export interface Scenario {
  store: RobotStore;
  clock: FakeClock;
  api: FakeApi;
  http: FakeHttp;
  judge: Judge;
  runScript: ReturnType<typeof createFakeRunScript>;
  notify: Notifier & { messages: string[] };
  config: RobotConfig;
  root: string;
  evidenceRoot: string;
  makeRunner(overrides?: Partial<RunnerDeps>): RobotRunner;
  daemonDeps(): DaemonDeps;
  createRun(kind: RunKind, options?: { slot?: string; plan?: boolean; keyword?: string }): RunRow;
}

export interface ScenarioOptions {
  api?: FakeApi;
  config?: Partial<RobotConfig>;
  http?: FakeHttp;
  judge?: Judge;
  scriptCodes?: Record<string, number>;
  /**
   * 발행 성공 시 라이브 RSS에 새 글을 반영할지(기본 true). false면 RSS가 그대로라
   * RECONCILE이 `aborted-unconfirmed`로 끝난다 — 지연·미확인 시나리오가 이 값을 쓴다.
   */
  rssReflectsPublish?: boolean;
  /** 발행된 것으로 취급할 logNo. */
  publishedLogNo?: string;
}

/** 임시 디렉터리 + 가짜 의존성으로 완전한 실행 환경을 만든다. */
export function createScenario(options: ScenarioOptions = {}): Scenario {
  const root = tempDir();
  const evidenceRoot = path.join(root, 'data', 'ops');
  const clock = new FakeClock(new Date('2026-09-22T21:10:00+09:00'));
  const store = new RobotStore(path.join(root, 'data', 'robot.sqlite'));
  const api = options.api ?? createFakeApi();
  const http = options.http ?? createFakeHttp();
  const judge = options.judge ?? createFakeJudge();
  const runScript = createFakeRunScript(options.scriptCodes);
  const messages: string[] = [];
  const notify: Notifier & { messages: string[] } = {
    messages,
    notify: (message: string) => {
      messages.push(message);
    },
  };
  const config = makeConfig(options.config);
  const publishedLogNo = options.publishedLogNo ?? DEFAULT_PUBLISHED_LOG_NO;
  if (options.rssReflectsPublish !== false) {
    api.onPublished = () => {
      const publishedAt = new Date(clock.now().getTime() + 2 * 60_000).toISOString();
      http.setBody(
        RSS_URL,
        rssXml([
          ...BASE_RSS_ITEMS,
          { title: '트위드 자켓 구매 가이드', logNo: publishedLogNo, pubDate: publishedAt },
        ]),
      );
    };
  }

  const deps: RunnerDeps = {
    store,
    config,
    api,
    judge,
    clock,
    http,
    notify,
    runScript,
    sleep: async () => undefined,
    env: {
      repoRoot: root,
      outputDir: path.join(root, 'output'),
      dataDir: path.join(root, 'data'),
      blogId: 'hiteneken',
      template: 'coupang-buying-guide',
      codeVersion: 'test-sha',
      rssUrl: RSS_URL,
      imageDailyLimit: 0,
    },
    evidenceRoot,
  };

  return {
    store,
    clock,
    api,
    http,
    judge,
    runScript,
    notify,
    config,
    root,
    evidenceRoot,
    makeRunner: (overrides: Partial<RunnerDeps> = {}) => new RobotRunner({ ...deps, ...overrides }),
    daemonDeps: (): DaemonDeps => ({
      config,
      store,
      api,
      judge,
      http,
      notify,
      clock,
      env: deps.env,
      evidenceRoot,
      keepAwake: { start: () => undefined, stop: () => undefined, isRunning: () => false },
    }),
    createRun: (kind: RunKind, runOptions = {}) => {
      const slot = runOptions.slot ?? `manual-${kstCompact(clock.now())}`;
      const { row } = store.createRun({
        kind,
        slot,
        trigger: 'manual',
        mode: config.mode,
        step: 'PREFLIGHT',
        startedAt: clock.now(),
        codeVersion: 'test-sha',
      });
      if (runOptions.plan !== false && kind === 'publish') {
        store.insertPlan({
          id: `plan-${kstCompact(clock.now())}`,
          runId: row.id,
          keyword: runOptions.keyword ?? '트위드자켓',
          categoryId: '50000000',
          decision: { reason: '테스트 계획', productCriteria: ['기준1', '기준2', '기준3'] },
          publishSlot: slot,
          status: 'planned' as PlanStatus,
          createdAt: clock.now(),
        });
      }
      return row;
    },
  };
}

/**
 * 대기(wait)를 처리하며 실행을 끝까지 몬다.
 * - AWAIT_APPROVAL: 승인 명령을 넣는다(승인 sha는 실행의 현재 sha).
 * - 그 외: 가짜 시계를 1분 진행한다(RECONCILE 경계를 넘긴다).
 */
export async function driveToEnd(
  scenario: Scenario,
  runId: string,
  opts: { approve?: boolean; reason?: string; maxIterations?: number } = {},
): Promise<RunRow> {
  const runner = scenario.makeRunner();
  let run = scenario.store.getRun(runId);
  if (!run) throw new Error(`run not found: ${runId}`);

  for (let i = 0; i < (opts.maxIterations ?? 30); i += 1) {
    run = await runner.drive(run);
    if (run.status !== 'running' && run.status !== 'waiting') return run;
    if (run.step === 'AWAIT_APPROVAL') {
      if (opts.approve === false) {
        scenario.clock.advanceMs(121 * 60_000);
        continue;
      }
      scenario.store.enqueueCommand({
        type: 'approve',
        runId: run.id,
        payload: { previewSha256: run.preview_sha256 },
        source: 'cli',
      });
      continue;
    }
    scenario.clock.advanceMs(60_000);
  }
  throw new Error(`driveToEnd가 끝나지 않았습니다 (run ${runId}, step ${run.step})`);
}

export function stepNames(scenario: Scenario, runId: string): string[] {
  return scenario.store.listSteps(runId).map((step) => step.step);
}

export function evidenceFile(scenario: Scenario, runId: string, relative: string): string | null {
  const target = path.join(scenario.evidenceRoot, 'runs', runId, relative);
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : null;
}
