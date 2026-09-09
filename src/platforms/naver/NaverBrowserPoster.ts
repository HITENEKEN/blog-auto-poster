import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { setTimeout as delay } from 'timers/promises';
import { chromium, type Frame, type Locator, type Page } from 'playwright';
import { ConfigurationError, PlatformError } from '@core/errors';
import { getLogger } from '@core/logger';
import { collectPublishedPostFailures } from './PublishedPostInspector';
import {
  collectRemoteImageUrls,
  downloadRemoteImages,
  loadRemoteImageCache,
  pickReusableCachedImages,
  rememberRemoteImages,
  replaceImageSrcs,
} from './RemoteImages';

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

/** 공백 차이를 무시하고 제목을 비교하기 위한 정규화. 말줄임표(.../…)도 제거한다. */
function normalizeTitle(title: string): string {
  return (title || '').replace(/\s+/g, '').replace(/(?:\.{2,}|…)+$/g, '');
}

/**
 * RSS에서 발행 직후(기본 30분)의 동일 제목 게시물을 찾는다. 순수 함수 — 유닛 테스트 대상.
 * 발행 흐름에서 넣은 제목과 RSS 제목이 정규화(공백 제거) 후 일치해야 한다.
 * 네이버 RSS는 긴 제목을 잘라내므로(접미사 생략) 짧은 쪽이 10자 이상이면
 * 접두사 일치도 허용한다(이슈 #16 — 실제 발행됐는데 실패로 표시되는 오판 방지).
 */
