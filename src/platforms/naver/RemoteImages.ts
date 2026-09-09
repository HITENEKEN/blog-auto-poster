import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { getLogger } from '@core/logger';

const logger = getLogger('naver-remote-images');

/**
 * 본문의 외부 이미지를 네이버 호스팅으로 옮기기 위한 준비(2026-09-08).
 *
 * 문제: 쿠팡 상품 카드/배너는 `img1a.coupangcdn.com`, `img4a.coupangcdn.com` 같은
 * 쿠팡 CDN을 **그대로 핫링크**해 발행됐다. 네이버는 그 이미지를 자기 서버로
 * 복사하지 않고 링크만 유지하는데, 이미지 요청이 실패하면 자리에
 * **"존재하지 않는 이미지입니다."** 를 대신 넣는다.
 *
 * 실측(2026-09-08): 발행물 `224405221163`에서 `*.coupangcdn.com` 요청만 막자
 * 그 문구가 정확히 4회(배너 1 + 카드 3) 나타났다. 경로가
 * `/image/affiliate/…`, `/widget/…` 이라 흔한 광고 차단 규칙에 그대로 걸리고,
 * 사내망·DNS 필터에서도 같은 일이 벌어진다. 즉 **읽는 사람 상당수에게 상품
 * 이미지가 통째로 깨진다** — 제휴 수익이 걸린 자리에서 가장 나쁜 실패다.
 *
 * 해결: 발행 전에 외부 이미지를 내려받아 로컬 파일로 만들고, 이미 검증된
 * 업로드 경로(`uploadNaverImages`)에 함께 태워 `blogfiles.pstatic.net` URL로
 * 치환한다. 그러면 본문 이미지는 전부 네이버 호스팅이 되어 외부 차단의
 * 영향을 받지 않는다.
 *
 * 파싱/치환은 순수 함수(유닛 테스트 대상), 네트워크는 주입 가능한 fetcher 한 곳에만.
 */

/** 이미 네이버가 호스팅하는 이미지 — 손댈 필요가 없다. */
const NAVER_IMAGE_HOST_RE = /(?:^|\.)pstatic\.net/i;

/** 네이버 에디터가 받아 주는 확장자. 그 외는 업로드가 거부되므로 시도하지 않는다. */
const UPLOADABLE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp']);

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
};

/** 한 번의 발행에서 내려받을 외부 이미지 수 상한(업로드마다 수 초가 든다). */
export const MAX_REMOTE_IMAGES = 8;

export type ImageFetcher = (
  url: string,
) => Promise<{ status: number; contentType: string; data: Buffer }>;

export const defaultImageFetcher: ImageFetcher = async (url) => {
  const res = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 15_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  return {
    status: res.status,
    contentType: String(res.headers?.['content-type'] ?? ''),
    data: Buffer.from(res.data),
  };
};

/**
 * 본문에서 **네이버가 호스팅하지 않는** http(s) 이미지 주소를 문서 순서로 모은다.
 * 중복은 제거한다. 순수 함수 — 유닛 테스트 대상.
 */
export function collectRemoteImageUrls(html: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const raw = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const src = decodeSrc(raw);
    if (!src) continue;
    const absolute = src.startsWith('//') ? `https:${src}` : src;
    if (!/^https?:\/\//i.test(absolute)) continue;
    let host = '';
    try {
      host = new URL(absolute).hostname;
    } catch {
      continue;
    }
    if (NAVER_IMAGE_HOST_RE.test(host)) continue;
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    urls.push(absolute);
  }
  return urls;
}

/** src 속성값의 `&amp;`를 되돌린다(cheerio 직렬화가 넣는다). */
function decodeSrc(value: string): string {
  return (value ?? '').trim().replace(/&amp;/gi, '&');
}

/**
 * 이미지 주소와 content-type으로 업로드 가능한 확장자를 정한다. 순수 함수.
 * 판단이 안 서면 null — 업로드를 시도하지 않고 원래 주소를 유지한다.
 */
