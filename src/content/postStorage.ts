import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';
import { PostContent } from '@core/interfaces';

const logger = getLogger('post-storage');

/** 기본 포스트 저장 루트 (routes의 ./output/posts와 동일) */
export const POSTS_OUTPUT_DIR = './output/posts';

/**
 * meta.json 스키마. 기존 POST /api/posts가 post.meta만 저장하던 것과 달리
 * publish 라우트가 읽는 title/platformContent/tags/categories/affiliateUrl/
 * productId를 평탄화해 저장한다.
 */
export interface PostFileMeta {
  id: string;
  title: string;
  template: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  categories: string[];
  meta: Record<string, unknown>;
  platformContent: Record<string, unknown>;
  affiliateUrl: string;
  productId: string;
  /** 발행 대상 이미지 로컬 경로 (#7 — 네이버 등 브라우저 발행 시 에디터에 업로드) */
  images?: string[];
  /** 백그라운드 키워드 드래프트 생성 상태 (POST /api/posts/generate-from-keyword 비동기 계약) */
  generationStatus?: 'generating' | 'done' | 'failed';
  /** generationStatus가 'failed'일 때의 원인 메시지 */
  generationError?: string;
}

export interface PostFiles {
  meta: PostFileMeta;
  content: string;
}

export interface DraftSummary {
  id: string;
  title: string;
  status: string;
  template: string;
  createdAt: string;
  generationStatus?: PostFileMeta['generationStatus'];
  generationError?: string;
}

/** PostContent를 ./output/posts/<id>/{post.html, meta.json, platform-content.json}로 저장 */
export function savePostFiles(post: PostContent, outputDir: string = POSTS_OUTPUT_DIR): void {
  const dir = path.join(outputDir, post.id);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'post.html'), post.content);

  const meta: PostFileMeta = {
    id: post.id,
    title: post.title,
    template: post.template,
    status: post.status,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    tags: post.tags,
    categories: post.categories,
    meta: (post.meta ?? {}) as Record<string, unknown>,
    platformContent: (post.platformContent ?? {}) as Record<string, unknown>,
    affiliateUrl: post.affiliateUrl,
    productId: post.productId,
    // #7: 생성 시 수집한 이미지 로컬 경로를 발행 라우트가 사용할 수 있게 보존
    ...(post.images && post.images.length > 0 ? { images: post.images } : {}),
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(dir, 'platform-content.json'),
    JSON.stringify(post.platformContent ?? {}, null, 2),
  );
}

/**
 * 발행 대상 이미지 로컬 경로를 수집한다(#7).
 *
 * 우선순위:
 *  1. meta.json의 `images` (문자열 경로 또는 {localPath} 객체 배열)
 *  2. post.html의 `<img src="...">` (상대경로 — 기존 저장 포스트 폴백)
 *
 * http(s)/data: URL은 제외하고, cwd 기준 절대경로로 치환한 뒤
 * 실제로 존재하는 로컬 파일만 중복 없이 반환한다. 순서는 유지(첫 항목 = 대표 이미지).
 */
export function resolvePostImagePaths(metaImages: unknown, html: string): string[] {
  const collected: string[] = [];

  if (Array.isArray(metaImages)) {
    for (const entry of metaImages) {
      if (typeof entry === 'string' && entry.trim()) {
        collected.push(entry.trim());
      } else if (
        entry &&
        typeof entry === 'object' &&
        typeof (entry as { localPath?: unknown }).localPath === 'string' &&
        (entry as { localPath: string }).localPath.trim()
      ) {
        collected.push((entry as { localPath: string }).localPath.trim());
      }
    }
  }

  if (collected.length === 0 && html) {
    const imgTagPattern = /<img[^>]+src=["']([^"']+)["']/gi;
    for (const match of html.matchAll(imgTagPattern)) {
      const src = match[1];
      // 외부 URL/임베디드 데이터는 브라우저 업로드 대상이 아니다
      if (/^(?:https?:)?\/\//i.test(src) || /^data:/i.test(src)) continue;
      collected.push(src);
    }
  }

  const seen = new Set<string>();
  const existing: string[] = [];
  for (const candidate of collected) {
    const abs = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) existing.push(abs);
    } catch {
      // 접근 불가 파일은 건너뛴다
    }
  }
  return existing;
}

