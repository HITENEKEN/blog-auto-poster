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
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  fs.writeFileSync(
    path.join(dir, 'platform-content.json'),
    JSON.stringify(post.platformContent ?? {}, null, 2),
  );
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
      });
    } catch (error) {
      logger.warn({ dir: entry.name, error: String(error) }, 'Skipping unreadable post meta.json');
    }
  }
  return drafts;
}
