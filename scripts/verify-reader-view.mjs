/* eslint-disable no-console -- 진단용 CLI 스크립트 */
/**
 * 발행물 독자 시점 검증(이슈 #25).
 *
 * 왜 필요한가: `scripts/inspect-published-post.mjs`는 발행물 HTML을 **텍스트로만**
 * 판정한다(렌더링 없음, 이미지 요청 없음, 링크 추적 없음). 이 스크립트는 같은 글을
 * 익명 독자 브라우저로 열어 "실제로 보이는 것"을 검사한다:
 *   - 깨진 이미지(naturalWidth 0 / 비-2xx 응답 / text/html 응답)와 아직 안 뜬 이미지
 *   - 죽은 링크(#, 상대경로). SmartEditor ONE은 모든 이미지를 <a href="#">로 감싸므로
 *     이미지 래퍼의 실제 목적지는 `data-linkdata`의 `link` 필드로만 판정한다
 *   - 잘린 표/가로 스크롤, 컴포넌트 블록 중복, 이미지 placeholder 문구
 *   - (--links) 본문 링크 목적지를 실제로 따라가 응답/최종 URL/제목 확인 + 본문 이미지 재요청
 *   - (--compliance <draftDir>) 초안 HTML 대비 본문 유실, 금지 문구, 태그 누락 확인
 *   - (--anon) 비로그인 열람 가능 여부(쿠키·로그인 월)
 *
 * 안전 규칙:
 *   - Chromium은 레포 자체 의존성(node_modules/playwright)을 쓴다. 절대경로 하드코딩 없음.
 *   - 항상 **익명 임시 컨텍스트**(userDataDir/storageState 없음)로 연다. 운영 서버가 쓰는
 *     `data/browser-profiles/naver` 프로필은 절대 열지 않는다(동시 사용 시 세션 파손).
 *   - 읽기 전용: GET만 한다. 산출물(스크린샷/이미지 사본)은 --out 디렉터리에만 쓴다.
 *
 * usage:
 *   node scripts/verify-reader-view.mjs <logNo> [blogId] [--out <dir>] [--json]
 *   node scripts/verify-reader-view.mjs --selftest
 *   node scripts/verify-reader-view.mjs <logNo> [blogId] --links
 *   node scripts/verify-reader-view.mjs <logNo> [blogId] --compliance <draftDir>
 *   node scripts/verify-reader-view.mjs <logNo> [blogId] --anon
 *
 * blogId 생략 시 env BLOG_POSTER_PLATFORM_NAVER_BLOG_ID → config/*.yaml
 * (platforms.naver.blogId) 순으로 해석한다(inspect-published-post.mjs와 동일).
 * 위치 인자는 순서를 가리지 않는다 — logNo는 숫자, blogId는 숫자가 아니다.
 *
 * 종료 코드: 0 통과 / 1 실패 / 2 하네스 오류(인자·의존성·네트워크).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT_DIR = path.join(REPO_ROOT, '.cache', 'reader-verify');

// vp별 후보 URL(데스크톱은 blog.naver.com → PostView.naver, 모바일은 m.blog.naver.com).
const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S911N) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Mobile Safari/537.36';

const CONTAINER_SELECTORS = [
  '.se-main-container',
  '.se-viewer .se-main-container',
  '#postViewArea',
  '.se2_container',
];
const PLACEHOLDER_TEXT = '존재하지 않는 이미지입니다';

const BODY_WAIT_MS = 15_000;
const NAV_TIMEOUT_MS = 45_000;
const IMAGE_SETTLE_MS = 8_000;
const AUTH_COOKIE_RE = /NID_AUT|NID_SES|NID_JST/i;

// --compliance 금지 문구: 1인칭 체험 주장과 미이행 약속(파트너스 고지 문구는 여기 없음 —
// 그쪽은 inspect-published-post.mjs의 고지 카운트가 담당한다).
const BANNED_PHRASES = [
  '제가 직접',
  '제가',
  '저는',
  '내돈내산',
  '써봤',
  '입어봤',
  '향후 구현',
  '구현 예정',
];
// 참고용(판정 아님): 파트너스 고지 어휘가 실제로 몇 번 나오는지 센다.
const DISCLOSURE_PHRASES = ['쿠팡', '파트너스'];

// ---------------------------------------------------------------- dependencies

function resolveRepoModule(name) {
  const require = createRequire(path.join(REPO_ROOT, 'package.json'));
  const candidates = [
    process.env.REPO_ROOT ? path.join(process.env.REPO_ROOT, 'node_modules', name) : null,
    path.join(REPO_ROOT, 'node_modules', name),
    path.join(process.cwd(), 'node_modules', name),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return require(candidate);
  }
  return require(name); // 레포 밖에서 실행해도 node 해석에 맡긴다
}

function loadChromium() {
  const playwright = resolveRepoModule('playwright');
  if (!playwright?.chromium) {
    throw new Error(
      `playwright를 찾지 못했다(REPO_ROOT=${REPO_ROOT}). npm install 후 다시 실행하라.`,
    );
  }
  return playwright.chromium;
}

/** 운영 서버가 쓰는 실제 네이버 프로필을 실수로라도 열지 않는다. */
function assertEphemeralProfile() {
  for (const key of ['PLAYWRIGHT_USER_DATA_DIR', 'NAVER_PROFILE_DIR', 'NAVER_BROWSER_PROFILE']) {
    if (process.env[key]?.includes('browser-profiles')) {
      throw new Error(
        `refusing to run: ${key}=${process.env[key]} points at the repo's browser profile`,
      );
    }
  }
}

/** config/*.yaml 에서 platforms.naver.blogId를 찾는다(스크립트 단독 실행용). */
function resolveBlogIdFromConfig() {
  const env = process.env.NODE_ENV || 'development';
  const candidates = [
    path.resolve(`config/${env}.yaml`),
    path.resolve('config/secrets.yaml'),
    path.resolve('config/default.yaml'),
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const doc = yaml.load(readFileSync(file, 'utf-8'));
      const blogId = doc?.platforms?.naver?.blogId;
      if (blogId) return String(blogId);
    } catch {
      // 깨진 yaml은 건너뛴다 — 다음 후보로
    }
  }
  return '';
}

// ------------------------------------------------------------------- helpers

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function isBadImageResponse(r, isBodyImage = true) {
  // Browser-cancelled (navigation/scroll cancellation): the DOM naturalWidth check
  // is what decides whether the reader lost an image, so this is not a defect.
  if (r.failed === 'net::ERR_ABORTED') return false;
  if (r.failed) return true;
  // No response and no failure: a post-body image that never arrived is a blank box
  // for the reader (defect); page-chrome leftovers from the navigation dance are not.
  if (r.status === null || r.status === undefined) return isBodyImage;
  if (r.status < 200 || r.status >= 300) return true;
  return /text\/html/i.test(r.mimeType || '');
}

async function waitForContainer(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const frame of page.frames()) {
      for (const sel of CONTAINER_SELECTORS) {
        const handle = await frame.$(sel).catch(() => null);
        if (handle) return { frame, selector: sel };
      }
    }
    if (Date.now() > deadline) return null;
    await page.waitForTimeout(250);
  }
}

async function probeUrl(page, url) {
  const entry = {
    url,
    status: null,
    finalUrl: null,
    containerSelector: null,
    frameUrl: null,
    title: null,
    error: null,
  };
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    entry.status = resp ? resp.status() : null;
    entry.finalUrl = page.url();
    entry.title = await page.title().catch(() => null);
    const found = await waitForContainer(page, BODY_WAIT_MS);
    entry.containerSelector = found ? found.selector : null;
    entry.frameUrl = found ? found.frame.url() : null;
  } catch (e) {
    entry.error = String(e.message || e);
  }
  return entry;
}

/** Scroll through the whole page so Naver's lazy images actually request. */
async function autoScroll(page) {
  await page.evaluate(async () => {
    const step = Math.max(300, Math.floor(window.innerHeight * 0.8));
    const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
    for (let y = 0; y < max; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo(0, max);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 200));
  });
}