/** ./output/posts/<id>/{meta.json, post.html} 로드. 없으면 null */
export function readPostFiles(id: string, outputDir: string = POSTS_OUTPUT_DIR): PostFiles | null {
  const metaPath = path.join(outputDir, id, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  const htmlPath = path.join(outputDir, id, 'post.html');
  const content = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf-8') : '';

  return { meta: JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PostFileMeta, content };
}

/** ./output/posts/&lt;id&gt;/meta.json을 스캔해 DRAFT 포스트 목록 반환 */
export function listDrafts(outputDir: string = POSTS_OUTPUT_DIR): DraftSummary[] {
  if (!fs.existsSync(outputDir)) return [];

  const drafts: DraftSummary[] = [];
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(outputDir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<PostFileMeta>;
      if (meta.status !== 'DRAFT') continue;
      drafts.push({
        id: meta.id || entry.name,
        title: meta.title || '',
        status: meta.status,
        template: meta.template || '',
        createdAt: meta.createdAt || '',
        generationStatus: meta.generationStatus,
        generationError: meta.generationError,
      });
    } catch (error) {
      logger.warn({ dir: entry.name, error: String(error) }, 'Skipping unreadable post meta.json');
    }
  }
  return drafts;
}

/**
 * ./output/posts/<id>/meta.json을 읽어 patch를 병합해 저장한다.
 * undefined 값은 키 자체를 제거한다(JSON.stringify가 날리지 않도록 명시적 정리).
 * id가 안전하지 않거나 대상이 없으면 null을 반환한다.
 */
export function updatePostMeta(
  id: string,
  patch: Partial<
    Pick<PostFileMeta, 'generationStatus' | 'generationError' | 'status' | 'title' | 'updatedAt'>
  >,
  outputDir: string = POSTS_OUTPUT_DIR,
): PostFileMeta | null {
  // 경로 탈출 방지 — 알파벳/숫자 시작의 단일 세그먼트만 허용('.', '..', 슬래시 포함 거부)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return null;
  const metaPath = path.join(outputDir, id, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as PostFileMeta;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete (meta as unknown as Record<string, unknown>)[key];
    } else {
      (meta as unknown as Record<string, unknown>)[key] = value;
    }
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
}

/**
 * 드래프트 디렉터리(./output/posts/<id>)를 재귀 삭제한다.
 * 게시 여부 판정은 호출부(routes)가 하고, 여기서는 경로 탈출만 방지한다.
 * id가 안전하지 않거나 대상이 없으면 false를 반환한다.
 */
export function deleteDraftFiles(id: string, outputDir: string = POSTS_OUTPUT_DIR): boolean {
  // 경로 탈출 방지 — updatePostMeta와 동일한 단일 세그먼트 검증
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) return false;
  const dir = path.join(outputDir, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 서버 재시작으로 백그라운드 생성이 끊긴 'generating' 드래프트를 'failed'로
 * 스윕한다. 기동 시(registerRoutes) 1회 호출 — 이 시점엔 진행 중인 in-process
 * 생성 작업이 없으므로 남아 있는 'generating'은 전부 고아다.
 * 스윕한 드래프트 수를 반환한다.
 */
export function failStaleGeneratingDrafts(outputDir: string = POSTS_OUTPUT_DIR): number {
  if (!fs.existsSync(outputDir)) return 0;

  let swept = 0;
  for (const entry of fs.readdirSync(outputDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(outputDir, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Partial<PostFileMeta>;
      if (meta.generationStatus !== 'generating') continue;
      updatePostMeta(
        entry.name,
        {
          generationStatus: 'failed',
          generationError: '서버 재시작으로 중단됨',
        },
        outputDir,
      );
      swept++;
    } catch (error) {
      logger.warn({ dir: entry.name, error: String(error) }, 'Skipping unreadable post meta.json');
    }
  }
  return swept;
}
