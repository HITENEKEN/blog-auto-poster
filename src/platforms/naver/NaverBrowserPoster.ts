import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { chromium, type Frame, type Locator, type Page } from 'playwright';
import { ConfigurationError, PlatformError } from '@core/errors';
import { getLogger } from '@core/logger';

const logger = getLogger('naver-browser-poster');

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable, no Playwright involvement)
// ---------------------------------------------------------------------------

/**
 * Decide whether a Naver post should go through the headless-browser path.
 *
 * Rules (contract, see tests/unit/naver-browser.test.ts):
 *  - useBrowser === true                -> browser mode (explicit opt-in, even with a token)
 *  - accessToken present, no useBrowser -> OpenAPI mode (legacy path, unchanged)
 *  - no accessToken                     -> browser mode (the OpenAPI path cannot work)
 */
export function shouldUseBrowserMode(cfg: Record<string, unknown>): boolean {
  if (cfg.useBrowser === true) return true;
  const accessToken = cfg.accessToken != null ? String(cfg.accessToken).trim() : '';
  return accessToken === '';
}

/** Persistent login profile directory (relative to the server cwd, mkdir -p'ed on use). */
export function resolveNaverProfileDir(cwd: string = process.cwd()): string {
  return path.join(cwd, 'data', 'browser-profiles', 'naver');
}

/**
 * Extract the logNo (postId) from a published post URL of the form
 * https://blog.naver.com/{blogId}/{logNo}. Returns null when the URL does not
 * match (query strings and fragments tolerated).
 */