async function waitForImages(frame) {
  const deadline = Date.now() + IMAGE_SETTLE_MS;
  for (;;) {
    const pending = await frame
      .evaluate((sels) => {
        const imgs = sels.flatMap((s) => Array.from(document.querySelectorAll(`${s} img`)));
        return imgs.filter((i) => !i.complete).length;
      }, CONTAINER_SELECTORS)
      .catch(() => 0);
    if (pending === 0 || Date.now() > deadline) return pending;
    await frame.page().waitForTimeout(250);
  }
}

/** CDP capture of every image request/response, with true transferred bytes. */
async function attachImageCapture(cdp) {
  await cdp.send('Network.enable');
  let byRequestId = new Map();
  const looksLikeImage = (url, type, mime) =>
    type === 'Image' ||
    (mime || '').startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)(\?|#|$)/i.test(url || '');
  // Record at request time too: a connection-refused/DNS-failed image never emits
  // a responseReceived event, and a harness that only listens for responses would
  // silently drop it.
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!looksLikeImage(e.request?.url, e.type, '')) return;
    byRequestId.set(e.requestId, {
      url: e.request.url,
      status: null,
      mimeType: '',
      contentLengthHeader: null,
      fromDiskCache: false,
      fromServiceWorker: false,
      encodedBytes: null,
      failed: null,
      requestedAt: Date.now(),
    });
  });
  cdp.on('Network.responseReceived', (e) => {
    const mime = e.response.mimeType || '';
    if (!looksLikeImage(e.response.url, e.type, mime)) return;
    const prev = byRequestId.get(e.requestId);
    byRequestId.set(e.requestId, {
      url: e.response.url,
      status: e.response.status,
      mimeType: mime,
      contentLengthHeader: e.response.headers?.['content-length'] ?? null,
      fromDiskCache: !!e.response.fromDiskCache,
      fromServiceWorker: !!e.response.fromServiceWorker,
      encodedBytes: e.response.encodedDataLength ?? prev?.encodedBytes ?? null,
      failed: prev?.failed ?? null,
      requestedAt: prev?.requestedAt ?? Date.now(),
    });
  });
  cdp.on('Network.loadingFinished', (e) => {
    const rec = byRequestId.get(e.requestId);
    if (rec) rec.encodedBytes = e.encodedDataLength;
  });
  cdp.on('Network.loadingFailed', (e) => {
    const rec = byRequestId.get(e.requestId);
    if (rec) rec.failed = e.errorText || 'loadingFailed';
    else
      byRequestId.set(e.requestId, {
        url: '(unknown image url)',
        status: null,
        mimeType: '',
        contentLengthHeader: null,
        fromDiskCache: false,
        fromServiceWorker: false,
        encodedBytes: null,
        failed: e.errorText || 'loadingFailed',
        requestedAt: Date.now(),
      });
  });
  return {
    imageResponses: () => Array.from(byRequestId.values()).sort((a, b) => (a.url < b.url ? -1 : 1)),
    // Navigating between probe URLs cancels in-flight requests and leaves records
    // that never resolve; only the final rendered page is evidence.
    reset: () => {
      byRequestId = new Map();
    },
  };
}

// ------------------------------------------------------------ DOM extraction

/**
 * Runs inside the page; must stay dependency-free and serialisable.
 * `__se_image_link` wrappers are resolved through data-linkdata.link (see header).
 */
