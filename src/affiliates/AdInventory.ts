import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';
import { parseLinkInput } from '@content/linkInput';
import { normalizeKeyword } from '@content/AdMatcher';
import type { AdCheckResult, AdItem, AdSource, AdStatus } from '@content/AdTypes';

const logger = getLogger('ad-inventory');

/**
 * 광고 소재 인벤토리 저장소 (설계 §2-1). web 서버가 소유하고 로봇은 API로만 쓴다.
 *
 * `ad_inventory`(소재) / `ad_requests`(소재 요청) 두 테이블을 같은 DB
 * (`data/blog-auto-poster.db`)에 만든다 — `ShoppingCategoryStore`와 같은 설정
 * (WAL, busy_timeout=5000)을 쓴다. 기존 `data/link-presets.json`은 첫 기동에
 * 이 테이블로 흡수하고 파일 이름을 `.migrated`로 바꾼다.
 */

const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'blog-auto-poster.db');
const DEFAULT_PRESETS_PATH = path.resolve(process.cwd(), 'data', 'link-presets.json');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ad_inventory (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'product-link',
  product_name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  image_url TEXT,
  keywords TEXT NOT NULL,
  category_id TEXT,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_checked_at TEXT,
  last_check_result TEXT,
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ad_requests (
  id TEXT PRIMARY KEY,
  robot_run_id TEXT,
  keyword TEXT NOT NULL,
  category_id TEXT,
  needed INTEGER NOT NULL,
  criteria TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_inventory_category ON ad_inventory(category_id, status);
CREATE INDEX IF NOT EXISTS idx_ad_requests_status ON ad_requests(status, due_at);
`;

export type AdRequestStatus = 'open' | 'fulfilled' | 'expired' | 'cancelled';

export interface AdRequest {
  id: string;
  /** 로봇 기획 실행 id (사람이 직접 만든 요청이면 null) */
  robotRunId: string | null;
  keyword: string;
  categoryId: string | null;
  needed: number;
  /** 상품 고르는 기준 (글의 체크리스트 요약) */
  criteria: string[];
  /** 발행 예정 슬롯 ISO */
  dueAt: string;
  status: AdRequestStatus;
  createdAt: string;
  updatedAt: string;
}

/** 실패는 예외 대신 값으로 돌려준다 — 라우트가 400 응답 필드를 그대로 만들 수 있게. */
export type AdResult<T> = { ok: true; value: T } | { ok: false; error: string; field?: string };

export interface AdInventoryFilter {
  keyword?: string;
  categoryId?: string;
  status?: AdStatus;
}

interface InventoryRow {
  id: string;
  source: string;
  kind: string;
  product_name: string;
  url: string;
  image_url: string | null;
  keywords: string;
  category_id: string | null;
  request_id: string | null;
  status: string;
  last_checked_at: string | null;
  last_check_result: string | null;
  used_count: number;
  last_used_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RequestRow {
  id: string;
  robot_run_id: string | null;
  keyword: string;
  category_id: string | null;
  needed: number;
  criteria: string;
  due_at: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface AdInventoryStoreOptions {
  dbPath?: string;
  /** 기존 link-presets.json 경로 (마이그레이션 대상) */
  legacyPresetsPath?: string;
}

let options: AdInventoryStoreOptions = {};
let db: Database.Database | null = null;
let migrationChecked = false;
let migrationRunning = false;

/** 테스트/임베딩용 — DB 경로를 바꾸고 싱글턴 상태를 초기화한다. */
export function initAdInventoryStore(opts: AdInventoryStoreOptions = {}): void {
  options = { ...opts };
  db = null;
  migrationChecked = false;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

function parseCheckResult(raw: string | null): AdCheckResult | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as AdCheckResult;
  } catch {
    return undefined;
  }
}

function toAdItem(row: InventoryRow): AdItem {
  return {
    id: row.id,
    source: row.source as AdSource,
    kind: row.kind,
    productName: row.product_name,
    url: row.url,
    imageUrl: row.image_url ?? undefined,
    keywords: parseJsonArray(row.keywords),
    categoryId: row.category_id ?? undefined,
    requestId: row.request_id ?? undefined,
    status: row.status as AdStatus,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastCheckResult: parseCheckResult(row.last_check_result),
    usedCount: row.used_count,
    lastUsedAt: row.last_used_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAdRequest(row: RequestRow): AdRequest {
  return {
    id: row.id,
    robotRunId: row.robot_run_id,
    keyword: row.keyword,
    categoryId: row.category_id,
    needed: row.needed,
    criteria: parseJsonArray(row.criteria),
    dueAt: row.due_at,
    status: row.status as AdRequestStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 소재를 등록한다. 같은 URL이 이미 있으면 키워드만 병합한다(설계 §2-1 — url UNIQUE).
 * productName·imageUrl은 비어 있을 때만 채운다(사용자가 손댄 값을 덮지 않는다).
 */
export function createInventoryItem(input: {
  url: string;
  productName?: string;
  imageUrl?: string;
  keywords?: string[];
  categoryId?: string;
  requestId?: string;
  kind?: string;
  source?: AdSource;
}): AdResult<AdItem> {
  const url = (input.url ?? '').trim();
  if (!url) return { ok: false, error: '링크가 필요합니다', field: 'paste' };

  const now = new Date().toISOString();
  const keywords = (input.keywords ?? []).map((k) => k.trim()).filter((k) => k !== '');
  const existing = searchDb().prepare('SELECT * FROM ad_inventory WHERE url = ?').get(url) as
    InventoryRow | undefined;

  if (existing) {
    const merged = [...new Set([...parseJsonArray(existing.keywords), ...keywords])];
    searchDb()
      .prepare(
        `UPDATE ad_inventory SET keywords = ?, category_id = COALESCE(?, category_id),
           request_id = COALESCE(?, request_id), product_name = ?, image_url = COALESCE(?, image_url),
           status = CASE WHEN status = 'removed' THEN 'active' ELSE status END, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(merged),
        input.categoryId ?? null,
        input.requestId ?? null,
        input.productName?.trim() || existing.product_name,
        input.imageUrl?.trim() || null,
        now,
        existing.id,
      );
    return { ok: true, value: getInventoryItem(existing.id) as AdItem };
  }

  const id = newId('ad');
  searchDb()
    .prepare(
      `INSERT INTO ad_inventory (id, source, kind, product_name, url, image_url, keywords, category_id,
         request_id, status, used_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    )
    .run(
      id,
      input.source ?? 'manual',
      input.kind ?? 'product-link',
      input.productName?.trim() || url,
      url,
      input.imageUrl?.trim() || null,
      JSON.stringify(keywords),
      input.categoryId ?? null,
      input.requestId ?? null,
      now,
      now,
    );
  return { ok: true, value: getInventoryItem(id) as AdItem };
}

/**
 * 붙여넣기 등록 (설계 §3-1-1). 입력은 URL이거나 파트너스 배너 스니펫
 * (`<a href=…><img alt="상품명"></a>`)이다 — `parseLinkInput`이 링크·이미지·상품명을 뽑는다.
 * `productName`/`imageUrl`/`kind`는 폼에서 온 값으로, 파싱 결과보다 우선한다.
 */
export function addInventoryFromPaste(input: {
  paste: string;
  keywords?: string[];
  categoryId?: string;
  requestId?: string;
  productName?: string;
  imageUrl?: string;
  kind?: string;
}): AdResult<AdItem> {
  const parsed = parseLinkInput(input.paste ?? '');
  if (!parsed.url) return { ok: false, error: '링크를 찾지 못했습니다', field: 'paste' };
  if (!/^https?:\/\//i.test(parsed.url)) {
    return { ok: false, error: 'http(s) 링크가 아닙니다', field: 'paste' };
  }
  if (!isCoupangUrl(parsed.url)) {
    return {
      ok: false,
      error: '쿠팡 파트너스 링크(link.coupang.com) 또는 쿠팡 상품 링크가 아닙니다',
      field: 'paste',
    };
  }
  return createInventoryItem({
    url: parsed.url,
    productName: input.productName || parsed.altText,
    imageUrl: input.imageUrl || parsed.imageUrl,
    keywords: input.keywords,
    categoryId: input.categoryId,
    requestId: input.requestId,
    kind: input.kind,
  });
}

/** 쿠팡 도메인 링크인지 — 등록 단계에서 임의 링크를 막는다. */
export function isCoupangUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'coupang.com' || host.endsWith('.coupang.com');
  } catch {
    return false;
  }
}

export function getInventoryItem(id: string): AdItem | null {
  const row = searchDb().prepare('SELECT * FROM ad_inventory WHERE id = ?').get(id) as
    InventoryRow | undefined;
  return row ? toAdItem(row) : null;
}

/** 소재 목록 — status 기본은 active만이 아니라 전체(관리 화면이 전체를 본다). */
export function listInventory(filter: AdInventoryFilter = {}): AdItem[] {
  const rows = searchDb()
    .prepare(
      `SELECT * FROM ad_inventory
       WHERE (:status IS NULL OR status = :status) AND (:categoryId IS NULL OR category_id = :categoryId)
       ORDER BY created_at DESC`,
    )
    .all({
      status: filter.status ?? null,
      categoryId: filter.categoryId ?? null,
    }) as InventoryRow[];
  const items = rows.map(toAdItem);
  if (!filter.keyword) return items;
  const needle = normalizeKeyword(filter.keyword);
  if (!needle) return items;
  return items.filter((item) =>
    item.keywords.some((keyword) => {
      const normalized = normalizeKeyword(keyword);
      return normalized !== '' && (normalized.includes(needle) || needle.includes(normalized));
    }),
  );
}

export function updateInventory(
  id: string,
  patch: { keywords?: string[]; categoryId?: string | null; status?: AdStatus; markUsed?: boolean },
): AdItem | null {
  const current = getInventoryItem(id);
  if (!current) return null;
  const now = new Date().toISOString();
  searchDb()
    .prepare(
      `UPDATE ad_inventory SET keywords = ?, category_id = ?, status = ?,
         used_count = used_count + ?, last_used_at = ?, updated_at = ? WHERE id = ?`,
    )
    .run(
      JSON.stringify(patch.keywords ?? current.keywords),
      patch.categoryId === undefined ? (current.categoryId ?? null) : patch.categoryId,
      patch.status ?? current.status,
      patch.markUsed ? 1 : 0,
      patch.markUsed ? now : (current.lastUsedAt ?? null),
      now,
      id,
    );
  return getInventoryItem(id);
}

/** 소프트 삭제 — 발행된 글의 추적을 위해 행은 남긴다(설계 §4-1 DELETE). */
export function removeInventory(id: string): boolean {
  const info = searchDb()
    .prepare(
      `UPDATE ad_inventory SET status = 'removed', updated_at = ? WHERE id = ? AND status != 'removed'`,
    )
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** 링크 생존 확인 결과 저장 (설계 §3-7) — 실패면 dead로 내린다. */
export function recordInventoryCheck(id: string, result: AdCheckResult): AdItem | null {
  const current = getInventoryItem(id);
  if (!current) return null;
  const status: AdStatus = result.ok ? 'active' : 'dead';
  searchDb()
    .prepare(
      `UPDATE ad_inventory SET last_checked_at = ?, last_check_result = ?, status = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(result.checkedAt, JSON.stringify(result), status, result.checkedAt, id);
  return getInventoryItem(id);
}