export function findRecentlyPublishedRssItem(
  xml: string,
  title: string,
  now: Date,
  windowMs: number = 30 * 60 * 1000,
): NaverRssItem | null {
  const target = normalizeTitle(title);
  if (!target || !xml) return null;
  const PREFIX_MIN_LEN = 10;
  const titlesMatch = (rssTitle: string): boolean => {
    const normalized = normalizeTitle(rssTitle);
    if (!normalized) return false;
    if (normalized === target) return true;
    if (Math.min(normalized.length, target.length) < PREFIX_MIN_LEN) return false;
    return normalized.startsWith(target) || target.startsWith(normalized);
  };
  let latest: NaverRssItem | null = null;
  for (const item of parseNaverRss(xml)) {
    if (!titlesMatch(item.title)) continue;
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

// 외부 이미지(쿠팡 상품 카드 등)도 네이버에 업로드하므로 업로드 횟수가 늘었다.
// 업로드 1장당 수 초가 들어 기존 180초로는 이미지가 많은 글에서 빠듯하다.
const OVERALL_TIMEOUT_MS = 300_000;
const DEBUG_DIR = 'output/naver-debug';
const DEBUG_SCREENSHOTS_TO_KEEP = 5;

/** `.se-main-container` 읽기용 named shim(서버 tsconfig에 DOM lib가 없음) */
interface EditorContainerGlobals {
  document?: {
    querySelector?(selector: string): { innerHTML?: string } | null;
  };
}

/** 에디터 본문 컨테이너 후보 — 앞에서부터 먼저 맞는 것을 쓴다. */
const EDITOR_CONTENT_SELECTORS = [
  '.se-main-container',
  '.se-viewer .se-main-container',
  '.se-container .se-canvas',
];

/** 에디터 본문 읽기 결과 — 어떤 프레임/셀렉터로 읽었는지까지 남긴다(진단용). */
interface EditorContent {
  html: string;
  frame: string;
  selector: string;
}

/**
 * 에디터 본문에 실제 반영된 HTML을 읽는다(이슈 #20 T1, 2026-09-08 재작성).
 *
 * 발행물에 직렬화되는 바로 그 영역(`.se-main-container`)만 읽는다 — postwrite
 * 페이지의 툴바·설정 레이어·input_buffer까지 세면 무결성 검증이 오판한다.
 *
 * 2026-09-07 실발행물(logNo 224404059950)에서 이 함수가 빈 문자열을 돌려줘
 * `links 0/4, images 0/6`으로 판정됐고, 그 오판이 재붙여넣기를 불러 본문이
 * 2배로 발행됐다. 그래서 두 가지를 고친다:
 *
 *  - `findEditorFrame`이 이미 찾아둔 editor 프레임을 **먼저** 시도한다.
 *  - 반환 타입을 `EditorContent | null`로 바꿔 **"못 읽음(null)"과 "본문이 비었음('')"**
 *    을 구분한다. 못 읽은 것을 "비었다"로 오해하는 순간 파괴적 재시도가 시작된다.
 */
async function readEditorContentHtml(page: Page, editor?: Frame): Promise<EditorContent | null> {
  const frames = editor ? [editor, ...page.frames().filter((f) => f !== editor)] : page.frames();
  for (const frame of frames) {
    const found = await frame
      .evaluate((selectors: string[]) => {
        const g = globalThis as unknown as EditorContainerGlobals;
        for (const selector of selectors) {
          const container = g.document?.querySelector?.(selector);
          if (container && typeof container.innerHTML === 'string') {
            return { html: container.innerHTML, selector };
          }
        }
        return null;
      }, EDITOR_CONTENT_SELECTORS)
      .catch(() => null);
    if (found) {
      return { html: found.html, frame: frame.name() || frame.url(), selector: found.selector };
    }
  }
  return null;
}

/** `.se-component` 신호 읽기용 named shim(서버 tsconfig에 DOM lib가 없음) */
interface EditorSignalNode {
  textContent?: string | null;
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
  cloneNode(deep: boolean): EditorSignalNode;
}

interface EditorSignalGlobals {
  document?: {
    querySelectorAll?(selector: string): ArrayLike<EditorSignalNode>;
  };
}

/** 에디터 본문에 "내용이 있는지"를 판정하는 신호. */
export interface EditorContentSignals {
  /** 본문 컴포넌트(.se-component) 수 */
  components: number;
  /** 컴포넌트 안의 이미지 수 */
  images: number;
  /** 컴포넌트 안의 텍스트 길이(공백 정규화) */
  textLength: number;
}

/**
 * 에디터 본문이 비었는지 **콘텐츠 모듈 기준**으로 읽는다.
 *
 * 2026-09-08 실측: postwrite 에디터에는 `.se-main-container`가 없고 캔버스는
 * `.se-container .se-canvas`다. 그런데 캔버스에는 본문 외에 에디터 장식
 * (`se-content-guide`, `se-selection`, 캐럿 svg)이 항상 들어 있어, 캔버스
 * innerHTML로 "비었나"를 판정하면 **항상 '안 비었다'**가 나온다. 그 오판이
 * "비우고 재시도" 경로에서 본문을 지운 뒤 재붙여넣기를 건너뛰게 만들어
 * 에디터를 통째로 비웠다. 그래서 `.se-component`(실제 콘텐츠 모듈)만 본다.
 */
async function readEditorContentSignals(
  page: Page,
  editor?: Frame,
): Promise<EditorContentSignals | null> {
  const frames = editor ? [editor, ...page.frames().filter((f) => f !== editor)] : page.frames();
  for (const frame of frames) {
    const signals = await frame
      .evaluate(() => {
        const g = globalThis as unknown as EditorSignalGlobals;
        // 제목도 `.se-component`다(실측 class: "se-component se-documentTitle …").
        // 재시도 경로의 clear는 제목 입력 **뒤**에 돌기 때문에, 제목을 포함해서
        // 세면 본문이 비었는데도 "안 비었다"로 판정된다.
        const nodes = g.document?.querySelectorAll?.('.se-component:not([class*="documentTitle"])');
        if (!nodes || nodes.length === 0) return null;
        let images = 0;
        let text = '';
        for (let i = 0; i < nodes.length; i += 1) {
          // 빈 에디터의 안내문("글감과 함께 …")도 textContent에 잡히므로 떼고 센다.
          const clone = nodes[i].cloneNode(true);
          const placeholders = clone.querySelectorAll('[class*="placeholder"]');
          for (let j = 0; j < placeholders.length; j += 1) placeholders[j].remove();
          images += clone.querySelectorAll('img').length;
          text += clone.textContent ?? '';
        }
        return {
          components: nodes.length,
          images,
          textLength: text.replace(/\s+/g, ' ').trim().length,
        };
      })
      .catch(() => null);
    if (signals) return signals;
  }
  return null;
}

/** 본문이 비었는지 — 이미지도 텍스트도 없으면 비어 있다(빈 문단은 허용). */
export function isEditorEmpty(signals: EditorContentSignals | null): boolean {
  if (!signals) return false;
  return signals.images === 0 && signals.textLength === 0;
}

/** 붙여넣기 결과가 안정될 때까지의 폴링 간격/최대 대기 */
const EDITOR_SETTLE_POLL_MS = 500;
const EDITOR_SETTLE_TIMEOUT_MS = 8_000;

/**
 * 붙여넣기 직후 본문이 **안정될 때까지** 폴링해서 읽는다.
 *
 * 기존에는 고정 800ms 뒤 한 번만 읽었다. SE는 붙여넣은 원격 이미지를 비동기로
 * 모듈화하므로(실측: 원격 이미지 3장), 그 전에 읽으면 요소 수가 모자라 보이고
 * 무결성 오판 → 재붙여넣기 → 본문 2배로 이어진다.
 *
 * 길이가 2회 연속 같으면 안정으로 보고 확정한다. 모든 읽기가 실패하면 null.
 */
async function readSettledEditorHtml(page: Page, editor?: Frame): Promise<EditorContent | null> {
  const deadline = Date.now() + EDITOR_SETTLE_TIMEOUT_MS;
  let last: EditorContent | null = null;
  let stableRounds = 0;
  for (;;) {
    await page.waitForTimeout(EDITOR_SETTLE_POLL_MS);
    const current = await readEditorContentHtml(page, editor);
    if (current) {
      if (last && current.html.length === last.html.length) {
        stableRounds += 1;
        if (stableRounds >= 2) return current;
      } else {
        stableRounds = 0;
      }
      last = current;
    }
    if (Date.now() >= deadline) return last;
  }
}

/**
 * 숨겨진 `input_buffer` 프레임의 paste 파이프라인에 HTML을 던진다(이슈 #20 T1).
 *
 * 2025+ postwrite는 본문 텍스트 모듈을 클릭하면 포커스가 `input_buffer` iframe의
 * 숨은 contenteditable로 이동하고, SE는 그 paste 이벤트만 소비해 모듈을 만든다.
 * 라이브 검증됨(원본 위치를 보존한 remote <img>가 `se-image` 모듈로 발행됐다).
 *
 * 재시도에서도 같은 경로를 쓰도록 함수로 분리했다. 서버 tsconfig에 DOM lib가
 * 없어 프레임 내부 코드는 명명된 shim(`BufferFrameGlobals`)으로만 타입한다.
 */
async function pasteHtmlIntoBuffer(buffer: Frame, html: string): Promise<void> {
  await buffer.evaluate((payload) => {
    const g = globalThis as unknown as BufferFrameGlobals;
    const dt = new g.DataTransfer();
    dt.setData('text/html', payload);
    const target = g.document.activeElement ?? g.document.body;
    target.dispatchEvent(
      new g.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, html);
}

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
 * 에디터에 로컬 이미지 파일들을 업로드해 네이버가 발급한 URL을 회수한다(#7, #19, #20).
 *
 * 호출 시점은 본문 입력 **이전**(빈 에디터)이다 — 이미지가 본문에 남는 것이 목적이
 * 아니라 URL을 얻는 것이 목적이고, 직후 `clear-editor` 스텝이 본문을 비운다.
 *
 * 1차 전략(라이브 검증 완료): 사진 툴바 버튼 클릭과 filechooser 이벤트를 대기해
 * 네이버가 여는 파일 선택기를 직접 받아 파일을 넘긴다. 숨김 file input의 DOM
 * 구조 변화와 무관하게 동작하며, 버튼 클릭이 실제로 핸들러를 트리거했는지도
 * 보장한다(버튼 클릭 실패 상태에서 input에만 주입해 업로드가 무시되는 #19
 * 원인을 차단).
 * 2차 폴백: filechooser가 안 열리면 숨김 file input(존재 기반 탐색)에 직접 주입.
 *
 * URL 회수(이슈 #20 T1): 업로드 전후로 에디터 이미지 모듈의 src 목록을 비교해
 * 새로 생긴 src(= `postfiles.pstatic.net` URL)를 찾아 업로드 순서대로 로컬 경로에
 * 매핑한다. 이후 `rewriteLocalImageSrcs`가 그 URL을 본문 HTML의 원래 자리에 넣어
 * 붙여넣으므로 이미지가 섹션 사이 제자리에 들어간다(상단/끝 몰림 해소).
 *
 * 개별 이미지 실패는 errors에 기록하고 계속 진행한다(A3 폴백: 일부만 성공해도 유효).
 */
async function uploadNaverImages(
  page: Page,
  editor: Frame | undefined,
  images: string[],
): Promise<{ urlByPath: Map<string, string>; errors: string[] }> {
  const errors: string[] = [];
  const urlByPath = new Map<string, string>();
  let uploaded = 0;
  const valid = filterExistingImagePaths(images);
  if (valid.length === 0) return { urlByPath, errors: ['no existing local image files'] };

  /** 에디터 프레임의 이미지 모듈 src 목록(셀렉터가 겹치므로 중복 포함, 순서 유지). */
  const collectEditorImageSrcs = async (): Promise<string[]> => {
    const srcs: string[] = [];
    for (const frame of page.frames()) {
      for (const sel of IMAGE_MODULE_SELECTORS) {
        try {
          const loc = frame.locator(sel);
          const n = await loc.count();
          for (let i = 0; i < n; i += 1) {
            const src = await loc
              .nth(i)
              .getAttribute('src')
              .catch(() => null);
            if (src) srcs.push(src);
          }
        } catch {
          // detached frame — skip
        }
      }
    }
    return srcs;
  };

  /** 사진 버튼을 누르고 filechooser를 받아 파일을 넘긴다. 실패 시 false. */
  const uploadViaFilechooser = async (img: string): Promise<boolean> => {
    const button = await firstVisible(editor ?? page, IMAGE_TOOLBAR_SELECTORS, 2_000);
    if (!button) {
      logger.warn('Photo toolbar button not visible; skipping filechooser upload path');
      return false;
    }
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 }).catch(() => null);
    await clickDismissingPopups(page, button, 3_000).catch(() => {});
    const chooser = await chooserPromise;
    if (!chooser) {
      logger.warn(
        'filechooser did not open after photo button click; trying hidden input fallback',
      );
      return false;
    }
    await chooser.setFiles(img);
    return true;
  };

  const findFileInput = async (): Promise<Locator | null> => {
    // 이슈 #19: file input은 DOM에는 존재하지만 화면에 보이지 않는(hidden) 경우가
    // 대부분이다. isVisible 기반 firstVisible은 항상 실패하므로 존재(count>0)
    // 기준으로 찾아 setInputFiles에 넘긴다(숨김 input도 주입 가능).
    const scopes: Array<Page | Frame> = [page, ...page.frames()];
    for (const scope of scopes) {
      for (const sel of IMAGE_FILE_INPUT_SELECTORS) {
        const loc = scope.locator(sel).first();
        try {
          if ((await loc.count()) > 0) return loc;
        } catch {
          // detached frame — skip
        }
      }
    }
    return null;
  };

  for (const img of valid) {
    try {
      const before = await collectEditorImageSrcs();

      let injected = false;
      try {
        injected = await uploadViaFilechooser(img);
      } catch (error) {
        logger.warn(
          { error: String(error) },
          'filechooser upload path failed; trying hidden input',
        );
      }
      if (!injected) {
        // 폴백: 숨김 file input에 직접 주입(버튼이 안 눌리는 UI 변화 대비)
        const fileInput = await findFileInput();
        if (!fileInput) throw new Error('image file input not found');
        await fileInput.setInputFiles(img);
      }

      // URL 회수(이슈 #20 T1): 업로드 전후 src 목록을 비교해 새로 생긴 src를 찾는다.
      // SE가 로컬 파일을 `postfiles.pstatic.net` URL로 교체하므로 그 URL이 곧
      // 발행 가능한 주소다. 교체 직전에는 blob:/임시 src가 잠깐 보일 수 있어
      // postfiles URL이 나타날 때까지 폴링하고, 데드라인까지 안 나오면 그때까지
      // 새로 생긴 src 중 첫 번째로 최선 회수를 시도한다.
      const uploadDeadline = Date.now() + 20_000;
      let added: string[] = [];
      let url = '';
      for (;;) {
        added = diffNewImageSrcs(before, await collectEditorImageSrcs());
        const naver = added.find((src) => /postfiles\.pstatic\.net/i.test(src));
        if (naver) {
          url = naver;
          break;
        }
        if (Date.now() >= uploadDeadline) {
          url = added[0] ?? '';
          break;
        }
        await delay(500);
      }

      if (!url) {
        throw new Error(`image upload did not complete: ${path.basename(img)}`);
      }
      urlByPath.set(img, url);
      uploaded += 1;
      logger.info(
        { image: path.basename(img), uploaded, total: valid.length, url },
        'Editor image uploaded; Naver URL recovered',
      );

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
  return { urlByPath, errors };
}

/**
 * 업로드 전후 이미지 src 목록을 비교해 **새로 생긴** src를 순서대로 뽑는다.
 *
 * 셀렉터가 서로 겹쳐 같은 src가 목록에 여러 번 들어오므로 단순 Set 차집합으로는
 * "새로 생긴 1장"을 못 찾는다(중복 개수까지 봐야 한다). 그래서 다중집합(multiset)
 * 차집합을 계산한다. 순수 함수 — 유닛 테스트 대상.
 */
export function diffNewImageSrcs(before: string[], after: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const src of before) {
    remaining.set(src, (remaining.get(src) ?? 0) + 1);
  }
  const added: string[] = [];
  for (const src of after) {
    const left = remaining.get(src) ?? 0;
    if (left > 0) {
      remaining.set(src, left - 1);
      continue;
    }
    added.push(src);
  }
  return added;
}

/**
 * 에디터 본문을 비운다(이슈 #20 T1).
 *
 * upload-images는 URL 회수용으로 **빈 에디터**에서 먼저 실행되므로, 그 결과로
 * 본문에 남은 이미지 모듈들을 지워야 한다. 이후 paste가 본문 전체를 넣는다.
 *
 * 주의(이슈 #20 원인 A): SmartEditor ONE은 내부 모듈 모델을 직렬화해 발행한다.
 * 그래서 `innerHTML = ''` 같은 DOM-only 조작은 모델에 반영되지 않는다. 반드시
 * **실제 키 이벤트**(전체 선택 → Backspace)로 지워야 SE 모델에서도 사라진다.
 */
async function clearEditorBody(page: Page, editor: Frame | undefined): Promise<boolean> {
  const scope: Page | Frame = editor ?? page;
  const body = await firstVisible(scope, BODY_SELECTORS, 5_000).catch(() => null);
  if (!body) return false;

  await clickDismissingPopups(page, body, 5_000).catch(() => {});
  await page.waitForTimeout(200);

  // darwin은 Meta+A, 그 외는 Control+A — 플랫폼별 전체 선택 단축키.
  const selectAll = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';
  await page.keyboard.press(selectAll).catch(() => {});
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace').catch(() => {});
  await page.waitForTimeout(500);

  // 판정은 콘텐츠 모듈(.se-component)만 본다 — 캔버스 innerHTML에는 에디터 장식이
  // 늘 남아 있어 "안 비었다"로 오판하고, 그 오판이 본문을 지운 채 재붙여넣기를
  // 건너뛰게 만든다(2026-09-08 검증 발행에서 에디터가 통째로 비었다).
  const signals = await readEditorContentSignals(page, editor).catch(() => null);
  if (!signals) {
    // 못 읽은 것을 "비었다"로 오해하면 안 된다.
    logger.warn('Editor content signals not readable; clear could not be verified');
    return false;
  }
  if (!isEditorEmpty(signals)) {
    logger.warn(
      { signals },
      'Editor body still has content after clear; paste result may include leftovers',
    );
    return false;
  }
  return true;
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

// ---------------------------------------------------------------------------
// 로컬 이미지 src → 네이버 업로드 URL 치환 (이슈 #20 T1)
// ---------------------------------------------------------------------------

/**
 * 본문의 로컬 경로 `<img src>`를 네이버가 발급한 URL로 치환한다.
 *
 * 배경(이슈 #20 원인 A): SmartEditor ONE은 라이브 DOM이 아니라 내부 모듈 모델을
 * 직렬화해 발행한다. 그래서 "로컬 img를 ⟦IMGn⟧ 텍스트로 바꿔 두고 Selection으로
 * 커서를 옮겨 업로드한 뒤 플레이스홀더를 지운다"는 방식은 전부 DOM에서만 일어나
 * 모델에 반영되지 않았다 — 결과로 이미지는 SE가 기억하는 자리(첫 업로드=문서
 * 시작, 이후=문서 끝)에 몰리고 ⟦IMG0⟧ 텍스트가 발행물에 그대로 남았다.
 *
 * 대신 이미 검증된 경로를 쓴다: **먼저 업로드해 네이버 URL을 얻고**, 그 URL을
 * 본문 HTML의 원래 자리에 넣어 붙여넣는다. 붙여넣기 파이프라인은 원격 `<img>`를
 *原位에 `se-image` 모듈로 만든다는 것이 실발행물로 확인됐다.
 *
 * - 매칭은 basename 기준(역슬래시 정규화) — `output/images/a.png`와 절대경로가
 *   같은 파일을 가리킬 수 있다.
 * - 매핑이 없는 로컬 img는 제거하고 `unresolved`에 기록한다(발행물에 깨진
 *   이미지/로컬 경로가 절대 남지 않게).
 * - 같은 파일의 중복 참조는 첫 번째만 치환하고 나머지는 제거한다.
 * - `http(s)://`, 프로토콜 상대 `//`, `data:` src는 건드리지 않는다.
 *
 * 순수 함수 — 유닛 테스트 대상.
 */
export function rewriteLocalImageSrcs(
  html: string,
  urlByPath: Map<string, string>,
): { html: string; unresolved: string[] } {
  const unresolved: string[] = [];
  if (!html) return { html, unresolved };

  const basename = (p: string): string => p.replace(/\\/g, '/').split('/').pop() ?? p;
  const urlByBasename = new Map<string, string>();
  for (const [localPath, url] of urlByPath) {
    if (!url) continue;
    const key = basename(localPath);
    // 중복 basename이면 첫 번째 매핑만 쓴다(업로드 순서 우선).
    if (!urlByBasename.has(key)) urlByBasename.set(key, url);
  }

  const used = new Set<string>();
  const out = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag);
    const src = srcMatch?.[1] ?? '';
    // 원격/데이터 이미지는 이미 발행 가능한 상태다 — 그대로 둔다.
    if (/^(?:https?:)?\/\//i.test(src) || /^data:/i.test(src)) return tag;

    const key = basename(src);
    const url = urlByBasename.get(key);
    if (srcMatch && url && !used.has(key)) {
      used.add(key);
      // 함수형 치환: URL에 `$`가 섞여 있어도 치환 패턴으로 해석되지 않는다.
      return tag.replace(srcMatch[0], () => ` src="${url}"`);
    }
    // 매핑 없는 로컬 img / 중복 참조는 제거하고 사유를 남긴다.
    if (src && !unresolved.includes(src)) unresolved.push(src);
    return '';
  });
  return { html: out, unresolved };
}

// ---------------------------------------------------------------------------
// 붙여넣기 무결성 검증 (이슈 #15/#20 — SmartEditor paste 파이프라인이 링크/이미지
// 등 임베드 요소를 유실했는지 판정하는 순수 헬퍼)
//
// iframe은 기대값에 넣지 않는다. 네이버는 본문 iframe을 100% 제거하므로(이슈 #20
// 원인 B) 기대하면 정상 발행도 항상 실패로 판정되고, 그 실패가 파괴적 폴백을
// 트리거해 올바르게 붙여넣힌 본문을 망가뜨렸다.
// ---------------------------------------------------------------------------

export interface ElementCounts {
  expected: number;
  found: number;
}

export interface PasteIntegrity {
  links: ElementCounts;
  images: ElementCounts;
  /** 기대한 임베드 요소가 모두 살아있으면 true */
  ok: boolean;
}

/**
 * 본문 **텍스트 하이퍼링크** 수를 센다(이슈 #20 원인 E, 2026-09-08 실측 재작성).
 *
 * 같은 링크가 단계마다 전혀 다른 마크업으로 표현되므로 셋 다 받아들인다:
 *  - 붙여넣을 원본:  `<a href="https://…">텍스트</a>`
 *  - postwrite 에디터: `<span class="se-link __se-node" data-href="https://…">텍스트</span>`
 *    (에디터에는 `<a>`가 아예 없다 — 실측으로 앵커 0개를 확인했다. 이걸 모르고
 *    href만 세다가 "링크 0/14"라는 위양성이 나왔고, 그 오판이 재붙여넣기를 불러
 *    본문을 2배로 발행하거나 통째로 비웠다.)
 *  - 발행물:        `<a href="https://…" class="se-link" data-linkdata="{…}">텍스트</a>`
 *
 * 이미지만 감싼 앵커는 **세지 않는다**. SE는 그런 앵커를 이미지 모듈의 링크로
 * 흡수하거나(발행물) 아예 버리므로(표 컴포넌트) 텍스트 링크와 같은 잣대로 볼 수
 * 없다 — 이미지 쪽은 이미지 수로 따로 검증한다.
 */
function countHttpLinks(html: string): number {
  let count = 0;
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const [, attrs, inner] = match;
    const href = (/\shref\s*=\s*["']([^"']*)["']/i.exec(` ${attrs}`)?.[1] ?? '').trim();
    const hasUrl = /^https?:\/\//i.test(href) || hasSeLinkDataUrl(`<a ${attrs}>`);
    if (!hasUrl) continue;
    if (isImageOnly(inner)) continue;
    count += 1;
  }
  return count + countSeLinkSpans(html);
}

/** 앵커 내용이 이미지 하나뿐인지 — 이미지 링크는 링크 수가 아니라 이미지 수로 본다. */
function isImageOnly(inner: string): boolean {
  return /^\s*<img\b[^>]*\/?>\s*$/i.test(inner);
}

/** postwrite 에디터의 텍스트 링크(`<span data-href="http…">`) 수. */
function countSeLinkSpans(html: string): number {
  let count = 0;
  const re = /<(?!a[\s>])[a-z][a-z0-9-]*\b[^>]*\sdata-href\s*=\s*["']https?:\/\/[^"']*["'][^>]*>/gi;
  while (re.exec(html) !== null) count += 1;
  return count;
}

/** 앵커의 `data-linkdata`가 실제 http(s) 링크를 들고 있는지 (`&quot;` 이스케이프 허용). */
function hasSeLinkDataUrl(tag: string): boolean {
  const data = /\sdata-linkdata\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2] ?? '';
  if (!data) return false;
  return /(?:&quot;|")link(?:&quot;|")\s*:\s*(?:&quot;|")https?:\/\//i.test(data);
}

/** 무결성 진단용 — 결과 HTML의 링크 캐리어(앵커/`data-href` 스팬) 앞부분을 몇 개만 뽑는다. */
function sampleAnchorTags(html: string, limit = 3): string[] {
  const anchors = html.match(/<a\b[^>]*>/gi) ?? [];
  const spans = html.match(/<[a-z][a-z0-9-]*\b[^>]*\sdata-href\s*=\s*["'][^"']*["'][^>]*>/gi) ?? [];
  return [...anchors, ...spans].slice(0, limit).map((tag) => tag.slice(0, 220));
}

/** src를 가진 `<img>` 수를 센다(src 없는 img는 발행물에서 의미가 없다). */
function countImagesWithSrc(html: string): number {
  let count = 0;
  const tagRe = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const src = (/\ssrc\s*=\s*["']([^"']*)["']/i.exec(match[0])?.[1] ?? '').trim();
    if (src) count += 1;
  }
  return count;
}

/**
 * 붙여넣기 전 본문 HTML과 붙여넣은 뒤 에디터 본문에 실제 반영된 HTML을 비교해
 * 링크/이미지 유실을 판정한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 규칙: 원본(publishHtml)에 존재하는 각 요소 수만큼은 결과(pastedHtml)에도
 * 있어야 한다. found >= expected이면 ok. paste 파이프라인이 요소를 걸러내는
 * SmartEditor 정화(sanitization)를 탐지하는 용도다.
 */
export function verifyPastedContentIntegrity(
  publishHtml: string,
  pastedHtml: string,
): PasteIntegrity {
  const integrity: PasteIntegrity = {
    links: {
      expected: countHttpLinks(publishHtml),
      found: countHttpLinks(pastedHtml),
    },
    images: {
      expected: countImagesWithSrc(publishHtml),
      found: countImagesWithSrc(pastedHtml),
    },
    ok: true,
  };
  integrity.ok =
    integrity.links.found >= integrity.links.expected &&
    integrity.images.found >= integrity.images.expected;
  return integrity;
}

/** 붙여넣은 본문이 원본의 몇 배를 넘으면 중복으로 볼지 */
const DUPLICATE_TEXT_RATIO = 1.8;
/** 이 길이 미만의 짧은 본문은 비율 판정의 오차가 커서 중복 판정을 하지 않는다 */
const DUPLICATE_MIN_TEXT_LENGTH = 200;

/** 태그를 걷어낸 본문 텍스트 길이 — 중복 판정용. */
function visibleTextLength(html: string): number {
  return (html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

/**
 * 붙여넣기가 본문을 **중복 삽입**했는지 판정한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 배경(2026-09-07 실발행물 logNo 224404059950): 무결성 검증이 오판해 재붙여넣기를
 * 했는데, SmartEditor는 기존 본문을 지우지 않고 **덧붙인다**. 그 결과 컴포넌트
 * 30개짜리 글이 60개(= 정확히 2배)로 발행됐다. 재시도 전후로 이 판정을 걸어
 * 같은 사고가 조용히 반복되지 않게 한다.
 */
export function detectDuplicatedPaste(publishHtml: string, pastedHtml: string): boolean {
  const expected = visibleTextLength(publishHtml);
  if (expected < DUPLICATE_MIN_TEXT_LENGTH) return false;
  return visibleTextLength(pastedHtml) >= expected * DUPLICATE_TEXT_RATIO;
}

/** 재시도를 정당화하는 "붙여넣기가 사실상 실패했다"의 기준 */
const CATASTROPHIC_TEXT_RATIO = 0.5;

/**
 * 붙여넣기가 **사실상 실패**했는지 판정한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 재시도는 본문을 지우고 다시 붙이는 위험한 동작이다(2026-09-08 검증 발행에서
 * 이 경로가 에디터를 통째로 비웠다). 그래서 링크 개수 몇 개가 안 맞는 정도로는
 * 재시도하지 않는다 — 경고만 남기고 그대로 발행하는 편이 언제나 낫다.
 * 본문 텍스트가 절반도 안 들어갔거나 이미지가 통째로 빠진 경우에만 재시도한다.
 */
export function isPasteCatastrophic(
  publishHtml: string,
  pastedHtml: string,
  integrity: PasteIntegrity,
): boolean {
  const expected = visibleTextLength(publishHtml);
  if (expected > 0 && visibleTextLength(pastedHtml) < expected * CATASTROPHIC_TEXT_RATIO) {
    return true;
  }
  return integrity.images.expected > 0 && integrity.images.found === 0;
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
  /**
   * 외부 이미지(쿠팡 CDN 등)를 네이버에 업로드해 `blogfiles.pstatic.net`으로
   * 바꿔 발행할지. 기본 true — 핫링크로 두면 광고 차단 환경에서 네이버가
   * "존재하지 않는 이미지입니다."를 대신 넣는다(실측 224405221163).
   * false면 외부 주소를 그대로 발행한다(블로그 저장 용량을 쓰지 않는다).
   */
  rehostRemoteImages?: boolean;
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
  /** 이미지 업로드 실패 등 발행은 됐지만 누락된 요소 경고(이슈 #19) */
  warnings?: string[];
}

/**
 * 발행 직후 발행물을 읽어 합격 기준을 점검한다(T6).
 *
 * 이미 로그인된 브라우저 컨텍스트에서 읽으므로 **비공개 글도 검사된다**
 * (익명 PostView.naver 요청은 비공개 글의 본문을 돌려주지 않는다).
 * 어떤 실패에서도 던지지 않는다 — 발행은 이미 끝났고, 점검은 부가 정보다.
 */
async function inspectPublishedPost(
  context: { pages(): Page[] },
  postId: string,
): Promise<string[]> {
  try {
    const viewPage = context.pages().find((pg) => extractNaverPostId(pg.url()) === postId);
    if (!viewPage) return [];
    await viewPage.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    const published = await readEditorContentHtml(viewPage);
    if (!published) return [];
    const failures = collectPublishedPostFailures(published.html);
    if (failures.length > 0) {
      logger.warn({ postId, failures }, 'Published post failed the inspection checks');
    } else {
      logger.info({ postId }, 'Published post passed the inspection checks');
    }
    return failures;
  } catch (error) {
    logger.warn({ postId, error: String(error) }, 'Published post inspection skipped');
    return [];
  }
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
  // 외부 이미지를 내려받는 임시 디렉터리 — finally에서 지운다.
  let remoteImageDir = '';
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

    // Images (이슈 #20 T1) — 본문 입력 **이전**에 빈 에디터로 업로드한다.
    // 목적은 이미지 삽입이 아니라 네이버가 발급한 URL 회수이고, 직후 clear-editor가
    // 업로드 잔여물을 지운다. 회수한 URL은 본문 HTML의 원래 <img> 자리에 넣어
    // 붙여넣으므로 이미지가 섹션 사이 제자리에 들어간다(원인 A: 상단/끝 몰림 해소).
    const urlByPath = new Map<string, string>();
    const publishWarnings: string[] = [];

    // 외부 이미지(쿠팡 CDN 등)를 내려받아 로컬 이미지와 **같은 업로드 경로**에 태운다.
    // 핫링크로 발행하면 광고 차단기/DNS 필터가 이미지를 막는 순간 네이버가 그 자리에
    // "존재하지 않는 이미지입니다."를 넣는다(실측: 발행물 224405221163에서 쿠팡 CDN만
    // 차단하니 정확히 4회 노출). 상품 이미지가 깨지는 건 제휴 글에서 치명적이다.
    const rehostRemote = opts.rehostRemoteImages !== false;
    const remoteImageUrls = rehostRemote ? collectRemoteImageUrls(opts.html) : [];
    const localByRemote = new Map<string, string>();
    // 이미 올려 둔 이미지는 다시 올리지 않는다 — blogfiles URL은 글을 넘나들며
    // 재사용할 수 있음을 실측으로 확인했다(세션 없이 200, referer 제한 없음).
    const reusableFromCache = new Map<string, string>();
    if (remoteImageUrls.length > 0) {
      const picked = await pickReusableCachedImages(remoteImageUrls, loadRemoteImageCache()).catch(
        () => ({ reusable: new Map<string, string>(), missing: remoteImageUrls }),
      );
      for (const [url, naverUrl] of picked.reusable) reusableFromCache.set(url, naverUrl);

      if (picked.missing.length > 0) {
        remoteImageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'naver-remote-img-'));
        const downloaded = await downloadRemoteImages(picked.missing, remoteImageDir).catch(
          (error: unknown) => {
            logger.warn({ error: String(error) }, 'Remote image download failed');
            return { localByUrl: new Map<string, string>(), failures: [String(error)] };
          },
        );
        for (const [url, file] of downloaded.localByUrl) localByRemote.set(url, file);
      }
      logger.info(
        {
          found: remoteImageUrls.length,
          reusedFromCache: reusableFromCache.size,
          toUpload: localByRemote.size,
        },
        'Remote images resolved for Naver publishing',
      );
    }

    const uploadTargets = [...(opts.images ?? []), ...localByRemote.values()];
    if (filterExistingImagePaths(uploadTargets).length > 0) {
      await runStep(page, 'upload-images', async () => {
        const result = await uploadNaverImages(page!, editor, uploadTargets);
        for (const [localPath, url] of result.urlByPath) urlByPath.set(localPath, url);
        if (result.errors.length > 0) {
          logger.warn({ errors: result.errors }, 'Some Naver editor images failed to upload');
          // 발행 결과에 경고로 전달해 UI가 이미지 누락을 알 수 있게 한다(이슈 #19).
          publishWarnings.push(...result.errors);
        }
        logger.info(
          { resolved: result.urlByPath.size },
          'Naver editor image upload finished (URLs recovered for body rewrite)',
        );
      }).catch(async (error) => {
        // 업로드 실패는 발행을 막지 않는다 — 로컬 이미지만 본문에서 빠지고 계속 진행한다.
        logger.warn(
          { error: String(error) },
          'Image upload step failed; continuing publish without local images',
        );
        publishWarnings.push(`image upload step failed: ${String(error)}`);
        try {
          await page!.screenshot({ path: screenshotPath('upload-images-failed'), fullPage: true });
        } catch {
          // best-effort
        }
      });

      // 업로드로 본문에 남은 이미지 모듈을 지운다(이후 paste가 본문 전체를 넣는다).
      await runStep(page, 'clear-editor', async () => {
        const cleared = await clearEditorBody(page!, editor);
        if (!cleared) {
          logger.warn('Editor body not fully cleared before paste; leftovers may remain');
          publishWarnings.push('editor body not fully cleared before paste');
        }
      }).catch((error) => {
        logger.warn({ error: String(error) }, 'clear-editor step failed; continuing');
        publishWarnings.push(`clear-editor step failed: ${String(error)}`);
      });
    }

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

    // Body — prefer the HTML/source mode toggle, else paste into the rich editor.
    // 이슈 #20 T1: upload-images가 회수한 네이버 URL을 본문의 원래 <img> 자리에 넣어
    // 붙여넣는다. 매핑이 없는 로컬 이미지는 제거하고 unresolved에 기록해 발행물에
    // 로컬 경로/깨진 이미지가 절대 남지 않게 한다(stripLocalImageTags는 이중 안전망).
    // 외부 이미지를 네이버가 발급한 URL로 바꾼다. 업로드에 실패한 것은 원래 주소를
    // 그대로 둔다 — 이미지를 지우는 것보다 핫링크로라도 남기는 편이 낫다.
    const naverUrlByRemote = new Map<string, string>(reusableFromCache);
    const freshlyUploaded = new Map<string, string>();
    for (const [remoteUrl, localPath] of localByRemote) {
      const naverUrl = urlByPath.get(localPath);
      if (naverUrl) {
        naverUrlByRemote.set(remoteUrl, naverUrl);
        freshlyUploaded.set(remoteUrl, naverUrl);
      }
    }
    // 다음 글부터는 업로드 없이 이 URL을 그대로 쓴다.
    rememberRemoteImages(freshlyUploaded);
    const hostedHtml = replaceImageSrcs(opts.html, naverUrlByRemote);
    const stillRemote = remoteImageUrls.filter((url) => !naverUrlByRemote.has(url));
    if (stillRemote.length > 0) {
      logger.warn({ stillRemote }, 'Remote images published as hotlinks (upload failed)');
      publishWarnings.push(
        `외부 이미지 ${stillRemote.length}장을 네이버로 옮기지 못해 원래 주소로 발행했다 ` +
          `(광고 차단 환경에서 "존재하지 않는 이미지입니다"로 보일 수 있다)`,
      );
    }

    const rewritten = rewriteLocalImageSrcs(hostedHtml, urlByPath);
    if (rewritten.unresolved.length > 0) {
      logger.warn(
        { unresolved: rewritten.unresolved },
        'Local images without a recovered Naver URL were removed from the body',
      );
      publishWarnings.push(
        `이미지 ${rewritten.unresolved.length}장이 본문에서 제외됐다 (업로드 URL 회수 실패)`,
      );
    }
    const publishHtml = stripLocalImageTags(rewritten.html);
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
          await pasteHtmlIntoBuffer(buffer, publishHtml);
          // 붙여넣기 무결성 검증(이슈 #15/#20): SmartEditor paste 파이프라인이 링크 등
          // 임베드 요소를 정화해 버리면 광고·링크가 발행물에서 사라진다. 발행물에
          // 직렬화되는 바로 그 영역(.se-main-container)을 읽어 기대 요소 수와 비교한다.
          let pasted = await readSettledEditorHtml(page!, editor);
          if (!pasted) {
            // 못 읽었다면 **재시도하지 않는다**. 2026-09-07 발행 사고(logNo
            // 224404059950)는 읽기 실패를 "요소 유실"로 오판해 재붙여넣기를 했고,
            // SE가 본문을 덧붙여 글이 통째로 2번 발행됐다.
            logger.warn(
              'Editor content not readable after paste; skipping integrity check (no retry)',
            );
            publishWarnings.push('붙여넣기 결과를 읽지 못해 무결성 검증을 건너뛰었다');
          } else {
            logger.info(
              { frame: pasted.frame, selector: pasted.selector, length: pasted.html.length },
              'Editor content read for paste integrity check',
            );
            let integrity = verifyPastedContentIntegrity(publishHtml, pasted.html);
            let duplicated = detectDuplicatedPaste(publishHtml, pasted.html);

            // 재시도는 본문을 지우고 다시 붙이는 위험한 동작이므로, 링크 개수가
            // 조금 안 맞는 정도로는 하지 않는다 — 경고만 남기고 그대로 발행한다.
            if (duplicated || isPasteCatastrophic(publishHtml, pasted.html, integrity)) {
              logger.warn(
                { integrity, duplicated },
                'Paste result is unusable; clearing the editor before one retry',
              );
              const cleared = await clearEditorBody(page!, editor);
              // 비워졌을 때만 다시 붙인다(안 비운 채 붙이면 본문이 2배가 된다).
              // 다만 "비우지 못했다"고 판정됐어도 실제로는 비어 있을 수 있으므로
              // 신호를 한 번 더 확인한다 — 지워 놓고 안 붙이면 빈 글이 발행된다.
              const empty = cleared || isEditorEmpty(await readEditorContentSignals(page!, editor));
              if (empty) {
                await pasteHtmlIntoBuffer(buffer, publishHtml);
                const retried = await readSettledEditorHtml(page!, editor);
                if (retried) {
                  pasted = retried;
                  integrity = verifyPastedContentIntegrity(publishHtml, retried.html);
                  duplicated = detectDuplicatedPaste(publishHtml, retried.html);
                }
              } else {
                logger.warn(
                  'Editor could not be cleared; skipping the retry to avoid duplicating the body',
                );
                publishWarnings.push('에디터를 비우지 못해 붙여넣기 재시도를 생략했다');
              }
            }

            if (duplicated) {
              logger.error({ integrity }, 'Editor body looks duplicated; publishing as-is');
              publishWarnings.push('본문이 중복 삽입된 것으로 보인다 — 발행물을 확인하라');
            }
            if (!integrity.ok) {
              if (integrity.links.found < integrity.links.expected) {
                // 에디터가 링크를 어떤 마크업으로 들고 있는지 남긴다 — 집계 규칙을
                // 추측이 아니라 실제 발행 로그로 맞추기 위한 진단이다.
                logger.warn(
                  { anchors: sampleAnchorTags(pasted.html) },
                  'Editor anchors sampled for link-count diagnosis',
                );
              }
              // 그래도 부족하면 본문을 망가뜨리지 않고 그대로 발행하되 경고로 알린다.
              const detail =
                `붙여넣기 무결성 부족 — 링크 ${integrity.links.found}/${integrity.links.expected}, ` +
                `이미지 ${integrity.images.found}/${integrity.images.expected}`;
              logger.warn({ integrity }, 'Paste still short of expectations; publishing as-is');
              publishWarnings.push(detail);
            }
          }
          bodyFilled = true;
        }
        if (!bodyFilled) {
          // input_buffer 프레임이 없는 구형 에디터: 본문 contenteditable에 paste
          // 이벤트를 직접 던진다. innerHTML 직접 주입은 SE 모델에 반영되지 않고
          // 기존 본문을 파괴하므로 쓰지 않는다(이슈 #20 원인 A).
          await body.evaluate((el, html) => {
            interface PasteTarget {
              dispatchEvent(event: unknown): boolean;
            }
            const g = globalThis as unknown as BufferFrameGlobals;
            const dt = new g.DataTransfer();
            dt.setData('text/html', html);
            const host = el as unknown as PasteTarget;
            host.dispatchEvent(
              new g.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
            );
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

    // 이미지 업로드는 본문 입력 **이전**에 끝났다(이슈 #20 T1). 여기 있던
    // "본문 입력 후 업로드" 블록은 삭제했다 — SE 모델에 커서를 옮길 수 없어
    // 이미지가 본문 앞/끝에 몰렸고(원인 A), 회수 URL을 본문에 되돌리는 방식이
    // 그 문제를 근본적으로 해소한다.

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

    // 발행물 자동 점검(T6) — 로그인된 브라우저로 읽으므로 비공개 글도 검사할 수 있다.
    // 점검 실패는 발행을 실패로 만들지 않는다(경고로만 올린다).
    publishWarnings.push(...(await inspectPublishedPost(context, postId)));
    // 이슈 #19/#20 — 이미지 업로드 실패, 미해결 로컬 이미지, 붙여넣기 무결성
    // 부족 등 "발행은 됐지만 누락이 있다"는 사실을 UI에 경고로 전달한다.
    return publishWarnings.length > 0
      ? { postId, url, warnings: publishWarnings }
      : { postId, url };
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
    if (remoteImageDir) {
      try {
        fs.rmSync(remoteImageDir, { recursive: true, force: true });
      } catch {
        // 임시 파일 정리는 best-effort
      }
    }
  }
}
