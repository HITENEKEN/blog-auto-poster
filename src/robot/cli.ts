import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Command } from 'commander';
import { getConfigManager } from '@core/config';
import { createContentGeneratorFromConfig } from '@content/ContentGenerator';
import { applyCommandResult, decideCommand } from './commands';
import { resolveRobotConfig, type RobotConfig } from './config';
import { acquireLease, readActiveLease } from './lease';
import { buildProductionDeps, createRunner, SYSTEM_CLOCK } from './index';
import { kstIso } from './kst';
import { computeSlots } from './RobotScheduler';
import { RobotStore, type CommandType } from './RobotStore';
import { buildRobotStatus, emptyRobotStatus, type RobotStatus } from './status';
import { SESSION_MIN_DAYS } from './policies';

/**
 * `npm run robot -- <cmd>` (설계 §7-3).
 *
 * 데몬이 떠 있으면 **명령 행만** 넣는다(로봇이 적용 시점에 검증한다). 데몬이 없을 때는
 * `once`가 리스를 잡고 그 프로세스에서 1회 실행하고, pause/resume/cancel/adopt는 즉시 적용한다.
 * 상태 변경은 전부 이 CLI → robot.sqlite(commands/state) 경로로만 한다.
 */

/** 로봇 DB 경로 — 설정의 `robot.dbPath`. 파일이 없으면 installed:false. */
export async function resolveDbPath(): Promise<{ dbPath: string; config: RobotConfig }> {
  const manager = getConfigManager();
  await manager.load();
  const config = resolveRobotConfig((key, def) => manager.get(key, def));
  return { dbPath: path.resolve(config.dbPath), config };
}

async function openStore(): Promise<{ store: RobotStore; config: RobotConfig; dbPath: string }> {
  const { dbPath, config } = await resolveDbPath();
  return { store: new RobotStore(dbPath), config, dbPath };
}

function daemonRunning(store: RobotStore): boolean {
  const lease = readActiveLease(store, new Date());
  return !!lease && lease.pid !== process.pid;
}

/** 데몬이 없으면 즉시 적용한다(설계 §5-7 CLI 규칙). */
function enqueue(
  store: RobotStore,
  input: {
    type: CommandType;
    runId?: string | null;
    payload?: Record<string, unknown>;
  },
): { id: number; applied: boolean; result: string } {
  const id = store.enqueueCommand({
    type: input.type,
    runId: input.runId,
    payload: input.payload,
    source: 'cli',
  });
  const command = store.getCommand(id);
  if (!command) throw new Error('명령을 저장하지 못했습니다');
  if (daemonRunning(store)) {
    return {
      id,
      applied: false,
      result: '데몬이 실행 중 — 대기열에 넣었습니다(로봇이 적용 시점에 검증)',
    };
  }
  const decision = decideCommand(command, store, SYSTEM_CLOCK);
  applyCommandResult(store, command, decision, SYSTEM_CLOCK);
  return { id, applied: decision.applied, result: decision.reason };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** `status` — 서버 없이 robot.sqlite만 읽는다. 파일이 없으면 installed:false. */
export async function statusCommand(): Promise<RobotStatus> {
  const { dbPath, config } = await resolveDbPath();
  if (!fs.existsSync(dbPath)) return emptyRobotStatus(config);
  const store = new RobotStore(dbPath, { readonly: true });
  try {
    return buildRobotStatus(store, config, new Date());
  } finally {
    store.close();
  }
}

export interface OnceOptions {
  kind: 'plan' | 'publish';
  until?: string;
  evidenceRoot?: string;
}

/** `once` — 데몬이 없으면 리스를 잡고 1회 실행한다. */
export async function onceCommand(options: OnceOptions): Promise<Record<string, unknown>> {
  const deps = await buildProductionDeps(options.evidenceRoot);
  try {
    if (daemonRunning(deps.store)) {
      // 데몬이 있으면 실행 생성은 데몬 틱이 한다(로봇이 리스를 쥐고 있으므로 여기서 만들면 중복).
      const queued = enqueue(deps.store, {
        type: 'run-now',
        payload: { kind: options.kind, until: options.until },
      });
      return { mode: 'queued', commandId: queued.id, note: queued.result };
    }

    if (!acquireLease(deps.store, SYSTEM_CLOCK)) {
      return { mode: 'refused', error: 'already running' };
    }
    const slot = `manual-${kstIso(new Date())}`;
    const { row } = deps.store.createRun({
      kind: options.kind,
      slot,
      trigger: 'manual',
      mode: deps.config.mode,
      step: 'PREFLIGHT',
      startedAt: new Date(),
      codeVersion: deps.env.codeVersion,
    });
    if (options.until === 'GATE') deps.store.setState(`until:${row.id}`, 'GATE');

    const runner = createRunner(deps);
    const result = await runner.drive(row);
    return {
      mode: 'inline',
      runId: result.id,
      status: result.status,
      step: result.step,
      outcome: result.outcome,
    };
  } finally {
    if (!daemonRunning(deps.store)) deps.store.clearLease();
    deps.store.close();
  }
}

/** doctor가 쓰는 최소 명령 실행기. */
function run(
  command: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { promise, resolve } = Promise.withResolvers<{
    code: number;
    stdout: string;
    stderr: string;
  }>();
  execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
    const code = error ? ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
    resolve({
      code: typeof code === 'number' ? code : 1,
      stdout: String(stdout),
      stderr: String(stderr),
    });
  });
  return promise;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 5_000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = { raw: text };
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `doctor` — 설계 §7-1의 점검 항목 전부. 모든 항목이 OK여야 다음 단계로 간다.
 * `--llm`이면 LLM JSON 응답을 1회 확인한다(호출 1회 소모).
 */