export function extractNaverPostId(url: string): string | null {
  const pathForm = /blog\.naver\.com\/[^/?#]+\/(\d+)/.exec(url);
  if (pathForm) return pathForm[1];
  // 2025+ postwrite redirects to PostView.naver?blogId=…&logNo=… after publish.
  const queryForm = /blog\.naver\.com\/PostView\.naver\?[^#]*blogId=[^#&]+[^#]*logNo=(\d+)/.exec(
    url,
  );
  return queryForm ? queryForm[1] : null;
}

// ---------------------------------------------------------------------------
// RSS 기반 발행 재검증 (이슈 #10 — 발행 확인 클릭은 성공했지만 post view URL
// 감지가 실패해 '실패'로 기록되는 오판 방지). rss.blog.naver.com/{blogId}.xml은
// 로그인 없이 최근 게시물의 제목/링크(logNo)/pubDate를 제공한다.
// ---------------------------------------------------------------------------

export interface NaverRssItem {
  title: string;
  link: string;
  logNo: string | null;
  pubDate: Date | null;
}

/** 네이버 블로그 RSS XML을 item 목록으로 파싱한다. 순수 함수 — 유닛 테스트 대상. */
export function parseNaverRss(xml: string): NaverRssItem[] {
  const items: NaverRssItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/g) ?? [];
  const pick = (block: string, tag: string): string => {
    const m = new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`).exec(block);
    return m ? m[1].trim() : '';
  };
  for (const block of itemBlocks) {
    const link = pick(block, 'link');
    const pubDateRaw = pick(block, 'pubDate');
    const parsedDate = pubDateRaw ? new Date(pubDateRaw) : null;
    items.push({
      title: pick(block, 'title'),
      link,
      logNo: link ? extractNaverPostId(link) : null,
      pubDate: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    });
  }
  return items;
}

/** 공백 차이를 무시하고 제목을 비교하기 위한 정규화. */
function normalizeTitle(title: string): string {
  return (title || '').replace(/\s+/g, '');
}

/**
 * RSS에서 발행 직후(기본 30분)의 동일 제목 게시물을 찾는다. 순수 함수 — 유닛 테스트 대상.
 * 발행 흐름에서 넣은 제목과 RSS 제목이 정규화(공백 제거) 후 일치해야 한다.
 */
export function findRecentlyPublishedRssItem(
  xml: string,
  title: string,
  now: Date,
  windowMs: number = 30 * 60 * 1000,
): NaverRssItem | null {
  const target = normalizeTitle(title);
  if (!target || !xml) return null;
  let latest: NaverRssItem | null = null;
  for (const item of parseNaverRss(xml)) {
    if (normalizeTitle(item.title) !== target) continue;
    if (!item.pubDate) continue;
    const age = now.getTime() - item.pubDate.getTime();
    if (age < 0 || age > windowMs) continue;
    if (!latest || (latest.pubDate && item.pubDate > latest.pubDate)) latest = item;
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Selectors — centralized so a Naver UI change is a one-file fix.
// Each step tries candidates in order; the first visible match wins.
// SmartEditor ONE (modern postwrite) is targeted, with legacy SE2 fallbacks.
// ---------------------------------------------------------------------------
const LOGIN_URL_MARKER = 'nid.naver.com';
export const LOGIN_REQUIRED_MESSAGE =
  '네이버 로그인이 필요합니다. `npm run naver:login`을 먼저 실행하세요.';

const TITLE_SELECTORS = [
  // 2025+ postwrite: title is a plain div module (no contenteditable); typing
  // goes through keyboard events after clicking it.
  '.se-section-documentTitle .se-module-text',
  '#title_input',
  'input[placeholder*="제목"]',
  'textarea[placeholder*="제목"]',
  '.se-section-documentTitle div[contenteditable="true"]',
  'div.se-documentTitle [contenteditable="true"]',
];
const BODY_SELECTORS = [
  // 2025+ postwrite: body text module; content is delivered via the paste
  // pipeline of the hidden input_buffer iframe (see fill-body below).
  '.se-section-text .se-module-text',
  '.se-section-text div[contenteditable="true"]',
  '.se-main-container div[contenteditable="true"]',
  'div.se-component-content[contenteditable="true"]',
  '.se2_inputarea', // legacy SmartEditor 2
];

// HTML/source mode toggle: prefer it when present so raw HTML can be filled.
const HTML_MODE_SELECTORS = [
  'button[title="HTML"]',
  'button:has-text("HTML")',
  '.se-toolbar-btn[title="HTML"]',
  '.se-module-html-toggle',
];
const HTML_SOURCE_SELECTORS = [
  '.se-code-source textarea',
  '.se-section-code textarea',
  'textarea.se-inputarea',
  '.se-html-mode textarea',
];

const TAG_SELECTORS = [
  'input[placeholder*="태그"]',
  '.se-section-tag input',
  '#tag-input',
  '.tag_input',
];

// Publish modal (opened by the first 발행 click) contains 공개/비공개 options.
const PRIVATE_SELECTORS = [
  'input#private-checkbox',
  'input[value="private"]',
  'label:has-text("비공개")',
  'text=비공개',
];

// Image upload (#7): SmartEditor ONE toolbar photo button + hidden file input.
const IMAGE_TOOLBAR_SELECTORS = [
  'button[data-name="image"]',
  'button[title="사진"]',
  'button[aria-label*="사진"]',
  '.se-toolbar-module button[data-command="image"]',
  'button:has-text("사진")',
];
const IMAGE_FILE_INPUT_SELECTORS = [
  'input[type="file"][accept*="image"]',
  'input[type="file"][name*="image"]',
  'input[type="file"]',
];
/** 업로드 완료 판정: 에디터 본문의 이미지 모듈 셀렉터 */
const IMAGE_MODULE_SELECTORS = [
  'img.se-image-resource',
  '.se-module-image img',
  'img[src*="blogfiles"]',
];

const PUBLISH_SELECTORS = [
  // 2025+ postwrite: the settings modal's confirm button (invisible until the
  // modal opens, so the initial 발행 click still resolves to publish_btn).
  'button[class*="confirm_btn"]',
  // Top toolbar publish button (hashed class in the 2025+ editor).
  'button[class*="publish_btn"]',
  // Exact text match avoids the separate "예약 발행" (schedule) button.
  'button:text-is("발행")',
  'a:has-text("발행")',
  '.btn_publish',
  'button[type="submit"]:has-text("발행")',
];

// 발행 설정 모달의 확인 버튼 후보 (#6). 모달이 열렸을 때만 보이므로
// 툴바 발행 버튼(publish_btn)과 구분해 먼저 탐색한다.
const PUBLISH_CONFIRM_SELECTORS = [
  'button[class*="confirm_btn"]',
  '[class*="publish"] button[class*="confirm"]',
  '.se-popup-wrap button[class*="confirm"]',
  'button:text-is("확인")',
];

// Popup/help layers that steal focus on the postwrite page; closed best-effort.
const DISMISS_SELECTORS = [
  '.se-popup-button-cancel',
  '.se-help-panel-close-button',
  'button[aria-label="닫기"]',
  '.se-toaster-close',
];

/**
 * Browser-side DOM surface used to paste HTML into the 2025+ postwrite
 * editor's hidden input_buffer frame. Named shim: the server tsconfig has no
 * DOM lib, so the well-known frame-global shape is declared explicitly.
 */
interface BufferFrameGlobals {
  DataTransfer: new () => { setData(type: string, value: string): void };
  ClipboardEvent: new (
    type: string,
    init?: { clipboardData?: unknown; bubbles?: boolean; cancelable?: boolean },
  ) => unknown;
  document: {
    body: { dispatchEvent(event: unknown): boolean };
    activeElement: { dispatchEvent(event: unknown): boolean } | null;
  };
}

const OVERALL_TIMEOUT_MS = 180_000;
const DEBUG_DIR = 'output/naver-debug';
const DEBUG_SCREENSHOTS_TO_KEEP = 5;

// ---------------------------------------------------------------------------
// Internal plumbing
// ---------------------------------------------------------------------------

async function firstVisible(
  scope: Page | Frame,
  selectors: string[],
  timeoutMs: number,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const sel of selectors) {
      const loc = scope.locator(sel).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        // invalid selector for this page version — move on
      }
    }
    if (Date.now() >= deadline) return null;
    await delay(250);
  }
}

function screenshotPath(step: string): string {
  const dir = path.resolve(process.cwd(), DEBUG_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${stamp}-${step.replace(/[^a-zA-Z0-9_-]+/g, '_')}.png`);
  // Prune old screenshots so the debug dir does not grow unbounded.
  try {
    const files = fs
      .readdirSync(dir)
      .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    for (const old of files.slice(DEBUG_SCREENSHOTS_TO_KEEP)) {
      fs.unlinkSync(path.join(dir, old.f));
    }
  } catch {
    // pruning is best-effort
  }
  return file;
}