export function imageExtensionFor(url: string, contentType = ''): string | null {
  const fromType = CONTENT_TYPE_EXTENSIONS[contentType.split(';')[0].trim().toLowerCase()];
  if (fromType) return fromType;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // 상대/깨진 URL — 문자열 그대로 확장자를 본다
  }
  const ext = path.extname(pathname).toLowerCase();
  return UPLOADABLE_EXTENSIONS.has(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : null;
}

/**
 * 본문의 `<img src>`를 주어진 매핑대로 치환한다. 순수 함수 — 유닛 테스트 대상.
 * 매핑에 없는 이미지는 건드리지 않는다(원래 주소로 발행 — 깨진 이미지를 만들지 않는다).
 */
export function replaceImageSrcs(html: string, byUrl: Map<string, string>): string {
  if (!html || byUrl.size === 0) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (!srcMatch) return tag;
    const src = decodeSrc(srcMatch[1]);
    const absolute = src.startsWith('//') ? `https:${src}` : src;
    const replacement = byUrl.get(absolute);
    if (!replacement) return tag;
    // 함수형 치환: URL에 `$`가 섞여 있어도 치환 패턴으로 해석되지 않는다.
    return tag.replace(srcMatch[0], () => ` src="${replacement}"`);
  });
}

export interface DownloadedRemoteImages {
  /** 외부 주소 → 내려받은 로컬 파일 경로 */
  localByUrl: Map<string, string>;
  /** 내려받지 못한 주소와 사유 (원래 주소로 발행된다) */
  failures: string[];
}

/**
 * 외부 이미지를 로컬 파일로 내려받는다. 실패는 격리하고 계속 진행한다 —
 * 못 받은 이미지는 원래 주소로 발행되어 지금과 같아질 뿐, 더 나빠지지 않는다.
 */
export async function downloadRemoteImages(
  urls: string[],
  dir: string,
  fetcher: ImageFetcher = defaultImageFetcher,
  limit: number = MAX_REMOTE_IMAGES,
): Promise<DownloadedRemoteImages> {
  const localByUrl = new Map<string, string>();
  const failures: string[] = [];
  if (urls.length === 0) return { localByUrl, failures };

  fs.mkdirSync(dir, { recursive: true });
  for (const [index, url] of urls.slice(0, limit).entries()) {
    try {
      const res = await fetcher(url);
      if (res.status < 200 || res.status >= 300 || res.data.length === 0) {
        failures.push(`${url} (status ${res.status})`);
        continue;
      }
      const ext = imageExtensionFor(url, res.contentType);
      if (!ext) {
        failures.push(`${url} (지원하지 않는 이미지 형식: ${res.contentType || 'unknown'})`);
        continue;
      }
      // 파일명은 업로드 URL 회수(basename 매칭)에서 충돌하지 않도록 고유하게 만든다.
      const file = path.join(dir, `remote-${String(index).padStart(2, '0')}-${Date.now()}${ext}`);
      fs.writeFileSync(file, res.data);
      localByUrl.set(url, file);
    } catch (error) {
      failures.push(`${url} (${String(error)})`);
    }
  }
  if (urls.length > limit) {
    failures.push(`외부 이미지 ${urls.length - limit}장은 상한(${limit})을 넘어 건너뛰었다`);
  }
  if (failures.length > 0) {
    logger.warn({ failures }, 'Some remote images could not be downloaded for Naver upload');
  }
  return { localByUrl, failures };
}

// ---------------------------------------------------------------------------
// 업로드 캐시 (2026-09-08)
//
// 같은 광고 이미지를 글마다 다시 올리면 블로그 저장 용량과 업로드 시간이
// 글 수만큼 쌓인다. 특히 다이나믹 배너는 매번 같은 베스트셀러를 돌려주므로
// 동일한 파일을 계속 재업로드하게 된다.
//
// 실측(2026-09-08): 업로드된 `blogfiles.pstatic.net` URL은 세션 없이도 200을
// 돌려주고 referer 제한도 없다 — 즉 **다른 글에서 그대로 재사용할 수 있다**.
// 그래서 외부 주소 → 네이버 URL 매핑을 파일에 남겨, 같은 이미지는 평생 한 번만
// 업로드한다(2번째 글부터 업로드 0회).
// ---------------------------------------------------------------------------

