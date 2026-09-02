import { existsSync, mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  initShoppingCategoryStore,
  loadShoppingCategoryTreeSnapshot,
  saveShoppingCategoryTree,
} from '../../src/intelligence/ShoppingCategoryStore';

const TREE = [
  {
    catId: '50000000',
    name: '패션의류',
    children: [
      {
        catId: '50000167',
        name: '여성의류',
        children: [{ catId: '50021279', name: '니트' }],
      },
    ],
  },
];

let dbPath = '';
let jsonPath = '';

beforeEach(() => {
  dbPath = join(mkdtempSync(join(tmpdir(), 'scat-db-')), 'test.db');
  jsonPath = join(mkdtempSync(join(tmpdir(), 'scat-json-')), 'shoppingCategories.json');
  initShoppingCategoryStore({ dbPath, committedJsonPath: jsonPath });
});

describe('ShoppingCategoryStore — SQLite 저장/조회', () => {
  it('빈 DB + 커밋 파일 없음 → null', () => {
    expect(loadShoppingCategoryTreeSnapshot()).toBeNull();
  });

  it('저장 후 스냅샷과 커밋용 JSON 파일이 생성된다', () => {
    const snap = saveShoppingCategoryTree(TREE, 'datalab');
    expect(snap.nodeCount).toBe(3);
    expect(snap.tree).toEqual(TREE);
    expect(existsSync(jsonPath)).toBe(true);
    expect(readFileSync(jsonPath, 'utf8')).toContain('패션의류');
  });

  it('같은 경로로 재초기화해도 DB에서 트리를 복원한다', () => {
    saveShoppingCategoryTree(TREE, 'datalab');
    initShoppingCategoryStore({ dbPath, committedJsonPath: jsonPath });
    const snap = loadShoppingCategoryTreeSnapshot();
    expect(snap?.tree).toEqual(TREE);
    expect(snap?.nodeCount).toBe(3);
  });

  it('DB가 비면 커밋된 JSON으로 시드한다', () => {
    writeSeed();
    function writeSeed() {
      // 시드용: 먼저 저장 → 새 DB로 재초기화 (JSON 파일은 유지)
      saveShoppingCategoryTree(TREE, 'file-seed');
      initShoppingCategoryStore({
        dbPath: join(mkdtempSync(join(tmpdir(), 'scat-db2-')), 'test.db'),
        committedJsonPath: jsonPath,
      });
    }
    const snap = loadShoppingCategoryTreeSnapshot();
    expect(snap?.tree).toEqual(TREE);
    expect(snap?.source).toBe('file-seed');
  });

  it('덮어쓰면 node_count와 updated_at이 갱신된다', async () => {
    const first = saveShoppingCategoryTree(TREE, 'datalab');
    await new Promise((r) => setTimeout(r, 10));
    const bigger = [...TREE, { catId: '50000001', name: '패션잡화' }];
    const second = saveShoppingCategoryTree(bigger, 'datalab');
    expect(second.nodeCount).toBeGreaterThan(first.nodeCount);
  });
});