/**
 * Run one posting step; on failure capture a debug screenshot and throw a
 * PlatformError naming the failed step and the screenshot path.
 */
async function runStep(page: Page, step: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    let shot = '';
    try {
      shot = screenshotPath(step);
      await page.screenshot({ path: shot, fullPage: true });
    } catch {
      // screenshot failure must not mask the original error
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new PlatformError(
      `Naver browser posting failed at step "${step}": ${reason}` +
        (shot ? ` (screenshot: ${shot})` : ''),
      'naver',
      'BROWSER_POST_FAILED',
      502,
      false,
      { step, screenshot: shot || undefined },
    );
  }
}

/** Find the frame hosting the SmartEditor (postwrite shell may nest iframes). */
async function findEditorFrame(page: Page, timeoutMs: number): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      try {
        for (const sel of ['.se-main-container', ...TITLE_SELECTORS]) {
          if (await frame.locator(sel).first().isVisible()) return frame;
        }
      } catch {
        // detached frame — skip
      }
    }
    if (Date.now() >= deadline) {
      throw new Error('editor frame not found (postwrite page did not render the editor)');
    }
    await delay(250);
  }
}

/** Click the first visible dismissal control, if any. Returns true when one was clicked. */
async function dismissOnePopup(page: Page): Promise<boolean> {
  for (const sel of DISMISS_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 250 })) {
        await loc.click({ timeout: 1000 });
        return true;
      }
    } catch {
      // nothing to dismiss
    }
  }
  return false;
}

/**
 * 화면의 토스트/알럿 텍스트를 모아 반환한다(#6). 발행 실패 원인(예: 제목 누락,
 * 용량 초과)이 토스트로만 노출되므로 wait-published 실패 시 에러 메시지에 첨부한다.
 * 서버 tsconfig에 DOM lib가 없으므로 프레임 전역을 named shim으로 선언한다.
 */
interface ToastProbeGlobal {
  document: {
    querySelectorAll(selectors: string): ArrayLike<{ textContent?: string | null }>;
  };
}

async function collectToastTexts(page: Page): Promise<string> {
  const texts: string[] = [];
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(() => {
        const g = globalThis as unknown as ToastProbeGlobal;
        return Array.from(
          g.document.querySelectorAll(
            '[class*="toast" i], [class*="Toast"], .se-toaster, [role="alert"], .se-popup-alert',
          ),
        )
          .map((el) => (el.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 5);
      });
      texts.push(...found);
    } catch {
      // detached frame — skip
    }
  }
  return texts.slice(0, 5).join(' | ');
}