export function listAdRequests(filter: { status?: AdRequestStatus } = {}): AdRequest[] {
  const rows = searchDb()
    .prepare(
      `SELECT * FROM ad_requests WHERE (:status IS NULL OR status = :status)
       ORDER BY due_at ASC, created_at ASC`,
    )
    .all({ status: filter.status ?? null }) as RequestRow[];
  return rows.map(toAdRequest);
}

/**
 * 소재 요청 생성/갱신 (설계 §3-1-1). 같은 키워드의 open 요청이 있으면 그 요청을
 * 갱신한다 — 로봇이 같은 주제로 여러 번 요청해도 카드가 쌓이지 않는다.
 */
export function upsertAdRequest(input: {
  keyword: string;
  categoryId?: string | null;
  needed: number;
  criteria?: string[];
  dueAt: string;
  robotRunId?: string | null;
}): AdResult<AdRequest> {
  const keyword = (input.keyword ?? '').trim();
  if (!keyword) return { ok: false, error: '키워드가 필요합니다', field: 'keyword' };
  if (!Number.isFinite(input.needed) || input.needed < 1) {
    return { ok: false, error: '필요 수량은 1 이상이어야 합니다', field: 'needed' };
  }
  if (!input.dueAt || Number.isNaN(Date.parse(input.dueAt))) {
    return { ok: false, error: '발행 예정 시각이 필요합니다', field: 'dueAt' };
  }

  const now = new Date().toISOString();
  const target = normalizeKeyword(keyword);
  const open = listAdRequests({ status: 'open' }).find(
    (request) => normalizeKeyword(request.keyword) === target,
  );
  if (open) {
    searchDb()
      .prepare(
        `UPDATE ad_requests SET category_id = ?, needed = ?, criteria = ?, due_at = ?,
           robot_run_id = COALESCE(?, robot_run_id), updated_at = ? WHERE id = ?`,
      )
      .run(
        input.categoryId ?? open.categoryId,
        input.needed,
        JSON.stringify(input.criteria ?? open.criteria),
        input.dueAt,
        input.robotRunId ?? null,
        now,
        open.id,
      );
    return { ok: true, value: toAdRequest(findRequestRow(open.id) as RequestRow) };
  }

  const id = newId('req');
  searchDb()
    .prepare(
      `INSERT INTO ad_requests (id, robot_run_id, keyword, category_id, needed, criteria, due_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(
      id,
      input.robotRunId ?? null,
      keyword,
      input.categoryId ?? null,
      input.needed,
      JSON.stringify(input.criteria ?? []),
      input.dueAt,
      now,
      now,
    );
  return { ok: true, value: toAdRequest(findRequestRow(id) as RequestRow) };
}

export function cancelAdRequest(id: string): boolean {
  const info = searchDb()
    .prepare(
      `UPDATE ad_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'open'`,
    )
    .run(new Date().toISOString(), id);
  return info.changes > 0;
}

/** 카테고리별 active 소재 수 — 대시보드의 "소재 부족" 판정에 쓴다. */
export function activeAdCountsByCategory(): Record<string, number> {
  const rows = searchDb()
    .prepare(
      `SELECT COALESCE(category_id, '') AS category, COUNT(*) AS count
       FROM ad_inventory WHERE status = 'active' GROUP BY COALESCE(category_id, '')`,
    )
    .all() as Array<{ category: string; count: number }>;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.category] = row.count;
  return counts;
}

function findRequestRow(id: string): RequestRow | undefined {
  return searchDb().prepare('SELECT * FROM ad_requests WHERE id = ?').get(id) as
    RequestRow | undefined;
}

interface LegacyPreset {
  id?: string;
  label?: string;
  kind?: string;
  props?: { url?: string; text?: string; imageUrl?: string; snippet?: string };
  createdAt?: string;
}

/**
 * `data/link-presets.json`을 인벤토리로 흡수하고 파일을 `.migrated`로 바꾼다(설계 §2-1).
 * 옮긴 소재 수를 돌려준다. 스니펫만 있는 프리셋(다이나믹/검색 위젯)은 링크가 없어
 * 옮기지 않는다 — 그 위젯 종류는 주제와 무관한 상품이 나와 폐기됐다(계획 §3-1).
 */
export function migrateLinkPresets(filePath: string = DEFAULT_PRESETS_PATH): number {
  // createInventoryItem → searchDb → 이 함수 경로로 되돌아오는 재진입을 막는다.
  if (migrationRunning) return 0;
  migrationRunning = true;
  try {
    return migrateLinkPresetsOnce(filePath);
  } finally {
    migrationRunning = false;
  }
}

function migrateLinkPresetsOnce(filePath: string): number {
  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 0;
  }

  let migrated = 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    const presets: LegacyPreset[] = Array.isArray(parsed) ? (parsed as LegacyPreset[]) : [];
    for (const preset of presets) {
      const parsedLink = parseLinkInput(preset?.props?.url ?? '');
      if (!parsedLink.url || !isCoupangUrl(parsedLink.url)) {
        logger.warn(
          { presetId: preset?.id, kind: preset?.kind },
          'link preset skipped during migration: no coupang link',
        );
        continue;
      }
      const result = createInventoryItem({
        url: parsedLink.url,
        productName: preset?.props?.text || parsedLink.altText || preset?.label || '',
        imageUrl: preset?.props?.imageUrl || parsedLink.imageUrl,
        keywords: preset?.label ? [preset.label] : [],
        kind: preset?.kind,
      });
      if (result.ok) migrated += 1;
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'link-presets.json migration failed');
    return 0;
  }

  try {
    fs.renameSync(filePath, `${filePath}.migrated`);
  } catch (error) {
    logger.warn({ error: String(error) }, 'link-presets.json rename failed');
  }
  logger.info({ migrated }, 'link-presets.json absorbed into ad_inventory');
  return migrated;
}

function getDb(): Database.Database {
  if (db) return db;
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(dbPath);
  db.exec(SCHEMA);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** DB 핸들 + 첫 사용 시 1회 레거시 프리셋 흡수. */
function searchDb(): Database.Database {
  const handle = getDb();
  if (!migrationChecked) {
    migrationChecked = true;
    try {
      migrateLinkPresets(options.legacyPresetsPath ?? DEFAULT_PRESETS_PATH);
    } catch (error) {
      logger.warn({ error: String(error) }, 'legacy link preset migration skipped');
    }
  }
  return handle;
}