function collectDom(placeholderText) {
  const doc = document;
  let container = null;
  let containerSelector = null;
  for (const sel of [
    '.se-main-container',
    '.se-viewer .se-main-container',
    '#postViewArea',
    '.se2_container',
  ]) {
    const el = doc.querySelector(sel);
    if (el) {
      container = el;
      containerSelector = sel;
      break;
    }
  }
  if (!container) return { containerFound: false };

  const text = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  const absRe = /^(https?:|mailto:|tel:|sms:)/i;

  const linkFromLinkData = (raw) => {
    if (!raw) return null;
    const decoded = raw.replace(/&quot;/g, '"');
    const m = /"link"\s*:\s*"([^"]*)"/i.exec(decoded);
    return m ? m[1] : null;
  };
  const isImageWrapper = (a) =>
    a.classList.contains('__se_image_link') ||
    a.classList.contains('se-module-image-link') ||
    (a.hasAttribute('data-linkdata') && a.querySelector('img') !== null);

  // ---- components in DOM order
  const components = Array.from(container.querySelectorAll('.se-component')).map((el, i) => {
    const classes = Array.from(el.classList);
    const type =
      classes.find((c) =>
        /^se-(text|image|imageGroup|video|quotation|table|horizontalLine|link|oglink|code|material|map|file|place|button|stitch|chart|mention|emoji|audio)$/.test(
          c,
        ),
      ) ||
      classes
        .filter((c) => c.startsWith('se-') && c !== 'se-component' && !/^se-[ld]-/.test(c))
        .join('.') ||
      'unknown';
    const imgs = Array.from(el.querySelectorAll('img')).map((img) => ({
      src: img.currentSrc || img.getAttribute('src') || '',
      lazy: img.getAttribute('data-lazy-src') || img.getAttribute('data-src') || null,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
      alt: img.getAttribute('alt') || '',
    }));
    const t = text(el);
    return {
      index: i,
      type,
      componentId: el.getAttribute('data-component-id') || null,
      textLength: t.length,
      text: t.slice(0, 120),
      fullText: t,
      imageCount: imgs.length,
      images: imgs,
    };
  });
  const sequence = components.map((c) => c.fullText);
  const componentTypes = components.map((c) => c.type);

  // ---- images that actually rendered
  const images = Array.from(container.querySelectorAll('img')).map((img, i) => {
    const r = img.getBoundingClientRect();
    return {
      index: i,
      src: img.currentSrc || img.getAttribute('src') || '',
      lazy: img.getAttribute('data-lazy-src') || img.getAttribute('data-src') || null,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      complete: img.complete,
      renderedWidth: Math.round(r.width),
      renderedHeight: Math.round(r.height),
      hidden: r.width === 0 && r.height === 0,
      alt: img.getAttribute('alt') || '',
    };
  });
  const brokenImages = images.filter(
    (i) => !i.hidden && i.src && i.complete && i.naturalWidth === 0,
  );

  // ---- anchors (post links + SE image wrappers resolved via data-linkdata)
  const anchors = Array.from(container.querySelectorAll('a')).map((a) => {
    const rawHref = a.getAttribute('href');
    const rawTrim = (rawHref || '').trim();
    const wrapper = isImageWrapper(a);
    const linkDataLink = wrapper ? linkFromLinkData(a.getAttribute('data-linkdata')) : null;
    const effective = wrapper ? (linkDataLink || '').trim() : rawTrim;
    const empty = effective === '' || effective === '#' || /^javascript:/i.test(effective);
    const relative = !empty && !absRe.test(effective);
    return {
      href: rawHref,
      resolved: a.href || null,
      imageWrapper: wrapper,
      linkDataLink,
      effective,
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      empty,
      relative,
      unfilled: wrapper && empty, // SE wrapper with no destination: an unlinked image, not a defect
    };
  });
  const badAnchors = anchors.filter((a) => !a.unfilled && (a.empty || a.relative));
  const contentLinks = anchors.filter((a) => !a.imageWrapper && !a.empty);
  const imageLinks = anchors
    .filter((a) => a.imageWrapper)
    .map((a) => ({ effective: a.effective, text: a.text }));

  // ---- placeholder text
  const containerText = text(container);
  const pageText = text(doc.body);
  const placeholderHits = {
    inContainer: containerText.includes(placeholderText),
    inDocument: pageText.includes(placeholderText),
  };

  // ---- duplication: the same sequence of component texts, twice
  // A single component can repeat (same paragraph pasted twice), so w starts at 1;
  // the >=40-char rule keeps short legit repeats (labels, "구매하기") out.
  const duplicates = [];
  const n = sequence.length;
  const seen = new Set();
  outer: for (let w = 1; w <= Math.min(8, Math.floor(n / 2)); w++) {
    for (let i = 0; i + w <= n; i++) {
      for (let j = i + w; j + w <= n; j++) {
        let same = true;
        let len = 0;
        for (let k = 0; k < w; k++) {
          const a = sequence[i + k];
          const b = sequence[j + k];
          if (a === '' && b === '') continue; // empty components match trivially
          if (a !== b) {
            same = false;
            break;
          }
          len += a.length;
        }
        if (same && len >= 40) {
          const key = `${i}-${j}-${w}`;
          if (seen.has(key)) continue;
          seen.add(key);
          duplicates.push({
            windowSize: w,
            firstRange: [i, i + w - 1],
            secondRange: [j, j + w - 1],
            types: componentTypes.slice(i, i + w),
            sample: sequence.slice(i, i + w).map((s) => s.slice(0, 80)),
            repeatedTextLength: len,
          });
          if (duplicates.length >= 5) break outer;
        }
      }
    }
    if (duplicates.length) break; // smallest repeating window wins
  }

  // ---- overflow / clipping
  const containerClientWidth = container.clientWidth;
  const overflowing = [];
  for (const el of [
    container,
    ...Array.from(container.querySelectorAll('table, figure, div, img, iframe')),
  ]) {
    const scrollOver = el.scrollWidth - el.clientWidth;
    const wider = Math.round(el.getBoundingClientRect().width) - containerClientWidth;
    if ((scrollOver > 1 || wider > 1) && overflowing.length < 25) {
      overflowing.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 80),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollOverflowPx: scrollOver,
        widerThanContainerPx: wider,
        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    }
  }
  const tables = Array.from(container.querySelectorAll('table')).map((t, i) => {
    const r = t.getBoundingClientRect();
    return {
      index: i,
      scrollWidth: t.scrollWidth,
      clientWidth: t.clientWidth,
      renderedWidth: Math.round(r.width),
      containerClientWidth,
      clipped: t.scrollWidth - t.clientWidth > 1 || Math.round(r.width) - containerClientWidth > 1,
      text: (t.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
  });

  return {
    containerFound: true,
    containerSelector,
    containerClientWidth,
    title: doc.title,
    bodyText: containerText,
    bodyTextLength: containerText.length,
    documentTextLength: pageText.length,
    componentCount: components.length,
    components,
    sequence,
    images,
    brokenImages,
    anchors,
    badAnchors,
    contentLinks,
    imageLinks,
    anchorsOutsideContainer: doc.querySelectorAll('a').length - anchors.length,
    placeholderHits,
    duplicates,
    overflowing,
    tables,
    clippedTables: tables.filter((t) => t.clipped),
    pageHorizontalOverflow:
      doc.documentElement.scrollWidth - window.innerWidth > 1
        ? { scrollWidth: doc.documentElement.scrollWidth, innerWidth: window.innerWidth }
        : null,
    loginWall: new RegExp('로그인이 필요|로그인 후 이용|본인인증이 필요|nidlogin').test(
      pageText + ' ' + location.href,
    ),
  };
}

// ------------------------------------------------------------------- verdict

/** Single source of truth for pass/fail — used by both the live run and the self-test. */
function evaluateVerdict({ documentStatus, dom, badImageResponses }) {
  const failures = [];
  if (documentStatus !== 200) failures.push(`document status ${documentStatus} (expected 200)`);
  if (!dom.containerFound) {
    failures.push(`post body container not found (tried ${CONTAINER_SELECTORS.join(', ')})`);
    return failures; // nothing else is meaningful without the body
  }
  if (dom.brokenImages.length)
    failures.push(`${dom.brokenImages.length} broken image(s) in body (naturalWidth 0)`);
  const non2xx = badImageResponses.filter((r) => r.failed || r.status < 200 || r.status >= 300);
  const htmlImages = badImageResponses.filter((r) => /text\/html/i.test(r.mimeType || ''));
  if (non2xx.length) failures.push(`${non2xx.length} non-2xx/failed image response(s)`);
  if (htmlImages.length)
    failures.push(`${htmlImages.length} image response(s) served as text/html`);
  if (dom.placeholderHits.inContainer || dom.placeholderHits.inDocument)
    failures.push(`broken-image placeholder text "${PLACEHOLDER_TEXT}" present`);
  if (dom.badAnchors.length)
    failures.push(`${dom.badAnchors.length} empty/#/relative anchor(s) in body`);
  if (dom.duplicates.length) {
    const d = dom.duplicates[0];
    failures.push(
      `duplicated component block (${d.windowSize} component(s), indices ${d.firstRange.join('-')} == ${d.secondRange.join('-')})`,
    );
  }
  if (dom.clippedTables.length)
    failures.push(`${dom.clippedTables.length} clipped/overflowing table(s)`);
  if (dom.pageHorizontalOverflow)
    failures.push(
      `page scrolls horizontally (${dom.pageHorizontalOverflow.scrollWidth}px > ${dom.pageHorizontalOverflow.innerWidth}px)`,
    );
  return failures;
}

/**
 * On desktop blog.naver.com the post lives in <iframe id="mainFrame"> sized to the
 * viewport, and the post scrolls INSIDE it (frame content 9317px vs 900px viewport),
 * so a plain fullPage screenshot of the outer document is exactly one screen tall and
 * shows nothing but the top of the post. Expand the frame first, then capture.
 */
async function captureFullPage(page, frame, screenshotPath) {
  const hasFrame = frame && page.mainFrame() !== frame;
  if (hasFrame) {
    try {
      const contentHeight = await frame.evaluate(() => document.documentElement.scrollHeight);
      const expanded = await page.evaluate((h) => {
        const f =
          document.querySelector('iframe#mainFrame') ||
          Array.from(document.querySelectorAll('iframe')).find((x) =>
            (x.src || '').includes('PostView.naver'),
          );
        if (!f) return false;
        f.style.height = `${h}px`;
        f.setAttribute('height', String(h));
        let p = f.parentElement;
        let depth = 0;
        while (p && depth < 6) {
          p.style.height = 'auto';
          p.style.overflow = 'visible';
          p = p.parentElement;
          depth++;
        }
        document.body.style.height = 'auto';
        document.body.style.overflow = 'visible';
        document.documentElement.style.height = 'auto';
        return true;
      }, contentHeight);
      if (expanded) {
        await page.waitForTimeout(600);
        await page.screenshot({ path: screenshotPath, fullPage: true });
        return {
          screenshotMode: 'page-fullpage (frame expanded to full post height)',
          contentHeight,
        };
      }
      throw new Error('no iframe to expand');
    } catch {
      const handle = await frame.$('.se-main-container').catch(() => null);
      if (handle) {
        await handle.screenshot({ path: screenshotPath }).catch(() => {});
        return { screenshotMode: 'body-element (frame expansion failed)', contentHeight: null };
      }
    }
  }
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  return { screenshotMode: 'page-fullpage', contentHeight: null };
}

/** Bytes actually served for an image: CDP encodedDataLength, else the content-length header. */
function withTransferBytes(records) {
  return records.map((r) => {
    const inline = /^(data|blob):/i.test(r.url) || r.url === '(unknown image url)';
    const cl =
      r.contentLengthHeader != null && r.contentLengthHeader !== ''
        ? Number(r.contentLengthHeader)
        : null;
    const encoded =
      typeof r.encodedBytes === 'number' && r.encodedBytes > 0 ? r.encodedBytes : null;
    const bytesTransferred = inline
      ? null
      : (encoded ?? (Number.isFinite(cl) && cl > 0 ? cl : null));
    return {
      ...r,
      inline,
      bytesTransferred,
      bytesSource: inline
        ? 'inline'
        : encoded != null
          ? 'cdp-encoded'
          : bytesTransferred != null
            ? 'content-length'
            : 'unknown',
    };
  });
}

// -------------------------------------------------------------- page inspection

const VIEWPORTS = [
  {
    name: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    userAgent: undefined,
    isMobile: false,
    hasTouch: false,
  },
  {
    name: 'mobile',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    userAgent: MOBILE_UA,
    isMobile: true,
    hasTouch: true,
  },
];

const probeUrlsFor = (view, blogId, logNo) =>
  view.name === 'mobile'
    ? [`https://m.blog.naver.com/${blogId}/${logNo}`, `https://blog.naver.com/${blogId}/${logNo}`]
    : [
        `https://blog.naver.com/${blogId}/${logNo}`,
        `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(blogId)}&logNo=${encodeURIComponent(logNo)}`,
      ];

/**
 * 익명 컨텍스트 하나로 후보 URL을 프로브하고 최종 페이지의 DOM/이미지/앵커를 수집한다.
 * 반환된 context/page/frame은 호출자가 추가 검사(--links 등)에 쓰고 닫는다.
 */
async function inspectViewport(browser, { blogId, logNo, view, outDir, screenshot = true }) {
  const desktopUrl = `https://blog.naver.com/${blogId}/${logNo}`;
  const mobileUrl = `https://m.blog.naver.com/${blogId}/${logNo}`;
  const probes = probeUrlsFor(view, blogId, logNo);

  // Fresh ephemeral context per viewport: no storageState, no userDataDir, no cookies.
  const context = await browser.newContext({
    viewport: view.viewport,
    deviceScaleFactor: view.deviceScaleFactor,
    userAgent: view.userAgent,
    isMobile: view.isMobile,
    hasTouch: view.hasTouch,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8' },
  });
  const page = await context.newPage();

  const cdp = await context.newCDPSession(page);
  const { imageResponses, reset: resetImageCapture } = await attachImageCapture(cdp);

  const pageErrors = [];
  const documentResponses = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message || e).slice(0, 200)));
  page.on('response', (r) => {
    if (r.request().resourceType() === 'document')
      documentResponses.push(`${r.status()} ${r.url().slice(0, 140)}`);
  });
  page.on('requestfailed', (r) => {
    if (r.resourceType() === 'image')
      pageErrors.push(`image request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`);
  });

  const cookiesBefore = (await context.cookies()).map((c) => c.name);

  const attempts = [];
  let chosen = null;
  for (const url of probes) {
    const attempt = await probeUrl(page, url);
    attempts.push(attempt);
    if (attempt.status === 200 && attempt.containerSelector && !chosen) chosen = attempt;
  }
  if (!chosen) chosen = attempts.find((a) => a.status === 200) || attempts[0];

  // Only the traffic of the final rendered page counts as evidence.
  resetImageCapture();
  const finalResp = await page
    .goto(chosen.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })
    .catch(() => null);
  const documentStatus = finalResp ? finalResp.status() : null;
  const finalUrl = page.url();
  const pageTitle = await page.title().catch(() => null);
  const found = await waitForContainer(page, BODY_WAIT_MS);

  let dom = {
    containerFound: false,
    badAnchors: [],
    brokenImages: [],
    duplicates: [],
    clippedTables: [],
    tables: [],
    components: [],
    images: [],
    anchors: [],
    contentLinks: [],
    imageLinks: [],
    placeholderHits: {},
    bodyText: '',
    pageHorizontalOverflow: null,
    loginWall: false,
  };
  let pendingImages = null;
  if (found) {
    await autoScroll(page).catch(() => {});
    pendingImages = await waitForImages(found.frame);
    dom = await found.frame.evaluate(collectDom, PLACEHOLDER_TEXT).catch((e) => ({
      containerFound: false,
      error: String(e.message || e),
      badAnchors: [],
      brokenImages: [],
      duplicates: [],
      clippedTables: [],
      tables: [],
      components: [],
      images: [],
      anchors: [],
      contentLinks: [],
      imageLinks: [],
      placeholderHits: {},
      bodyText: '',
      pageHorizontalOverflow: null,
      loginWall: false,
    }));
  }

  let screenshotPath = null;
  let screenshotMode = null;
  let contentHeight = null;
  if (screenshot) {
    screenshotPath = path.join(outDir, `${logNo}-${view.name}.png`);
    ({ screenshotMode, contentHeight } = await captureFullPage(
      page,
      found ? found.frame : null,
      screenshotPath,
    ));
  }

  const allImageResponses = withTransferBytes(imageResponses());
  // Body image URLs come from the DOM (and their lazy-load attributes); anything
  // else is Naver page chrome, which the reader does not associate with the post.
  const bodySrcs = new Set();
  for (const im of dom.images ?? []) {
    if (im.src) bodySrcs.add(im.src);
    if (im.lazy) bodySrcs.add(im.lazy);
  }
  const isBodyImage = (r) => bodySrcs.has(r.url) || bodySrcs.has(r.url.split('?')[0]);
  const abortedImageResponses = allImageResponses.filter((r) => r.failed === 'net::ERR_ABORTED');
  const badImageResponses = allImageResponses.filter((r) => isBadImageResponse(r, isBodyImage(r)));
  const failures = evaluateVerdict({ documentStatus, dom, badImageResponses });
  const cookiesAfter = (await context.cookies()).map((c) => c.name);

  const result = {
    viewport: `${view.viewport.width}x${view.viewport.height}`,
    deviceScaleFactor: view.deviceScaleFactor,
    userAgent: view.userAgent ?? 'chromium-default',
    desktopUrl,
    mobileUrl,
    urlAttempts: attempts,
    chosenUrl: chosen.url,
    documentStatus,
    finalUrl,
    pageTitle,
    bodyContainerFound: !!dom.containerFound,
    bodyContainerSelector: dom.containerSelector ?? null,
    bodyTextLength: dom.bodyTextLength ?? 0,
    componentCount: dom.componentCount ?? 0,
    pendingImagesAtSettle: pendingImages,
    imageResponses: allImageResponses,
    badImageResponses,
    abortedImageResponses,
    brokenImages: dom.brokenImages ?? [],
    placeholderHits: dom.placeholderHits ?? null,
    anchors: dom.anchors ?? [],
    badAnchors: dom.badAnchors ?? [],
    contentLinks: dom.contentLinks ?? [],
    imageLinks: dom.imageLinks ?? [],
    anchorsOutsideContainer: dom.anchorsOutsideContainer ?? null,
    duplicates: dom.duplicates ?? [],
    overflowing: dom.overflowing ?? [],
    clippedTables: dom.clippedTables ?? [],
    tables: dom.tables ?? [],
    pageHorizontalOverflow: dom.pageHorizontalOverflow ?? null,
    components: dom.components ?? [],
    pageErrors,
    documentResponses,
    anonymity: {
      cookiesBefore,
      cookiesAfter,
      authCookies: [...new Set([...cookiesBefore, ...cookiesAfter])].filter((n) =>
        AUTH_COOKIE_RE.test(n),
      ),
      loginWall: !!dom.loginWall,
    },
    screenshot: screenshotPath,
    screenshotMode,
    frameContentHeight: contentHeight,
    failures,
  };

  return { result, context, page, frame: found ? found.frame : null, dom };
}