export async function doctorCommand(options: { llm?: boolean } = {}): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const manager = getConfigManager();
  await manager.load();
  const config = resolveRobotConfig((key, def) => manager.get(key, def));
  const apiBase = config.apiBase;

  // 1) web 서버 + 3) 네이버 세션 (같은 /health 응답을 쓴다)
  let healthOk = false;
  let sessionOk = false;
  try {
    const health = await fetchJson(`${apiBase}/health`);
    const services = (health.body.services ?? {}) as Record<string, unknown>;
    const platforms = (services.platforms ?? {}) as Record<string, boolean>;
    healthOk =
      health.status === 200 && platforms.naver === true && services.scheduler === 'stopped';
    checks.push({
      name: 'web 서버',
      ok: healthOk,
      detail: `GET /health → ${health.status}, naver=${platforms.naver}, scheduler=${String(services.scheduler)}`,
    });
    const session = (services.naverSession ?? {}) as { daysLeft?: number | null };
    sessionOk = typeof session.daysLeft === 'number' && session.daysLeft >= SESSION_MIN_DAYS;
    checks.push({
      name: '네이버 세션',
      ok: sessionOk,
      detail: `daysLeft=${String(session.daysLeft ?? 'unknown')} (≥ ${SESSION_MIN_DAYS} 필요)`,
    });
  } catch (error) {
    checks.push({ name: 'web 서버', ok: false, detail: `${apiBase} 연결 실패: ${String(error)}` });
    checks.push({ name: '네이버 세션', ok: false, detail: '서버 미기동으로 확인 불가' });
  }

  // 2) 대시보드 보안
  const username = process.env.BLOG_POSTER_WEB_ADMIN_USERNAME || 'admin';
  const password = process.env.BLOG_POSTER_WEB_ADMIN_PASSWORD || 'changeme';
  const jwtSecret = String(manager.get('web.jwtSecret', '') || '');
  const host = String(manager.get('web.host', ''));
  const defaultCreds = username === 'admin' && password === 'changeme';
  const secretOk = !!jwtSecret && jwtSecret !== 'change-me-in-production';
  let loginOk = false;
  try {
    const login = await fetchJson(`${apiBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    loginOk = login.status === 200 && typeof login.body.token === 'string';
  } catch {
    loginOk = false;
  }
  checks.push({
    name: '대시보드 보안',
    ok: loginOk && !defaultCreds && secretOk,
    detail: `로그인=${loginOk ? 'OK' : 'FAIL'}, 기본 계정=${defaultCreds ? '사용 중(FAIL)' : '교체됨'}, jwtSecret=${
      secretOk ? '설정됨' : '미설정(FAIL)'
    }, host=${host || '(미설정)'}${host === '0.0.0.0' ? ' ⚠ 127.0.0.1 권장' : ''}`,
  });

  // 4) LLM
  const llmKey = String(manager.get('llm.apiKey', '') || '');
  let llmOk = !!llmKey;
  let llmDetail = llmKey ? '설정 존재' : 'llm.apiKey 없음';
  if (options.llm && llmKey) {
    try {
      const generator = createContentGeneratorFromConfig();
      const verdict = await generator.completeJson(
        'JSON만 출력하세요.',
        '{"ok":true} 형태로 응답하세요.',
      );
      llmOk = !!verdict && typeof verdict === 'object';
      llmDetail = `JSON 응답 확인: ${JSON.stringify(verdict).slice(0, 80)}`;
    } catch (error) {
      llmOk = false;
      llmDetail = `JSON 응답 실패: ${String(error)}`;
    }
  }
  checks.push({ name: 'LLM', ok: llmOk, detail: llmDetail });

  // 5) 광고 소재 — 카테고리마다 active 소재 ≥ minAds
  if (!config.categories.length) {
    checks.push({
      name: '광고 소재',
      ok: !config.enabled,
      detail: config.enabled
        ? 'robot.categories가 비어 있습니다(enabled=true면 FAIL)'
        : '카테고리 미설정 — 로봇 비활성 상태',
    });
  } else if (!loginOk) {
    checks.push({ name: '광고 소재', ok: false, detail: '로그인 실패로 확인 불가' });
  } else {
    const failures: string[] = [];
    try {
      const login = await fetchJson(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const token = String(login.body.token ?? '');
      for (const category of config.categories) {
        const res = await fetchJson(
          `${apiBase}/api/ads/inventory?categoryId=${encodeURIComponent(category)}&status=active`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        const items = Array.isArray(res.body.items) ? (res.body.items as unknown[]) : [];
        if (items.length < config.ads.minAds) {
          failures.push(`${category}: ${items.length}/${config.ads.minAds}`);
        }
      }
    } catch (error) {
      failures.push(`조회 실패: ${String(error)}`);
    }
    checks.push({
      name: '광고 소재',
      ok: failures.length === 0,
      detail: failures.length
        ? failures.join(', ')
        : `카테고리 ${config.categories.length}개 모두 충분`,
    });
  }

  // 6) 로봇 DB·리스
  const dbPath = path.resolve(config.dbPath);
  let dbOk = false;
  let leaseDetail = '다른 인스턴스 없음';
  try {
    const store = new RobotStore(dbPath);
    store.setState('doctor:probe', kstIso(new Date()));
    const existing = readActiveLease(store, new Date());
    if (existing && existing.pid !== process.pid) {
      leaseDetail = `다른 인스턴스가 실행 중 (pid ${existing.pid})`;
    }
    dbOk = !(existing && existing.pid !== process.pid);
    store.close();
  } catch (error) {
    leaseDetail = `DB 접근 실패: ${String(error)}`;
  }
  checks.push({ name: '로봇 DB·리스', ok: dbOk, detail: `${dbPath} / ${leaseDetail}` });

  // 7) 부팅 자동 기동 (pm2 startup + 저장된 덤프에 두 앱 포함)
  const launchAgents = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const pm2Plists = fs.existsSync(launchAgents)
    ? fs.readdirSync(launchAgents).filter((f) => /^pm2.*\.plist$/.test(f))
    : [];
  const dumpPath = path.join(os.homedir(), '.pm2', 'dump.pm2');
  let dumpOk = false;
  if (fs.existsSync(dumpPath)) {
    try {
      const dump = fs.readFileSync(dumpPath, 'utf-8');
      dumpOk = dump.includes('blog-auto-poster-web') && dump.includes('blog-auto-poster-robot');
    } catch {
      dumpOk = false;
    }
  }
  checks.push({
    name: '부팅 자동 기동',
    ok: pm2Plists.length > 0 && dumpOk,
    detail: `LaunchAgents ${pm2Plists.join(',') || '없음'} / pm2 save 덤프 ${dumpOk ? '두 앱 포함' : 'web·robot 미포함'}`,
  });

  // 8) 깨우기 예약
  const pmset = await run('pmset', ['-g', 'sched']);
  const wakeOk = /wakeorpoweron/.test(pmset.stdout);
  checks.push({
    name: '깨우기 예약',
    ok: wakeOk,
    detail: wakeOk
      ? 'wakeorpoweron 예약 있음'
      : 'wakeorpoweron 예약 없음 — sudo pmset repeat wakeorpoweron MTRS 20:55:00',
  });

  // 9) 이중 트리거 없음 — 런북 §3의 launchd 에이전트가 로드돼 있으면 FAIL
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
  const trigger = await run('launchctl', ['print', `gui/${uid}/com.prily.blog-auto-poster-cycle`]);
  const triggerLoaded = trigger.code === 0;
  checks.push({
    name: '이중 트리거 없음',
    ok: !triggerLoaded,
    detail: triggerLoaded
      ? 'com.prily.blog-auto-poster-cycle이 로드돼 있습니다(런북 §3) — 로봇과 이중 실행 위험'
      : '런북 launchd 에이전트 미로드(정상)',
  });

  return checks;
}

async function main(): Promise<void> {
  const program = new Command();
  program.name('robot').description('네이버 블로그 자동 포스터 로봇 CLI');

  program
    .command('status')
    .description('상태 보기(서버 불필요)')
    .action(async () => {
      printJson(await statusCommand());
    });

  program
    .command('once')
    .description('기획/발행 1회 실행')
    .requiredOption('--kind <kind>', 'plan | publish')
    .option('--until <step>', 'GATE까지만(드라이런)')
    .action(async (options: { kind: string; until?: string }) => {
      if (options.kind !== 'plan' && options.kind !== 'publish') {
        throw new Error('--kind는 plan 또는 publish');
      }
      printJson(await onceCommand({ kind: options.kind, until: options.until }));
    });

  program
    .command('approve')
    .argument('<runId>')
    .option('--sha <sha>', '승인할 미리보기 sha256')
    .action(async (runId: string, options: { sha?: string }) => {
      const { store } = await openStore();
      try {
        printJson(
          enqueue(store, {
            type: 'approve',
            runId,
            payload: { previewSha256: options.sha ?? null },
          }),
        );
      } finally {
        store.close();
      }
    });

  program
    .command('reject')
    .argument('<runId>')
    .option('--reason <reason>', '거절 사유', '사람이 거절')
    .action(async (runId: string, options: { reason?: string }) => {
      const { store } = await openStore();
      try {
        printJson(enqueue(store, { type: 'reject', runId, payload: { reason: options.reason } }));
      } finally {
        store.close();
      }
    });

  for (const type of ['pause', 'resume'] as const) {
    program
      .command(type)
      .description(type === 'pause' ? '일시정지' : '재개')
      .action(async () => {
        const { store } = await openStore();
        try {
          printJson(enqueue(store, { type }));
        } finally {
          store.close();
        }
      });
  }

  program
    .command('cancel')
    .argument('<runId>')
    .action(async (runId: string) => {
      const { store } = await openStore();
      try {
        printJson(enqueue(store, { type: 'cancel', runId }));
      } finally {
        store.close();
      }
    });

  program
    .command('adopt')
    .argument('<runId>')
    .argument('<logNo>')
    .action(async (runId: string, logNo: string) => {
      const { store, config } = await openStore();
      void config;
      try {
        const blogId = String(getConfigManager().get('platforms.naver.blogId', '') || '');
        printJson(enqueue(store, { type: 'adopt', runId, payload: { logNo, blogId } }));
      } finally {
        store.close();
      }
    });

  program
    .command('doctor')
    .description('사전 점검(설계 §7-1)')
    .option('--llm', 'LLM JSON 응답 1회 확인')
    .action(async (options: { llm?: boolean }) => {
      const checks = await doctorCommand({ llm: options.llm });
      for (const check of checks) {
        process.stdout.write(`${check.ok ? 'OK  ' : 'FAIL'} ${check.name}: ${check.detail}\n`);
      }
      const failed = checks.filter((c) => !c.ok);
      if (failed.length) {
        process.stdout.write(`\n${failed.length}개 항목 실패\n`);
        process.exitCode = 1;
      } else {
        process.stdout.write('\n전 항목 OK\n');
      }
    });

  program.command('next-slots').action(async () => {
    const { config } = await resolveDbPath();
    printJson(
      computeSlots(new Date(), config.slots, config.jitterMinutes, [0, 1, 2, 3])
        .filter((slot) => slot.dueMs >= Date.now())
        .slice(0, 6)
        .map((slot) => ({ kind: slot.kind, at: slot.slot })),
    );
  });

  await program.parseAsync(process.argv);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  });
}
