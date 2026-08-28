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
for (let elapsed = 0; elapsed < TIMEOUT_MS; elapsed += POLL_INTERVAL_MS) {
  await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  const cookies = await context.cookies();
  if (cookies.some((c) => c.name === 'NID_AUT')) {
    success = true;
    break;
  }
}

await context.close().catch(() => {});

if (success) {
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