// ------------------------------------------------------------------ reporting

const brief = (r) => ({
  chosenUrl: r.chosenUrl,
  status: r.documentStatus,
  container: r.bodyContainerSelector,
  bodyTextLength: r.bodyTextLength,
  components: r.componentCount,
  imageResponses: r.imageResponses.length,
  badImages: r.badImageResponses.length,
  abortedImages: r.abortedImageResponses.length,
  brokenImages: r.brokenImages.length,
  anchors: r.anchors.length,
  badAnchors: r.badAnchors.length,
  contentLinks: r.contentLinks.length,
  imageLinks: r.imageLinks.length,
  placeholders: r.placeholderHits,
  duplicates: r.duplicates.length,
  clippedTables: r.clippedTables.length,
  pageHScroll: !!r.pageHorizontalOverflow,
  screenshot: r.screenshot,
  screenshotMode: r.screenshotMode,
  anonymity: r.anonymity,
  failures: r.failures,
});

function printViewport(name, r) {
  const probe = r.urlAttempts.find((a) => a.url === r.chosenUrl);
  console.log(`\n=== ${name.toUpperCase()} — ${r.viewport} (dsf=${r.deviceScaleFactor}) ===`);
  console.log(`chosen URL      : ${r.chosenUrl}`);
  console.log(`final URL       : ${r.finalUrl}`);
  console.log(`document status : ${r.documentStatus}`);
  console.log(`page title      : ${clip(norm(r.pageTitle), 120)}`);
  console.log(`body container  : ${r.bodyContainerFound ? r.bodyContainerSelector : 'NOT FOUND'}`);
  console.log(
    `body text length: ${r.bodyTextLength} chars over ${r.componentCount} se-component blocks`,
  );
  console.log(
    `url probes      : ${r.urlAttempts.map((a) => `${a.url} -> status=${a.status} container=${a.containerSelector ?? 'none'}`).join(' | ')}`,
  );
  console.log(
    `images (network): ${r.imageResponses.length} image requests, ${r.badImageResponses.length} bad, ${r.abortedImageResponses.length} browser-cancelled, ${r.brokenImages.length} broken in DOM, ${r.pendingImagesAtSettle} still loading`,
  );
  console.log(
    `anchors         : ${r.anchors.length} in body, ${r.badAnchors.length} bad, ${r.contentLinks.length} content links, ${r.imageLinks.length} image links (${r.imageLinks.filter((l) => l.effective).length} carrying a destination)`,
  );
  console.log(
    `placeholder text: inContainer=${r.placeholderHits?.inContainer} inDocument=${r.placeholderHits?.inDocument}`,
  );
  console.log(
    `duplication     : ${r.duplicates.length ? JSON.stringify(r.duplicates[0]) : 'none'}`,
  );
  console.log(
    `overflow        : tables=${r.tables.length} clipped=${r.clippedTables.length} pageHScroll=${r.pageHorizontalOverflow ? 'YES' : 'no'} suspiciousElements=${r.overflowing.length}`,
  );
  console.log(
    `anonymity       : cookies=[${r.anonymity.cookiesAfter.join(',')}] auth=[${r.anonymity.authCookies.join(',')}] loginWall=${r.anonymity.loginWall}`,
  );
  console.log(
    `screenshot      : ${r.screenshot}  [${r.screenshotMode}${r.frameContentHeight ? `, post height ${r.frameContentHeight}px` : ''}]`,
  );
  if (probe?.frameUrl && probe.frameUrl !== probe.finalUrl)
    console.log(`(body lives in frame: ${probe.frameUrl})`);
  console.log('components:');
  for (const c of r.components) {
    console.log(
      `  [${String(c.index).padStart(2)}] ${c.type.padEnd(16)} len=${String(c.textLength).padStart(4)} imgs=${c.imageCount} ${clip(norm(c.text), 70)}`,
    );
  }
  if (r.badImageResponses.length) {
    console.log('bad image responses:');
    for (const b of r.badImageResponses)
      console.log(
        `  ${b.failed ? `ERR(${b.failed})` : b.status === null ? 'PENDING' : b.status} ${b.mimeType} bytes=${b.bytesTransferred ?? '?'}(${b.bytesSource}) ${clip(b.url, 100)}`,
      );
  }
  if (r.brokenImages.length) {
    console.log('broken images (naturalWidth=0):');
    for (const b of r.brokenImages)
      console.log(`  ${clip(b.src, 110)} (rendered ${b.renderedWidth}x${b.renderedHeight})`);
  }
  if (r.badAnchors.length) {
    console.log('bad anchors:');
    for (const a of r.badAnchors)
      console.log(
        `  effective=${JSON.stringify(a.effective)} href=${JSON.stringify(a.href)} imageWrapper=${a.imageWrapper} text=${JSON.stringify(clip(a.text, 50))}`,
      );
  }
  console.log(`verdict         : ${r.failures.length ? `FAIL (${r.failures.length})` : 'PASS'}`);
  for (const f of r.failures) console.log(`  - ${f}`);
}

