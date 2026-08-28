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
  const m = /blog\.naver\.com\/[^/?#]+\/(\d+)/.exec(url);
  return m ? m[1] : null;
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
  '#title_input',
  'input[placeholder*="제목"]',
  'textarea[placeholder*="제목"]',
  '.se-section-documentTitle div[contenteditable="true"]',
  'div.se-documentTitle [contenteditable="true"]',
];

const BODY_SELECTORS = [
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

const PUBLISH_SELECTORS = [
  'button:has-text("발행")',
  'a:has-text("발행")',
  '.btn_publish',
  'button[type="submit"]:has-text("발행")',
];

// Popup/help layers that steal focus on the postwrite page; closed best-effort.
const DISMISS_SELECTORS = [
  '.se-popup-button-cancel',
  '.se-help-panel-close-button',
  'button[aria-label="닫기"]',
  '.se-toaster-close',
];

const OVERALL_TIMEOUT_MS = 120_000;
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

async function dismissPopups(page: Page): Promise<void> {
  for (const sel of DISMISS_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 250 })) {
        await loc.click({ timeout: 1000 });
      }
    } catch {
      // nothing to dismiss
    }
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface NaverBrowserPostOptions {
  blogId: string;
  title: string;
  html: string;
  tags?: string[];
  visibility?: 'public' | 'private';
  headless: boolean;
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
  const postUrlPattern = new RegExp(`blog\\.naver\\.com\\/${blogId}\\/\\d+`);

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
        await title.click();
        await page!.keyboard.insertText(opts.title);
      }
    });

    // Body — prefer the HTML/source mode toggle, else inject into the rich editor.
    let bodyFilled = false;
    await runStep(page, 'fill-body', async () => {
      const toggle = await firstVisible(editor!, HTML_MODE_SELECTORS, 2_000);
      if (toggle) {
        await toggle.click({ timeout: 3_000 }).catch(() => {});
        const source = await firstVisible(editor!, HTML_SOURCE_SELECTORS, 3_000);
        if (source) {
          await source.fill(opts.html);
          bodyFilled = true;
          // Toggle back so the preview/publish path sees the composed document.
          await toggle.click({ timeout: 3_000 }).catch(() => {});
        }
      }
      if (!bodyFilled) {
        const body = await firstVisible(editor!, BODY_SELECTORS, Math.min(15_000, remaining()));
        if (!body) throw new Error(`no editor body matched: ${BODY_SELECTORS.join(', ')}`);
        const handle = await body.elementHandle();
        if (!handle) throw new Error('editor body element handle unavailable');
        // The server tsconfig has no DOM lib; these shims type the browser-side
        // evaluation only. At runtime the code executes inside the page.
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
        const InputEventImpl = (globalThis as unknown as { InputEvent: InputEventCtor }).InputEvent;
        await page!.evaluate((el) => {
          const host = el as unknown as EditorElement;
          host.focus();
          host.innerHTML = '';
          host.dispatchEvent(new InputEventImpl('input', { bubbles: true }));
        }, handle);
        // Insert HTML directly: the editor's input pipeline registers the content.
        await body.evaluate((el, html) => {
          const host = el as unknown as EditorElement;
          host.innerHTML = html;
          host.dispatchEvent(new InputEventImpl('input', { bubbles: true, cancelable: true }));
        }, opts.html);
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
      await publish.click({ timeout: 5_000 });
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
      const confirm = await firstVisible(
        editor ?? page!,
        PUBLISH_SELECTORS,
        Math.min(5_000, remaining()),
      );
      if (confirm) {
        await confirm.click({ timeout: 5_000 }).catch(async () => {
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
        // Last-chance poll: some flows update the URL asynchronously.
        const pollDeadline = Date.now() + Math.min(15_000, remaining());
        while (Date.now() < pollDeadline) {
          for (const pg of ctx.pages()) {
            if (extractNaverPostId(pg.url())) {
              finalUrl = pg.url();
              break;
            }
          }
          if (extractNaverPostId(finalUrl)) break;
          await delay(500);
        }
      }
      if (!extractNaverPostId(finalUrl)) {
        throw new Error(`post view URL not detected (last url: ${page!.url()})`);
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