async function dismissPopups(page: Page): Promise<void> {
  // Popup layers (draft recovery, help panels) appear asynchronously a few
  // seconds after postwrite loads, so sweep until a round finds nothing.
  for (let round = 0; round < 4; round++) {
    if (!(await dismissOnePopup(page))) return;
    await delay(500);
  }
}

/**
 * Click a locator, dismissing alert popup layers that intercept the pointer.
 * Recovery dialogs load after the initial dismiss-popups step, so the steps
 * that click the editor must tolerate and clear them mid-flight. If the
 * pointer click still fails (transient toast layers can cover a button
 * without any dismissible ancestor), fall back to a DOM click on the element,
 * which bypasses hit-testing.
 */
async function clickDismissingPopups(page: Page, loc: Locator, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let useDomClick = false;
  for (;;) {
    if (useDomClick) {
      await loc.evaluate((el: { click(): void }) => el.click());
      return;
    }
    try {
      await loc.click({ timeout: 2_500 });
      return;
    } catch (error) {
      const dismissed = await dismissOnePopup(page);
      if (dismissed) continue;
      if (Date.now() >= deadline) throw error;
      useDomClick = true;
    }
  }
}

/**
 * 에디터에 로컬 이미지 파일들을 업로드한다(#7).
 *
 * 전략: 에디터의 사진 삽입 버튼(툴바)을 클릭해 파일 선택 input을 노출시킨 뒤
 * Playwright setInputFiles로 파일을 넘기고, 에디터 이미지 모듈 수 증가로
 * 업로드 완료를 판정한다. 네이버 에디터 개편에 대비해 셀렉터는 모두 후보 배열이고,
 * 개별 이미지 실패는 errors에 기록하고 계속 진행한다(A3 폴백: 일부만 성공해도 유효).
 *
 * 커서 위치: 호출부가 본문을 클릭한 뒤 Ctrl+Home/Meta+Up으로 문서 시작부에 두므로
 * 첫 이미지(대표 이미지)가 본문 최상단에 삽입된다.
 */
async function uploadNaverImages(
  page: Page,
  editor: Frame | undefined,
  images: string[],
): Promise<{ uploaded: number; errors: string[] }> {
  const errors: string[] = [];
  const valid = filterExistingImagePaths(images);
  if (valid.length === 0) return { uploaded: 0, errors: ['no existing local image files'] };

  const countEditorImages = async (): Promise<number> => {
    let count = 0;
    for (const frame of page.frames()) {
      for (const sel of IMAGE_MODULE_SELECTORS) {
        try {
          count += await frame.locator(sel).count();
        } catch {
          // detached frame — skip
        }
      }
    }
    return count;
  };

  const findFileInput = async (): Promise<Locator | null> => {
    // 툴바 클릭으로 파일 다이얼로그가 열린 상태 — page와 모든 프레임을 훑는다
    for (const scope of [page, ...page.frames()]) {
      const input = await firstVisible(scope, IMAGE_FILE_INPUT_SELECTORS, 600);
      if (input) return input;
    }
    return null;
  };

  let uploaded = 0;
  for (const img of valid) {
    try {
      const before = await countEditorImages();

      const photoButton = await firstVisible(editor ?? page, IMAGE_TOOLBAR_SELECTORS, 2_000);
      if (photoButton) await clickDismissingPopups(page, photoButton, 3_000).catch(() => {});

      const fileInput = await findFileInput();
      if (!fileInput) throw new Error('image file input not found');
      await fileInput.setInputFiles(img);

      const uploadDeadline = Date.now() + 20_000;
      for (;;) {
        if ((await countEditorImages()) > before) break;
        if (Date.now() >= uploadDeadline) {
          throw new Error(`image upload did not complete: ${path.basename(img)}`);
        }
        await delay(500);
      }
      uploaded += 1;
      logger.info({ image: path.basename(img), uploaded }, 'Editor image uploaded');
      await dismissOnePopup(page).catch(() => {});
    } catch (error) {
      errors.push(`${path.basename(img)}: ${String(error)}`);
      logger.warn(
        { image: path.basename(img), error: String(error) },
        'Image upload failed; skipping',
      );
      await dismissOnePopup(page).catch(() => {});
    }
  }
  return { uploaded, errors };
}