// --------------------------------------------------------------- mode: reader

async function runReaderView(blogId, logNo, { outDir, json }) {
  assertEphemeralProfile();
  const chromium = loadChromium();
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = {};
  for (const view of VIEWPORTS) {
    const { result, context } = await inspectViewport(browser, { blogId, logNo, view, outDir });
    results[view.name] = result;
    await context.close();
  }
  await browser.close();

  if (json) {
    const summary = {
      blogId,
      logNo,
      generatedAt: new Date().toISOString(),
      overallVerdict: Object.values(results).some((r) => r.failures.length) ? 'FAIL' : 'PASS',
      desktop: brief(results.desktop),
      mobile: brief(results.mobile),
      details: results,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  for (const name of ['desktop', 'mobile']) printViewport(name, results[name]);

  const summary = {
    blogId,
    logNo,
    generatedAt: new Date().toISOString(),
    overallVerdict: Object.values(results).some((r) => r.failures.length) ? 'FAIL' : 'PASS',
    desktop: brief(results.desktop),
    mobile: brief(results.mobile),
    details: results,
  };
  console.log('\n--- JSON SUMMARY ---');
  console.log(JSON.stringify(summary));
  return summary;
}

// ---------------------------------------------------------- mode: link/anon

/** 본문 콘텐츠 링크를 실제로 따라가 응답/최종 URL/제목을 기록한다. */
async function runLinks(blogId, logNo, { outDir }) {
  assertEphemeralProfile();
  const chromium = loadChromium();
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const view = VIEWPORTS[0];
  const { result, context, page, dom } = await inspectViewport(browser, {
    blogId,
    logNo,
    view,
    outDir,
  });

  const links = [];
  const seen = new Set();
  for (const a of dom.contentLinks ?? []) {
    if (!/^https?:\/\//i.test(a.effective) || seen.has(a.effective)) continue;
    seen.add(a.effective);
    links.push({ label: a.text, url: a.effective });
  }

  const failures = [];
  if (!dom.containerFound) failures.push('post body container not found — link list unavailable');
  if (links.length === 0) failures.push('no absolute content links found in the body');

  console.log(`[links] body content links: ${links.length}`);
  for (const link of links) {
    const chain = [];
    page.removeAllListeners('response');
    page.on('response', (r) => {
      if (r.request().resourceType() === 'document')
        chain.push(`${r.status()} ${r.url().slice(0, 130)}`);
    });
    let status = null;
    let error = null;
    try {
      const resp = await page.goto(link.url, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      status = resp ? resp.status() : null;
      await page.waitForTimeout(1000);
    } catch (e) {
      error = String(e.message || e).split('\n')[0];
    }
    const finalUrl = page.url();
    const title = await page.title().catch(() => null);
    const ok = !error && status != null && status >= 200 && status < 300;
    if (!ok)
      failures.push(`link not reachable: ${link.url} (status=${status ?? 'none'} ${error ?? ''})`);
    console.log(`\n[${clip(norm(link.label), 40) || '(no text)'}]`);
    console.log(`  requested : ${link.url}`);
    console.log(`  final URL : ${finalUrl}`);
    console.log(`  status    : ${status}${error ? ` (${error})` : ''}`);
    console.log(`  title     : ${clip(norm(title), 130)}`);
    console.log(`  doc chain : ${chain.join(' -> ')}`);
  }

  // 본문 이미지: 리더 브라우저와 별개로 순수 HTTP 재요청이 아직 200/이미지인지 확인한다.
  const imageUrls = [];
  const seenImages = new Set();
  for (const im of dom.images ?? []) {
    if (!im.src || im.naturalWidth <= 0 || seenImages.has(im.src)) continue;
    seenImages.add(im.src);
    imageUrls.push(im.src);
  }
  console.log(`\n[links] body images to re-fetch: ${imageUrls.length}`);
  let savedImage = null;
  for (const url of imageUrls) {
    const resp = await context.request.get(url, { timeout: 30_000 }).catch((e) => ({ error: e }));
    const status = resp.error ? null : resp.status();
    const mime = resp.error ? null : resp.headers()['content-type'] || '';
    const body = resp.error ? null : await resp.body().catch(() => null);
    const ok = !resp.error && status >= 200 && status < 300 && /^image\//i.test(mime || '');
    if (!ok)
      failures.push(
        `body image not fetchable: ${url} (status=${status ?? 'none'} mime=${mime ?? 'none'})`,
      );
    console.log(
      `  ${status ?? 'ERR'} ${mime ?? '-'} ${body ? body.byteLength : 0} bytes ${clip(url, 110)}`,
    );
    if (ok && !savedImage && body) {
      const ext = (mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      savedImage = path.join(outDir, `${logNo}-body-image.${ext}`);
      writeFileSync(savedImage, body);
    }
  }
  if (savedImage) console.log(`saved body image: ${savedImage}`);

  await context.close();
  await browser.close();

  console.log('\n--- JSON SUMMARY ---');
  console.log(
    JSON.stringify({
      blogId,
      logNo,
      mode: 'links',
      overallVerdict: failures.length ? 'FAIL' : 'PASS',
      documentStatus: result.documentStatus,
      links: links.map((l) => l.url),
      bodyImages: imageUrls,
      savedImage,
      failures,
    }),
  );
  return { failures };
}

/** 익명 컨텍스트가 로그인 쿠키나 로그인 월을 만나지 않는지(=누구나 읽을 수 있는지) 확인한다. */
async function runAnon(blogId, logNo, { outDir }) {
  assertEphemeralProfile();
  const chromium = loadChromium();
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const view = VIEWPORTS[0];
  const { result, context, frame } = await inspectViewport(browser, {
    blogId,
    logNo,
    view,
    outDir,
    screenshot: false,
  });

  const failures = [];
  if (result.documentStatus !== 200) failures.push(`document status ${result.documentStatus}`);
  if (!result.bodyContainerFound) failures.push('body container not found while anonymous');
  if (result.anonymity.cookiesBefore.length > 0)
    failures.push(`cookies present before navigation: ${result.anonymity.cookiesBefore.join(',')}`);
  if (result.anonymity.authCookies.length > 0)
    failures.push(`login cookies present: ${result.anonymity.authCookies.join(',')}`);
  const frameLoginWall = frame
    ? await frame
        .evaluate(() =>
          /로그인이 필요|로그인 후 이용|본인인증이 필요|nidlogin/.test(
            document.body.innerText + ' ' + location.href,
          ),
        )
        .catch(() => false)
    : false;
  if (result.anonymity.loginWall || frameLoginWall) failures.push('login wall text present');

  console.log(`[anon] chosen URL    : ${result.chosenUrl}`);
  console.log(`[anon] final URL     : ${result.finalUrl}`);
  console.log(`[anon] cookies before: ${JSON.stringify(result.anonymity.cookiesBefore)}`);
  console.log(`[anon] cookies after : ${JSON.stringify(result.anonymity.cookiesAfter)}`);
  console.log(`[anon] auth cookies  : ${JSON.stringify(result.anonymity.authCookies)}`);
  console.log(`[anon] login wall    : outer=${result.anonymity.loginWall} frame=${frameLoginWall}`);
  console.log(
    `[anon] body          : ${result.bodyContainerFound ? result.bodyContainerSelector : 'NOT FOUND'} (${result.bodyTextLength} chars)`,
  );
  console.log('[anon] document responses:');
  for (const d of result.documentResponses) console.log(`   ${d}`);

  await context.close();
  await browser.close();

  console.log(`\nverdict: ${failures.length ? 'FAIL' : 'PASS'}`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('\n--- JSON SUMMARY ---');
  console.log(
    JSON.stringify({
      blogId,
      logNo,
      mode: 'anon',
      overallVerdict: failures.length ? 'FAIL' : 'PASS',
      anonymity: result.anonymity,
      frameLoginWall,
      documentResponses: result.documentResponses,
      failures,
    }),
  );
  return { failures };
}

// --------------------------------------------------------- mode: compliance

/** 초안 HTML의 최상위 래퍼(`*-wrap`)를 찾는다. 없으면 body. */
function findDraftRoot($) {
  let root = null;
  $('*').each((_, el) => {
    if (root) return;
    const classes = (el.attribs?.class || '').split(/\s+/);
    if (classes.some((c) => /^[a-z]+-wrap$/.test(c))) root = $(el);
  });
  return root || $('body');
}

/**
 * 초안(post.html) 대비 발행물 본문의 유실/중복/금지 문구/태그를 검사한다.
 * 판정(exit 1) 기준: 초안 블록 유실, 금지 문구 노출, meta.json 태그 누락.
 * 재정렬·추가 블록은 정보로만 보고한다(위젯 확장 등 정상 변형이 섞인다).
 */
async function runCompliance(draftDir, blogId, logNo, { outDir }) {
  assertEphemeralProfile();
  const cheerio = resolveRepoModule('cheerio');
  const draftHtmlPath = path.join(draftDir, 'post.html');
  const draftMetaPath = path.join(draftDir, 'meta.json');
  if (!existsSync(draftHtmlPath)) {
    throw new Error(`초안을 찾지 못했다: ${draftHtmlPath} (--compliance <draftDir> 인자 확인)`);
  }
  const draftHtml = readFileSync(draftHtmlPath, 'utf-8');
  let draftMeta = null;
  if (existsSync(draftMetaPath)) {
    try {
      draftMeta = JSON.parse(readFileSync(draftMetaPath, 'utf-8'));
    } catch {
      draftMeta = null;
    }
  }

  const chromium = loadChromium();
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const view = VIEWPORTS[0];
  const { result, context, frame, dom } = await inspectViewport(browser, {
    blogId,
    logNo,
    view,
    outDir,
    screenshot: false,
  });

  const $ = cheerio.load(draftHtml);
  const root = findDraftRoot($);
  const sourceText = norm(root.text());
  const sourceBlocks = [];
  root.find('*').each((_, el) => {
    const n = $(el);
    const tag = el.tagName?.toLowerCase();
    if (tag === 'style' || tag === 'script') return;
    const ownText = norm(
      n
        .contents()
        .filter((__, c) => c.type === 'text')
        .map((__, c) => c.data)
        .get()
        .join(' '),
    );
    if (ownText)
      sourceBlocks.push({ tag, cls: (n.attr('class') || '').slice(0, 40), text: ownText });
  });
  const sourceSections = [];
  root.children().each((_, el) => {
    const t = norm($(el).text());
    if (t) sourceSections.push({ cls: ($(el).attr('class') || '').slice(0, 40), chars: t.length });
  });

  const renderedTexts = (dom.components ?? []).map((c) => c.fullText || '');
  const liveBodyText = dom.bodyText || '';
  const key60 = (s) => norm(s).slice(0, 60);

  const mapped = sourceBlocks.map((b) => {
    const key = key60(b.text);
    const hits = renderedTexts.map((t, i) => (t.includes(key) ? i : -1)).filter((i) => i >= 0);
    return { ...b, key, hits, inBody: liveBodyText.includes(key) };
  });
  const missing = mapped.filter((m) => !m.inBody);
  const duplicated = mapped.filter((m) => m.hits.length > 1);
  const matchedIdx = mapped.filter((m) => m.inBody).map((m) => Math.min(...m.hits));
  const reorder = [];
  for (let i = 1; i < matchedIdx.length; i++) {
    if (matchedIdx[i] < matchedIdx[i - 1])
      reorder.push(
        `source#${i - 1}->component${matchedIdx[i - 1]} then source#${i}->component${matchedIdx[i]}`,
      );
  }
  const extra = (dom.components ?? [])
    .filter((c) => norm(c.fullText || '') !== '' && !sourceText.includes(key60(c.fullText)))
    .map((c) => `component[${c.index}] ${c.type} :: ${key60(c.fullText)}`);

  const scan = (phrases) =>
    Object.fromEntries(
      phrases.map((p) => [
        p,
        { rendered: liveBodyText.split(p).length - 1, source: sourceText.split(p).length - 1 },
      ]),
    );
  const banned = scan(BANNED_PHRASES);
  const disclosure = scan(DISCLOSURE_PHRASES);
  const bannedPresent = Object.entries(banned).filter(([, v]) => v.rendered > 0);

  // 태그: 초안 meta.json의 태그가 발행물 태그 영역에 실제로 있는지.
  // 네이버는 `#태그` 형태로 렌더하고 태그 영역을 게시 시점 이후에 채우므로,
  // leading '#'를 떼고 `tagList_<logNo>` 컨테이너를 기준으로 잠시 기다린다.
  const expectedTags = Array.isArray(draftMeta?.tags) ? draftMeta.tags.map(String) : [];
  let liveTags = { anchors: [], containers: [] };
  if (frame && expectedTags.length > 0) {
    liveTags = await frame
      .evaluate(async (tags) => {
        const stripHash = (s) => (s || '').replace(/^#/, '').replace(/\s+/g, ' ').trim();
        const collect = () => {
          const scopeEls = [
            document.querySelector('[id^="tagList_"]'),
            document.querySelector('.wrap_tag'),
          ].filter(Boolean);
          const roots = scopeEls.length ? scopeEls : [document];
          const found = [];
          for (const root of roots) {
            for (const a of root.querySelectorAll('a')) {
              const t = stripHash(a.textContent);
              if (t && !found.includes(t) && (tags.includes(t) || /PostListByTagName/.test(a.href)))
                found.push(t);
            }
          }
          return found;
        };
        let anchors = collect();
        const deadline = Date.now() + 5_000;
        while (anchors.length === 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 250));
          anchors = collect();
        }
        const containers = [];
        for (const sel of [
          '.wrap_tag',
          '.blog_tag',
          '.post_tag',
          '.tag_area',
          '#tagList',
          '[id^="tagList_"]',
        ]) {
          for (const el of document.querySelectorAll(sel)) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 300) containers.push({ sel, text: t.slice(0, 140) });
          }
        }
        return { anchors, containers: containers.slice(0, 6) };
      }, expectedTags)
      .catch(() => ({ anchors: [], containers: [] }));
  }
  const missingTags = expectedTags.filter((t) => !liveTags.anchors.includes(t));

  const failures = [];
  if (!dom.containerFound) failures.push('post body container not found');
  if (missing.length) failures.push(`${missing.length} source block(s) missing from the live body`);
  if (bannedPresent.length)
    failures.push(`banned phrase(s) in live body: ${bannedPresent.map(([p]) => p).join(', ')}`);
  if (missingTags.length)
    failures.push(`draft tag(s) missing in live post: ${missingTags.join(', ')}`);

  console.log(`[compliance] draft      : ${draftHtmlPath}`);
  console.log(`[compliance] live       : ${result.chosenUrl} (status ${result.documentStatus})`);
  console.log(
    `[compliance] source     : ${sourceBlocks.length} leaf blocks, ${sourceSections.length} top sections, ${sourceText.length} chars`,
  );
  console.log(
    `[compliance] rendered   : ${renderedTexts.length} components, ${liveBodyText.length} chars`,
  );
  console.log(
    `[compliance] parity     : matched=${matchedIdx.length} missing=${missing.length} duplicatedBlocks=${duplicated.length} reordered=${reorder.length} extraInLive=${extra.length}`,
  );
  for (const m of missing) console.log(`  MISSING [${m.tag}.${m.cls}] ${m.key}`);
  for (const m of duplicated)
    console.log(`  DUPLICATED [${m.tag}.${m.cls}] components ${m.hits.join(',')} :: ${m.key}`);
  for (const r of reorder) console.log(`  REORDER ${r}`);
  for (const e of extra) console.log(`  EXTRA ${e}`);
  console.log('[compliance] banned phrases (rendered/source):');
  for (const [p, v] of Object.entries(banned))
    console.log(`  ${v.rendered > 0 ? 'HIT ' : 'ok  '} ${p}: ${v.rendered}/${v.source}`);
  console.log('[compliance] disclosure vocabulary (rendered/source, 정보):');
  for (const [p, v] of Object.entries(disclosure)) console.log(`  ${p}: ${v.rendered}/${v.source}`);
  console.log(
    `[compliance] tags         : expected=[${expectedTags.join(',')}] live=[${liveTags.anchors.join(',')}] missing=[${missingTags.join(',')}]`,
  );
  if (liveTags.containers.length)
    console.log(
      `[compliance] tag areas    : ${liveTags.containers.map((c) => `${c.sel}:${clip(c.text, 40)}`).join(' | ')}`,
    );
  console.log(`verdict: ${failures.length ? 'FAIL' : 'PASS'}`);
  for (const f of failures) console.log(`  - ${f}`);

  await context.close();
  await browser.close();

  console.log('\n--- JSON SUMMARY ---');
  console.log(
    JSON.stringify({
      blogId,
      logNo,
      mode: 'compliance',
      draftDir,
      overallVerdict: failures.length ? 'FAIL' : 'PASS',
      source: {
        leafBlocks: sourceBlocks.length,
        sections: sourceSections.length,
        chars: sourceText.length,
      },
      rendered: { components: renderedTexts.length, chars: liveBodyText.length },
      parity: {
        matched: matchedIdx.length,
        missing: missing.map((m) => `${m.tag}.${m.cls} :: ${m.key}`),
        duplicated: duplicated.map((m) => `${m.key} @ ${m.hits.join(',')}`),
        reordered: reorder,
        extraInLive: extra,
      },
      banned: Object.fromEntries(bannedPresent),
      disclosure,
      tags: { expected: expectedTags, live: liveTags.anchors, missing: missingTags },
      failures,
    }),
  );
  return { failures };
}

// ----------------------------------------------------------------- self-test

const FIXTURE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>fixture</title>
<style>body{margin:0}#wrap{width:600px}</style></head><body><div id="wrap"><div class="se-main-container">
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>정상 링크 <a href="https://example.com/good">확인</a></p></div></div>
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>빈 링크 <a href="#">여기</a></p></div></div>
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>상대 링크 <a href="/relative/path">저기</a></p></div></div>
  <div class="se-component se-image se-l-default"><div class="se-component-content"><div class="se-section se-section-image"><div class="se-module se-module-image">
    <a href="#" class="se-module-image-link __se_image_link __se_link" onclick="return false;" data-linkdata="{&quot;id&quot;:&quot;SE-1&quot;,&quot;linkUse&quot;:false,&quot;link&quot;:&quot;&quot;}"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40"></a>
  </div></div></div></div>
  <div class="se-component se-image se-l-default"><div class="se-component-content"><div class="se-section se-section-image"><div class="se-module se-module-image">
    <a href="#" class="se-module-image-link __se_image_link __se_link" onclick="return false;" data-linkdata="{&quot;id&quot;:&quot;SE-2&quot;,&quot;linkUse&quot;:true,&quot;link&quot;:&quot;https://link.coupang.com/a/ABC123&quot;}"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40"></a>
  </div></div></div></div>
  <div class="se-component se-image se-l-default"><div class="se-component-content"><div class="se-section se-section-image"><div class="se-module se-module-image">
    <a href="#" class="se-module-image-link __se_image_link __se_link" onclick="return false;" data-linkdata="{&quot;id&quot;:&quot;SE-3&quot;,&quot;linkUse&quot;:true,&quot;link&quot;:&quot;/relative-image-target&quot;}"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40"></a>
  </div></div></div></div>
  <div class="se-component se-image se-l-default"><div class="se-component-content"><div class="se-section se-section-image"><div class="se-module se-module-image">
    <img src="http://127.0.0.1:9/broken.png" width="40" height="40" alt="깨진 이미지">
  </div></div></div></div>
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>중복 블록 검출용 문장입니다. 이 문장은 두 번 연속으로 나타나므로 하네스가 중복을 보고해야 합니다.</p></div></div>
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>중복 블록 검출용 문장입니다. 이 문장은 두 번 연속으로 나타나므로 하네스가 중복을 보고해야 합니다.</p></div></div>
  <div class="se-component se-table se-l-default"><div class="se-component-content"><div class="se-section se-section-table"><div class="se-table-container">
    <table class="se-table-content" style="width:1000px"><tbody><tr><td>넓은 표 셀</td><td>넓은 표 셀 2</td></tr></tbody></table>
  </div></div></div></div>
  <div class="se-component se-text se-l-default"><div class="se-component-content"><p>이미지 영역: 존재하지 않는 이미지입니다</p></div></div>
</div></div></body></html>`;

async function runSelfTest() {
  const chromium = loadChromium();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const { imageResponses } = await attachImageCapture(cdp);
  await page.setContent(FIXTURE, { waitUntil: 'load' });
  await page.waitForTimeout(1500);

  const dom = await page.evaluate(collectDom, PLACEHOLDER_TEXT);
  const allImg = imageResponses();
  const badImg = allImg.filter(isBadImageResponse);
  const failures = evaluateVerdict({ documentStatus: 200, dom, badImageResponses: badImg });

  const checks = [];
  const check = (name, cond, detail) => checks.push({ name, ok: !!cond, detail });
  const badTexts = dom.badAnchors.map((a) => a.effective).sort();

  check('components enumerated in order', dom.componentCount === 11, `count=${dom.componentCount}`);
  check(
    'types parsed',
    dom.components[9].type === 'se-table' && dom.components[0].type === 'se-text',
    dom.components.map((c) => c.type).join(','),
  );
  check(
    'bad anchors = exactly the 3 real ones (empty href, relative href, relative image linkdata)',
    JSON.stringify(badTexts) ===
      JSON.stringify(['#', '/relative-image-target', '/relative/path'].sort()),
    JSON.stringify(badTexts),
  );
  check(
    'unlinked image wrapper NOT flagged',
    !dom.badAnchors.some((a) => a.imageWrapper && a.linkDataLink === ''),
    JSON.stringify(dom.badAnchors),
  );
  check(
    'image wrapper with absolute linkdata link NOT flagged',
    !dom.badAnchors.some((a) => a.linkDataLink === 'https://link.coupang.com/a/ABC123'),
    '',
  );
  check(
    'image links extracted from data-linkdata',
    dom.imageLinks.filter((l) => l.effective).length === 2,
    JSON.stringify(dom.imageLinks),
  );
  check(
    'content links (non-wrapper, non-empty href) = 2 (good + relative)',
    dom.contentLinks.length === 2,
    JSON.stringify(dom.contentLinks.map((a) => a.effective)),
  );
  check(
    'broken image detected (naturalWidth 0)',
    dom.brokenImages.length === 1,
    JSON.stringify(dom.brokenImages.map((b) => b.src)),
  );
  check(
    'failed image response captured over CDP',
    badImg.some((r) => r.failed || r.status === null || r.status >= 400),
    JSON.stringify(badImg.map((r) => `${r.status} ${r.failed} ${r.url}`)),
  );
  check(
    'placeholder text detected',
    dom.placeholderHits.inContainer === true,
    JSON.stringify(dom.placeholderHits),
  );
  check(
    'duplicate block detected as a 1-component repeat at [7] == [8]',
    dom.duplicates.length >= 1 &&
      dom.duplicates[0].windowSize === 1 &&
      dom.duplicates[0].firstRange[0] === 7 &&
      dom.duplicates[0].firstRange[1] === 7 &&
      dom.duplicates[0].secondRange[0] === 8 &&
      dom.duplicates[0].secondRange[1] === 8,
    JSON.stringify(dom.duplicates),
  );
  check('clipped table detected', dom.clippedTables.length === 1, JSON.stringify(dom.tables));
  check(
    'no page-level horizontal scroll in fixture',
    dom.pageHorizontalOverflow === null,
    JSON.stringify(dom.pageHorizontalOverflow),
  );
  check(
    'verdict lists all 6 expected failure classes',
    failures.length === 6 &&
      failures.some((f) => f.includes('broken image')) &&
      failures.some((f) => f.includes('non-2xx')) &&
      failures.some((f) => f.includes('placeholder')) &&
      failures.some((f) => f.includes('anchor')) &&
      failures.some((f) => f.includes('duplicated')) &&
      failures.some((f) => f.includes('clipped')),
    JSON.stringify(failures, null, 1),
  );

  console.log('SELF-TEST');
  for (const c of checks)
    console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `  -> ${c.detail}`}`);
  const failed = checks.filter((c) => !c.ok);
  console.log(`  => ${failed.length ? `${failed.length} CHECK(S) FAILED` : 'ALL CHECKS PASSED'}`);
  console.log('\n--- JSON SUMMARY ---');
  console.log(JSON.stringify({ selftest: true, failures, checks }));
  await browser.close();
  return { failures: failed };
}

// ---------------------------------------------------------------------- cli

const USAGE = [
  'usage:',
  '  node scripts/verify-reader-view.mjs <logNo> [blogId] [--out <dir>] [--json]',
  '  node scripts/verify-reader-view.mjs --selftest',
  '  node scripts/verify-reader-view.mjs <logNo> [blogId] --links',
  '  node scripts/verify-reader-view.mjs <logNo> [blogId] --compliance <draftDir>',
  '  node scripts/verify-reader-view.mjs <logNo> [blogId] --anon',
].join('\n');

function parseArgs(argv) {
  const flags = {
    selftest: false,
    links: false,
    anon: false,
    json: false,
    help: false,
    compliance: null,
    out: DEFAULT_OUT_DIR,
  };
  const positional = [];
  const consumed = []; // 플래그가 값을 먹은 경우 그 값을 위치 인자 후보에서 제외한다
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--selftest') flags.selftest = true;
    else if (a === '--links') flags.links = true;
    else if (a === '--anon') flags.anon = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--compliance') {
      flags.compliance = argv[++i] ?? null;
      consumed.push(flags.compliance);
    } else if (a.startsWith('--compliance=')) {
      flags.compliance = a.slice('--compliance='.length);
      consumed.push(flags.compliance);
    } else if (a === '--out') {
      flags.out = argv[++i] ?? null;
      consumed.push(flags.out);
    } else if (a.startsWith('--out=')) {
      flags.out = a.slice('--out='.length);
      consumed.push(flags.out);
    } else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
    else positional.push(a);
  }
  flags.out = flags.out ? path.resolve(flags.out) : DEFAULT_OUT_DIR;
  // 위치 인자는 순서 무관: logNo는 숫자, blogId는 숫자가 아니다.
  const candidates = positional.filter((p) => !consumed.includes(p));
  flags.logNo = candidates.find((p) => /^\d+$/.test(p)) ?? null;
  flags.blogIdArg = candidates.find((p) => !/^\d+$/.test(p)) ?? null;
  return flags;
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  if (flags.selftest) {
    const { failures } = await runSelfTest();
    return failures.length ? 1 : 0;
  }

  const modes = [flags.links, flags.anon, !!flags.compliance].filter(Boolean).length;
  if (modes > 1) {
    throw new Error('한 번에 하나의 모드만 쓸 수 있다 (--links | --anon | --compliance)');
  }
  if (!flags.logNo) {
    console.error(USAGE);
    return 2;
  }
  const blogId =
    flags.blogIdArg || process.env.BLOG_POSTER_PLATFORM_NAVER_BLOG_ID || resolveBlogIdFromConfig();
  if (!blogId) {
    console.error(
      'blogId를 해석하지 못했다 — 두 번째 인자로 넘기거나 config yaml의 platforms.naver.blogId를 설정하라.',
    );
    return 2;
  }

  if (flags.links) {
    const { failures } = await runLinks(blogId, flags.logNo, { outDir: flags.out });
    return failures.length ? 1 : 0;
  }
  if (flags.compliance) {
    const draftDir = path.resolve(flags.compliance);
    const { failures } = await runCompliance(draftDir, blogId, flags.logNo, { outDir: flags.out });
    return failures.length ? 1 : 0;
  }
  if (flags.anon) {
    const { failures } = await runAnon(blogId, flags.logNo, { outDir: flags.out });
    return failures.length ? 1 : 0;
  }
  const summary = await runReaderView(blogId, flags.logNo, { outDir: flags.out, json: flags.json });
  return summary.overallVerdict === 'PASS' ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    if (e instanceof Error && !e.message.startsWith('HARNESS'))
      console.error(`HARNESS ERROR: ${e.message}`);
    else console.error('HARNESS ERROR:', e?.stack || e);
    process.exit(2);
  });
