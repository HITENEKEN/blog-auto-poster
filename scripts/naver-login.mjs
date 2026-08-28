#!/usr/bin/env node
/**
 * One-time manual Naver login for the headless-browser posting flow.
 *
 * Opens a HEADFUL persistent browser context sharing the profile at
 * data/browser-profiles/naver (the same profile NaverBrowserPoster uses),
 * lets the user log in + complete 2FA / device registration by hand, then
 * waits for the NID_AUT session cookie before exiting.
 *
 * Other machines: `npx playwright install chromium` is required once.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve } from 'path';

const PROFILE_DIR = resolve(process.cwd(), 'data', 'browser-profiles', 'naver');
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60 * 1_000;

mkdirSync(PROFILE_DIR, { recursive: true });

console.log('네이버 브라우저 프로필:', PROFILE_DIR);
console.log('브라우저를 실행합니다 (Chromium이 없다면: npx playwright install chromium)');

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: false,
  viewport: { width: 1280, height: 900 },
  locale: 'ko-KR',
  args: ['--disable-blink-features=AutomationControlled'],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://nid.naver.com/nidlogin.login', { waitUntil: 'domcontentloaded' });

console.log('');
console.log('========================================================');
console.log(' 브라우저에서 네이버 로그인을 직접 완료하세요.');
console.log(' (2차 인증/기기등록도 이 브라우저에서 직접 진행)');
console.log(' 로그인 세션이 감지되면 자동으로 종료됩니다 (최대 5분).');
console.log('========================================================');
console.log('');

let success = false;
let warnedSessionScoped = false;
for (let elapsed = 0; elapsed < TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  const aut = (await context.cookies()).find((c) => c.name === 'NID_AUT');
  if (!aut) continue;
  if (aut.expires === -1) {
    // Session-scoped cookie: it dies with this browser and Chromium never
    // writes it to the profile on disk, so closing below would lose the
    // login. This happens when "로그인 상태 유지" was left unchecked.
    if (!warnedSessionScoped) {
      warnedSessionScoped = true;
      console.error('');
      console.error('⚠️  NID_AUT 쿠키가 세션 전용으로 발급되었습니다 (만료시각 없음).');
      console.error('   이 상태로는 브라우저를 닫는 순간 세션이 사라집니다.');
      console.error(
        '   로그아웃 후 로그인 화면에서 [로그인 상태 유지]를 체크하고 다시 로그인해 주세요.',
      );
      console.error('   감지를 계속 대기합니다...');
      console.error('');
    }
    continue;
  }
  success = true;
  break;
}

await context.close().catch(() => {});

if (success) {
  // Verify the cookie actually persisted to the profile on disk: the whole
  // point of this script is a session the HEADLESS poster can reuse later.
  let persisted = false;
  try {
    const check = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
    persisted = (await check.cookies('https://www.naver.com')).some((c) => c.name === 'NID_AUT');
    await check.close().catch(() => {});
  } catch {
    // If the verification browser itself fails, trust the in-memory success.
    persisted = true;
  }
  if (!persisted) {
    console.error(
      '❌ NID_AUT 쿠키가 프로필에 저장되지 않았습니다. [로그인 상태 유지]를 체크하고 다시 시도해 주세요: npm run naver:login',
    );
    process.exit(1);
  }
  console.log(
    '✅ 네이버 로그인 세션이 저장되었습니다. 이제 설정에서 useBrowser 체크 후 발행할 수 있습니다.',
  );
  process.exit(0);
} else {
  console.error(
    '❌ 5분 내에 로그인 세션이 감지되지 않았습니다. 다시 실행해 주세요: npm run naver:login',
  );
  process.exit(1);
}