// ---------------------------------------------------------------------------

/**
 * HTML에서 로컬 경로(상대경로·file) `<img>` 태그를 제거한다(#7).
 * 네이버 에디터에 붙여넣는 시점에 `output/images/...` 같은 로컬 src는
 * 깨진 이미지로 렌더링되므로, 실제 파일은 업로드 단계에서 삽입한다.
 * http(s)/data/프로토콜 상대 URL은 그대로 둔다. 퓨어 헬퍼 — 유닛 테스트 대상.
 */
export function stripLocalImageTags(html: string): string {
  if (!html) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag);
    const src = srcMatch?.[1] ?? '';
    if (/^(?:https?:)?\/\//i.test(src) || /^data:/i.test(src)) return tag;
    return '';
  });
}

export interface NaverBrowserPostOptions {
  blogId: string;
  title: string;
  html: string;
  tags?: string[];
  visibility?: 'public' | 'private';
  headless: boolean;
  /** 본문에 삽입할 이미지 로컬 파일 경로 (#7). 첫 항목이 대표 이미지가 된다. */
  images?: string[];
}

/** 존재하는 로컬 이미지 파일만 필터링한다(순서 유지). 퓨어 헬퍼 — 유닛 테스트 대상. */
export function filterExistingImagePaths(
  images: string[] | undefined,
  exists: (p: string) => boolean = (p) => fs.existsSync(p),
): string[] {
  if (!images || images.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const img of images) {
    if (!img || !exists(img)) continue;
    if (seen.has(img)) continue;
    seen.add(img);
    out.push(img);
  }
  return out;
}

export interface NaverBrowserPostResult {
  postId: string;
  url: string;
}

/**
 * Publish a post to a Naver blog through headless/headed Playwright browsing.
 * Reuses the persistent login profile at data/browser-profiles/naver so the
 * user only logs in once via `npm run naver:login`.
 */
