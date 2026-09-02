import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';

const logger = getLogger('shopping-category-store');

/** 쇼핑 카테고리 트리 노드 — 1~4분류 재귀 트리(Shared ShoppingCategoryNode와 동일 셰이프). */
export interface ShoppingCategoryTreeNode {
  catId: string;
  name: string;
  children?: ShoppingCategoryTreeNode[];
}

export interface ShoppingCategorySnapshot {
  tree: ShoppingCategoryTreeNode[];
  updatedAt: string;
  nodeCount: number;
  source: string;
}

/** 커밋 대상 코드표 파일 — 갱신 시 함께 재생성되어 git에 커밋된다. */
const DEFAULT_COMMITTED_JSON = path.resolve(
  process.cwd(),
  'src',
  'web',
  'shared',
  'shoppingCategories.json',
);
const DEFAULT_DB_PATH = path.resolve(process.cwd(), 'data', 'blog-auto-poster.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shopping_categories (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tree_json TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'datalab',
  updated_at TEXT NOT NULL
);
`;

interface StoreOptions {
  dbPath?: string;
  committedJsonPath?: string;
}

let options: StoreOptions = {};
let db: Database.Database | null = null;
let memory: ShoppingCategorySnapshot | null = null;

/** 테스트/임베딩용 — DB/파일 경로를 바꾸고 싱글턴 상태를 초기화한다. */
export function initShoppingCategoryStore(opts: StoreOptions = {}): void {
  options = { ...opts };
  db = null;
  memory = null;
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

function countNodes(nodes: ShoppingCategoryTreeNode[]): number {
  return nodes.reduce((sum, n) => sum + 1 + (n.children ? countNodes(n.children) : 0), 0);
}

/**
 * 저장된 카테고리 트리를 조회한다. 우선순위: 메모리 → SQLite → 커밋된 JSON 파일
 * (파일에서 로드하면 DB를 시드한다). 어디에도 없으면 null.
 */
export function loadShoppingCategoryTreeSnapshot(): ShoppingCategorySnapshot | null {
  if (memory) return memory;
  try {
    const row = getDb()
      .prepare(
        'SELECT tree_json, node_count, source, updated_at FROM shopping_categories WHERE id = 1',
      )
      .get() as
      { tree_json: string; node_count: number; source: string; updated_at: string } | undefined;
    if (row) {
      memory = {
        tree: JSON.parse(row.tree_json),
        updatedAt: row.updated_at,
        nodeCount: row.node_count,
        source: row.source,
      };
      return memory;
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to read shopping_categories from DB');
  }
  // DB가 비어 있으면 커밋된 JSON 파일로 시드한다.
  try {
    if (fs.existsSync(options.committedJsonPath ?? DEFAULT_COMMITTED_JSON)) {
      const tree = JSON.parse(
        fs.readFileSync(options.committedJsonPath ?? DEFAULT_COMMITTED_JSON, 'utf8'),
      );
      logger.info('Seeded shopping category tree from committed JSON');
      return saveShoppingCategoryTree(tree, 'file-seed');
    }
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to seed shopping_categories from JSON');
  }
  return null;
}

/**
 * 트리를 SQLite에 저장하고, 커밋용 JSON 파일을 재생성하며, 메모리 스냅샷을 갱신한다.
 */
export function saveShoppingCategoryTree(
  tree: ShoppingCategoryTreeNode[],
  source = 'datalab',
): ShoppingCategorySnapshot {
  const nodeCount = countNodes(tree);
  const updatedAt = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO shopping_categories (id, tree_json, node_count, source, updated_at)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tree_json = excluded.tree_json,
       node_count = excluded.node_count,
       source = excluded.source,
       updated_at = excluded.updated_at`,
  ).run(JSON.stringify(tree), nodeCount, source, updatedAt);

  // 커밋용 JSON 파일 재생성 (git 커밋 대상)
  try {
    const jsonPath = options.committedJsonPath ?? DEFAULT_COMMITTED_JSON;
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(jsonPath, JSON.stringify(tree, null, 2) + '\n');
  } catch (error) {
    logger.warn({ error: String(error) }, 'Failed to write committed shoppingCategories.json');
  }

  memory = { tree, updatedAt, nodeCount, source };
  logger.info({ nodeCount, updatedAt, source }, 'Shopping category tree saved');
  return memory;
}

/** 현재 메모리/DB 스냅샷 (없으면 null). 갱신 상태와 무관하게 즉시 반환된다. */
export function getShoppingCategorySnapshot(): ShoppingCategorySnapshot | null {
  return memory ?? loadShoppingCategoryTreeSnapshot();
}