const CACHE_FILE = path.resolve(process.cwd(), 'data', 'naver-remote-images.json');

/**
 * 같은 파일을 여러 호스트로 흘려 주는 CDN — 호스트가 아니라 경로가 이미지의 정체다.
 *
 * 실측(2026-09-08, 1시간 안에): 쿠팡은 동일한 상품 이미지를
 * `img1a.coupangcdn.com/image/affiliate/widget/manual/2019/02/15/624c98ed….jpeg` 로도,
 * `image8.coupangcdn.com/…같은 경로…` 로도 준다. 전체 URL을 캐시 키로 쓰면 호스트가
 * 바뀔 때마다 빗나가 같은 이미지를 계속 다시 업로드한다.
 */
const SHARDED_CDN_SUFFIXES = ['coupangcdn.com'];

/**
 * 캐시 키를 만든다. 순수 함수 — 유닛 테스트 대상.
 * 샤딩 CDN이면 호스트 번호를 무시하고 경로로 식별하고, 그 외는 전체 URL을 쓴다.
 */
export function remoteImageCacheKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const suffix = SHARDED_CDN_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`));
    if (suffix) return `${suffix}${parsed.pathname}${parsed.search}`;
    return `${host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

interface CacheEntry {
  naverUrl: string;
  uploadedAt: string;
}

/** 외부 주소 → 이미 업로드해 둔 네이버 URL. 파일이 없거나 깨졌으면 빈 맵. */
export function loadRemoteImageCache(file: string = CACHE_FILE): Map<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    const out = new Map<string, string>();
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      const naverUrl =
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as CacheEntry).naverUrl
          : undefined;
      // 예전 버전이 전체 URL을 키로 저장했더라도 읽는 쪽에서 정규화해 맞춘다.
      if (typeof naverUrl === 'string' && naverUrl) out.set(remoteImageCacheKey(key), naverUrl);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** 새 매핑을 캐시에 합쳐 저장한다. 저장 실패는 발행을 막지 않는다. */
export function rememberRemoteImages(
  entries: Map<string, string>,
  file: string = CACHE_FILE,
): void {
  if (entries.size === 0) return;
  try {
    const merged: Record<string, CacheEntry> = {};
    for (const [key, naverUrl] of loadRemoteImageCache(file)) {
      merged[key] = { naverUrl, uploadedAt: '' };
    }
    const now = new Date().toISOString();
    for (const [url, naverUrl] of entries) {
      merged[remoteImageCacheKey(url)] = { naverUrl, uploadedAt: now };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  } catch (error) {
    logger.warn({ error: String(error) }, 'Remote image cache could not be saved');
  }
}

/**
 * 캐시된 네이버 URL이 아직 살아 있는지 확인한다(네이버에서 파일을 지웠을 수 있다).
 * 확인 요청 한 번은 에디터 업로드 한 번(수 초)보다 훨씬 싸다.
 */
export async function pickReusableCachedImages(
  urls: string[],
  cache: Map<string, string>,
  fetcher: ImageFetcher = defaultImageFetcher,
): Promise<{ reusable: Map<string, string>; missing: string[] }> {
  const reusable = new Map<string, string>();
  const missing: string[] = [];
  for (const url of urls) {
    const cached = cache.get(remoteImageCacheKey(url));
    if (!cached) {
      missing.push(url);
      continue;
    }
    try {
      const res = await fetcher(cached);
      if (res.status >= 200 && res.status < 300 && res.data.length > 0) {
        reusable.set(url, cached);
        continue;
      }
    } catch {
      // 확인 실패 — 다시 올린다
    }
    logger.warn({ url, cached }, 'Cached Naver image is gone; re-uploading');
    missing.push(url);
  }
  return { reusable, missing };
}