export async function postToNaverBlog(
  opts: NaverBrowserPostOptions,
): Promise<NaverBrowserPostResult> {
  const profileDir = resolveNaverProfileDir();
  fs.mkdirSync(profileDir, { recursive: true });

  const deadline = Date.now() + OVERALL_TIMEOUT_MS;
  const remaining = () => Math.max(5_000, deadline - Date.now());
  const blogId = opts.blogId;
  const postUrlPattern = new RegExp(
    `blog\\.naver\\.com\\/(?:${blogId}\\/\\d+|PostView\\.naver\\?[^#]*logNo=\\d+)`,
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: opts.headless,
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    args: ['--disable-blink-features=AutomationControlled'],
  });

  let page: Page | undefined;
  try {
    page = context.pages()[0] ?? (await context.newPage());

    // Session pre-check: headless flows cannot pass 2FA, so the persistent
    // profile must already carry the NID_AUT login cookie. Without it the
    // postwrite page renders a login wall instead of redirecting, so check
    // the cookie up front and fail with the actionable message.
    const cookies = await context.cookies('https://www.naver.com');
    if (!cookies.some((c) => c.name === 'NID_AUT')) {
      throw new ConfigurationError(LOGIN_REQUIRED_MESSAGE, 'naver', 'NAVER_LOGIN_REQUIRED');
    }

    await runStep(page, 'open-postwrite', async () => {
      await page!.goto(`https://blog.naver.com/${blogId}/postwrite`, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(30_000, remaining()),
      });
    });

    // Logged-out detection: Naver redirects to the login page. We never attempt
    // automated credential login — the persistent profile is the only auth path.
    if (page.url().includes(LOGIN_URL_MARKER)) {
      throw new ConfigurationError(LOGIN_REQUIRED_MESSAGE, 'naver', 'NAVER_LOGIN_REQUIRED');
    }
    await runStep(page, 'login-check', async () => {
      await page!.waitForLoadState('domcontentloaded', { timeout: Math.min(10_000, remaining()) });
      if (page!.url().includes(LOGIN_URL_MARKER)) {
        throw new ConfigurationError(LOGIN_REQUIRED_MESSAGE, 'naver', 'NAVER_LOGIN_REQUIRED');
      }
    });

    let editor: Frame | undefined;
    await runStep(page, 'find-editor', async () => {
      editor = await findEditorFrame(page!, Math.min(20_000, remaining()));
    });

    await runStep(page, 'dismiss-popups', () => dismissPopups(page!));

    // Title
    await runStep(page, 'fill-title', async () => {
      const title = await firstVisible(editor!, TITLE_SELECTORS, Math.min(10_000, remaining()));
      if (!title) throw new Error(`no title input matched: ${TITLE_SELECTORS.join(', ')}`);
      const tag = (await title.evaluate((el) => el.tagName)).toLowerCase();
      if (tag === 'input' || tag === 'textarea') {
        await title.fill(opts.title);
      } else {
        await clickDismissingPopups(page!, title, Math.min(10_000, remaining()));
        await page!.keyboard.insertText(opts.title);
      }
    });

    // Body — prefer the HTML/source mode toggle, else inject into the rich editor.
    // 로컬 경로 <img> 태그는 네이버에서 깨지므로 제거(#7) — 실제 이미지는 upload-images 스텝에서 업로드한다.
    const publishHtml = stripLocalImageTags(opts.html);
    let bodyFilled = false;
    await runStep(page, 'fill-body', async () => {
      const toggle = await firstVisible(editor!, HTML_MODE_SELECTORS, 2_000);
      if (toggle) {
        await toggle.click({ timeout: 3_000 }).catch(() => {});
        const source = await firstVisible(editor!, HTML_SOURCE_SELECTORS, 3_000);
        if (source) {
          await source.fill(publishHtml);
          bodyFilled = true;
          // Toggle back so the preview/publish path sees the composed document.
          await toggle.click({ timeout: 3_000 }).catch(() => {});
        }
      }
      if (!bodyFilled) {
        const body = await firstVisible(editor!, BODY_SELECTORS, Math.min(15_000, remaining()));
        if (!body) throw new Error(`no editor body matched: ${BODY_SELECTORS.join(', ')}`);
        // 2025+ postwrite: clicking the text module moves focus into a hidden
        // contenteditable inside an `input_buffer` iframe; the HTML must be
        // delivered through that frame's paste pipeline. Validated live: the
        // editor consumes the ClipboardEvent and renders text modules.
        await clickDismissingPopups(page!, body, 8_000);
        await page!.waitForTimeout(300);
        const buffer = page!.frames().find((f) => f.name().startsWith('input_buffer'));
        if (buffer) {
          // The server tsconfig has no DOM lib; shims type the browser-side
          // evaluation only. At runtime the code executes inside the frame.
          await buffer.evaluate((html) => {
            // Named shim (rule: no inline-cast member access); the shape is
            // the well-known DOM surface of the frame, untypeable here because
            // the server tsconfig has no DOM lib.
            const g = globalThis as unknown as BufferFrameGlobals;
            const dt = new g.DataTransfer();
            dt.setData('text/html', html);
            const target = g.document.activeElement ?? g.document.body;
            target.dispatchEvent(
              new g.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
            );
          }, publishHtml);
        } else {
          // Legacy SmartEditor: focus + direct innerHTML injection.
          const handle = await body.elementHandle();
          if (!handle) throw new Error('editor body element handle unavailable');
          interface EditorElement {
            focus(): void;
            innerHTML: string;
            dispatchEvent(event: unknown): boolean;
          }
          interface EditorEventInit {
            bubbles?: boolean;
            cancelable?: boolean;
          }
          type InputEventCtor = new (type: string, init?: EditorEventInit) => unknown;
          const InputEventImpl = (globalThis as unknown as { InputEvent: InputEventCtor })
            .InputEvent;
          await page!.evaluate((el) => {
            const host = el as unknown as EditorElement;
            host.focus();
            host.innerHTML = '';
            host.dispatchEvent(new InputEventImpl('input', { bubbles: true }));
          }, handle);
          await body.evaluate((el, html) => {
            const host = el as unknown as EditorElement;
            host.innerHTML = html;
            host.dispatchEvent(new InputEventImpl('input', { bubbles: true, cancelable: true }));
          }, publishHtml);
        }
        bodyFilled = true;
      }
    });

    // Tags — type each tag followed by Enter so the editor registers chips.
    if (opts.tags && opts.tags.length > 0) {
      await runStep(page, 'fill-tags', async () => {
        const tagInput = await firstVisible(editor!, TAG_SELECTORS, Math.min(5_000, remaining()));
        if (!tagInput) throw new Error(`no tag input matched: ${TAG_SELECTORS.join(', ')}`);
        for (const tag of opts.tags!) {
          await tagInput.fill(tag);
          await tagInput.press('Enter');
          await delay(200);
        }
        // 태그 자동완성 드롭다운이 열려 남으면 발행 클릭을 가로챈다(#6 실패 원인) —
        // Escape으로 닫고 포커스를 벗어나게 한다.
        await tagInput.press('Escape').catch(() => {});
        await page!.keyboard.press('Escape').catch(() => {});
        await delay(300);
      });
    }

    // 발행 직전 정리(#6): 남아 있는 팝업/자동완성 레이어를 닫는다.
    await runStep(page, 'pre-publish', async () => {
      await dismissPopups(page!);
      await page!.keyboard.press('Escape').catch(() => {});
      await delay(300);
    });

    // Images (#7) — best-effort upload. 실패해도 텍스트 발행은 계속 진행한다(A3 폴백).
    // 커서를 문서 시작부로 옮겨 첫 이미지(대표 이미지)가 본문 최상단에 삽입되게 한다.
    if (filterExistingImagePaths(opts.images).length > 0) {
      await runStep(page, 'upload-images', async () => {
        const body = await firstVisible(editor!, BODY_SELECTORS, 3_000).catch(() => null);
        if (body) {
          await clickDismissingPopups(page!, body, 3_000).catch(() => {});
          // macOS(headless Chromium)와 일반 환경 모두에서 문서 시작부로 커서 이동
          await page!.keyboard.press('Control+Home').catch(() => {});
          await page!.keyboard.press('Meta+ArrowUp').catch(() => {});
        }
        const { uploaded, errors } = await uploadNaverImages(page!, editor, opts.images!);
        if (errors.length > 0) {
          logger.warn({ errors }, 'Some Naver editor images failed to upload');
        }
        logger.info({ uploaded }, 'Naver editor image upload finished');
      }).catch(async (error) => {
        // 이미지 업로드 실패는 발행을 막지 않는다 — 디버그 스크린샷만 남긴다.
        logger.warn(
          { error: String(error) },
          'Image upload step failed; continuing text-only publish',
        );
        try {
          await page!.screenshot({ path: screenshotPath('upload-images-failed'), fullPage: true });
        } catch {
          // best-effort
        }
      });
    }

    // Publish — first click opens the settings modal, the final click confirms.
    await runStep(page, 'click-publish', async () => {
      const publish = await firstVisible(
        editor ?? page!,
        PUBLISH_SELECTORS,
        Math.min(10_000, remaining()),
      );
      if (!publish) throw new Error(`no publish button matched: ${PUBLISH_SELECTORS.join(', ')}`);
      await clickDismissingPopups(page!, publish, 6_000);
    });

    if (opts.visibility === 'private') {
      await runStep(page, 'set-private', async () => {
        const scope: Page | Frame = editor ?? page!;
        const priv = await firstVisible(scope, PRIVATE_SELECTORS, Math.min(5_000, remaining()));
        if (!priv) throw new Error(`no 비공개 option matched: ${PRIVATE_SELECTORS.join(', ')}`);
        const tag = (await priv.evaluate((el) => el.tagName)).toLowerCase();
        if (tag === 'input') {
          await priv.check({ timeout: 3_000 });
        } else {
          await priv.click({ timeout: 3_000 });
        }
      });
    }

    await runStep(page, 'confirm-publish', async () => {
      // 설정 모달이 뜰 시간을 짧게 기다린 뒤 모달의 확인 버튼을 먼저 찾고(#6 —
      // 툴바 발행 버튼을 다시 눌러 모달을 닫아버리는 것을 방지), 없으면 기존
      // PUBLISH_SELECTORS로 폴백한다.
      const confirm =
        (await firstVisible(
          editor ?? page!,
          PUBLISH_CONFIRM_SELECTORS,
          Math.min(6_000, remaining()),
        )) ??
        (await firstVisible(editor ?? page!, PUBLISH_SELECTORS, Math.min(3_000, remaining())));
      if (confirm) {
        await clickDismissingPopups(page!, confirm, 5_000).catch(() => {
          // The modal may have closed after the first click — tolerate it.
        });
      }
    });

    // Wait for navigation to the post view URL (top-level or a spawned tab).
    let finalUrl = '';
    await runStep(page, 'wait-published', async () => {
      const ctx = context;
      const popupPromise = ctx
        .waitForEvent('page', { timeout: Math.min(45_000, remaining()) })
        .then((p) => p)
        .catch(() => null);
      const navPromise = page!
        .waitForURL(postUrlPattern, { timeout: Math.min(45_000, remaining()) })
        .then(() => page!.url())
        .catch(() => '');
      const popup = await popupPromise;
      finalUrl = (await navPromise) || (popup ? popup.url() : '');
      if (!extractNaverPostId(finalUrl)) {
        // Last-chance poll: some flows update the URL asynchronously. During the
        // poll, a re-appeared settings modal (발행 미확정 상태) is confirmed once more.
        const pollDeadline = Date.now() + Math.min(15_000, remaining());
        let reconfirmed = false;
        while (Date.now() < pollDeadline) {
          for (const pg of ctx.pages()) {
            if (extractNaverPostId(pg.url())) {
              finalUrl = pg.url();
              break;
            }
          }
          if (!extractNaverPostId(finalUrl) && !reconfirmed) {
            const confirm = await firstVisible(
              editor ?? page!,
              PUBLISH_CONFIRM_SELECTORS,
              400,
            ).catch(() => null);
            if (confirm) {
              reconfirmed = true;
              await clickDismissingPopups(page!, confirm, 3_000).catch(() => {});
            }
          }
          if (extractNaverPostId(finalUrl)) break;
          await delay(500);
        }
      }
      if (!extractNaverPostId(finalUrl)) {
        // 재검증(이슈 #10): 발행 확인 클릭 자체는 성공했지만 post view URL 감지가
        // 실패한 경우가 있다(리다이렉트 지연, 팝업 가림 등). 이 상태에서 실패로
        // 기록하면 실제로는 발행된 글이 '실패'로 표시되는 오판이 생기므로, 던지기
        // 전에 공개 RSS로 최근 발행 게시물(동일 제목)을 확인한다.
        try {
          const rssRes = await context.request.get(`https://rss.blog.naver.com/${blogId}.xml`, {
            timeout: Math.min(10_000, remaining()),
          });
          if (rssRes.ok()) {
            const item = findRecentlyPublishedRssItem(await rssRes.text(), opts.title, new Date());
            if (item?.logNo) {
              finalUrl = `https://blog.naver.com/${blogId}/${item.logNo}`;
              logger.info(
                { logNo: item.logNo, blogId },
                'Naver publish verified via RSS after URL detection failure',
              );
            }
          }
        } catch (verifyError) {
          // 재검증 실패는 원래 실패 흐름을 따른다 — 진단 정보로만 로그에 남긴다.
          logger.warn({ error: String(verifyError) }, 'Naver RSS publish verification failed');
        }
      }
      if (!extractNaverPostId(finalUrl)) {
        // 원인 파악용: 화면의 토스트/알럿 텍스트를 에러에 첨부한다(#6).
        const toasts = await collectToastTexts(page!);
        throw new Error(
          `post view URL not detected (last url: ${page!.url()})` +
            (toasts ? ` — page alerts: ${toasts}` : ''),
        );
      }
    });

    const postId = extractNaverPostId(finalUrl)!;
    const url = `https://blog.naver.com/${blogId}/${postId}`;
    logger.info({ postId, url }, 'Naver post published via browser');
    return { postId, url };
  } catch (error) {
    // Debug capture for non-step failures (launch, unexpected throws).
    if (page && !(error instanceof ConfigurationError)) {
      try {
        await page.screenshot({ path: screenshotPath('unexpected'), fullPage: true });
      } catch {
        // best-effort
      }
    }
    if (error instanceof ConfigurationError || error instanceof PlatformError) throw error;
    throw new PlatformError(
      `Naver browser posting failed: ${error instanceof Error ? error.message : String(error)}`,
      'naver',
      'BROWSER_POST_FAILED',
      502,
      false,
    );
  } finally {
    await context.close().catch(() => {});
  }
}
