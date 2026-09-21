import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { getLogger } from '@core/logger';
import type { ConfigManager } from '@core/interfaces';
import { resolveRobotConfig } from '../../../robot/config';
import { RobotStore, type CommandType } from '../../../robot/RobotStore';
import { buildRobotStatus, emptyRobotStatus, type RobotStatus } from '../../../robot/status';

const logger = getLogger('robot-routes');

/**
 * `/api/robot/*` (설계 §4-1).
 *
 * web 서버는 `robot.sqlite`를 **읽기 전용**으로만 연다. 상태 변경은 명령 행 INSERT로만 한다
 * (`robot_commands` — 로봇이 적용 시점에 검증한다). 로봇이 한 번도 돌지 않아 파일이 없으면
 * `installed:false`를 돌려준다.
 */

export interface RobotRouteContext {
  configManager: ConfigManager;
  /** 열린 소재 요청 수(광고 저장소 조회) — 라우트가 주입한다. */
  countOpenAdRequests?: () => number | null;
}

const COMMAND_TYPES: CommandType[] = [
  'approve',
  'reject',
  'pause',
  'resume',
  'run-now',
  'cancel',
  'adopt',
];

export interface RobotRouteDeps {
  /** robot DB 경로 — 테스트가 임시 파일을 줄 수 있다. */
  dbPath?: string;
  now?: () => Date;
}

/**
 * 열린 소재 요청 수 — 광고 저장소가 쓰는 `data/blog-auto-poster.db`의 `ad_requests`를
 * 읽기 전용으로 센다(설계 §2-1 스키마). 테이블이 아직 없으면 null(광고 기능 미사용).
 */
export function createOpenAdRequestCounter(
  dbPath: string = path.resolve(process.cwd(), 'data', 'blog-auto-poster.db'),
): () => number | null {
  return () => {
    if (!fs.existsSync(dbPath)) return null;
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ad_requests'")
        .get() as { name: string } | undefined;
      if (!table) return null;
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM ad_requests WHERE status = 'open'")
        .get() as { n: number };
      return row?.n ?? 0;
    } catch (error) {
      logger.warn({ error: String(error) }, '소재 요청 수를 읽지 못했습니다');
      return null;
    } finally {
      db?.close();
    }
  };
}

/** `ads/placement.json` 증거(슬롯·상품·게이트 결과)를 읽는다 — 쓰지 않는다. */
export function readPlacementEvidence(
  evidenceDir: string,
): { ads: Array<{ id: string; productName?: string }>; slots: unknown[] } | null {
  const file = path.join(evidenceDir, 'ads', 'placement.json');
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      ads?: unknown[];
      slots?: unknown[];
    };
    const ads: Array<{ id: string; productName?: string }> = [];
    for (const ad of Array.isArray(parsed.ads) ? parsed.ads : []) {
      if (!ad || typeof ad !== 'object') continue;
      const record = ad as Record<string, unknown>;
      const id = String(record.id ?? '');
      if (!id) continue;
      ads.push({
        id,
        productName: record.productName ? String(record.productName) : undefined,
      });
    }
    return { ads, slots: Array.isArray(parsed.slots) ? parsed.slots : [] };
  } catch {
    return null;
  }
}

function resolveDbPath(configManager: ConfigManager, override?: string): string {
  if (override) return path.resolve(override);
  const config = resolveRobotConfig((key, def) => configManager.get(key, def));
  return path.resolve(config.dbPath);
}

export async function registerRobotRoutes(
  app: FastifyInstance,
  context: RobotRouteContext,
  deps: RobotRouteDeps = {},
): Promise<void> {
  const { configManager } = context;

  const readStatus = (): RobotStatus => {
    const config = resolveRobotConfig((key, def) => configManager.get(key, def));
    const dbPath = resolveDbPath(configManager, deps.dbPath);
    if (!fs.existsSync(dbPath)) return emptyRobotStatus(config);
    const store = new RobotStore(dbPath, { readonly: true });
    try {
      const status = buildRobotStatus(store, config, (deps.now ?? (() => new Date()))());
      status.openAdRequests = context.countOpenAdRequests?.() ?? null;
      return status;
    } finally {
      store.close();
    }
  };

  app.get('/api/robot/status', async () => readStatus());

  app.get('/api/robot/runs/:id', async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    const dbPath = resolveDbPath(configManager, deps.dbPath);
    if (!fs.existsSync(dbPath)) {
      return reply
        .code(404)
        .send({ error: 'NOT_INSTALLED', message: '로봇이 아직 실행되지 않았습니다' });
    }
    const store = new RobotStore(dbPath, { readonly: true });
    try {
      const run = store.getRun(runId);
      if (!run)
        return reply.code(404).send({ error: 'NOT_FOUND', message: `실행이 없습니다: ${runId}` });
      const plan = run.plan_id ? store.getPlan(run.plan_id) : null;
      const evidenceDir = path.resolve(process.cwd(), 'data', 'ops', 'runs', runId);
      return {
        run,
        steps: store.listSteps(runId),
        plan,
        evidenceDir,
        // 승인 카드가 보여줄 배치 광고(로봇이 남긴 증거 파일). 없으면 null.
        placement: readPlacementEvidence(evidenceDir),
      };
    } finally {
      store.close();
    }
  });

  app.post('/api/robot/commands', async (request, reply) => {
    const body = (request.body ?? {}) as {
      type?: string;
      runId?: string;
      payload?: Record<string, unknown>;
    };
    const type = String(body.type ?? '');
    if (!COMMAND_TYPES.includes(type as CommandType)) {
      return reply.code(400).send({
        error: 'INVALID_COMMAND',
        message: `type은 ${COMMAND_TYPES.join(' | ')} 중 하나여야 합니다`,
        field: 'type',
      });
    }
    const dbPath = resolveDbPath(configManager, deps.dbPath);
    if (!fs.existsSync(dbPath)) {
      return reply
        .code(409)
        .send({ error: 'NOT_INSTALLED', message: '로봇이 아직 실행되지 않았습니다' });
    }
    const store = new RobotStore(dbPath);
    try {
      const commandId = store.enqueueCommand({
        type: type as CommandType,
        runId: body.runId ?? null,
        payload: body.payload,
        source: 'dashboard',
        now: (deps.now ?? (() => new Date()))(),
      });
      logger.info({ commandId, type }, '로봇 명령 접수');
      return { commandId };
    } finally {
      store.close();
    }
  });
}
