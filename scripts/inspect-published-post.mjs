/* eslint-disable no-console -- 진단용 CLI 스크립트 */
/**
 * 발행물 진단(이슈 #20 T7).
 *
 * 네이버 SmartEditor ONE은 라이브 DOM이 아니라 내부 모듈 모델
 * (`<script type="text/data" class="__se_module_data" data-module-v2="…">`)을
 * 직렬화해 발행한다. 그래서 "에디터 DOM에서 봤던 모양"과 "실제 발행물"이
 * 어긋날 수 있다(본문 중복 발행, 이미지가 앞/끝에 몰림, ⟦IMGn⟧ 노출, 링크 소실).
 * 이 스크립트는 발행된 글의 `.se-main-container` 컴포넌트 시퀀스를 문서 순서 그대로
 * 덤프해 실제 결과를 매번 확인할 수 있게 한다.
 *
 * 판정 로직은 `src/platforms/naver/PublishedPostInspector.ts`에 있고 발행 직후
 * 자동 점검과 **같은 코드**를 쓴다 — 사전에 `npm run build`가 필요하다.
 *
 * usage:
 *   npm run build
 *   node scripts/inspect-published-post.mjs <logNo> [blogId] [--json]
 *
 * blogId 생략 시 env BLOG_POSTER_PLATFORM_NAVER_BLOG_ID → config/*.yaml
 * (platforms.naver.blogId) 순으로 해석한다.
 *
 * 주의: 비공개 글은 익명 요청으로 본문을 받을 수 없다(발행 직후 자동 점검은
 * 로그인된 브라우저로 읽으므로 비공개 글도 검사된다).
 *
 * 종료 코드: 합격 기준을 모두 충족하면 0, 하나라도 어긋나면 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import yaml from 'js-yaml';
import {
  INSPECTOR_USER_AGENT,
  evaluatePublishedPost,
  fetchPublishedPostDocument,
  inspectPublishedComponents,
  summarizePublishedPost,
} from '../dist/platforms/naver/PublishedPostInspector.js';

/** config/*.yaml 에서 platforms.naver.blogId를 찾는다(스크립트 단독 실행용). */
function resolveBlogIdFromConfig() {
  const env = process.env.NODE_ENV || 'development';
  const candidates = [
    path.resolve(`config/${env}.yaml`),
    path.resolve('config/secrets.yaml'),
    path.resolve('config/default.yaml'),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf-8'));
      const blogId = doc?.platforms?.naver?.blogId;
      if (blogId) return String(blogId);
    } catch {
      // 깨진 yaml은 건너뛴다 — 다음 후보로
    }
  }
  return '';
}

const httpGet = async (url) => {
  const res = await axios.get(url, {
    timeout: 20_000,
    maxRedirects: 5,
    validateStatus: () => true,
    headers: { 'User-Agent': INSPECTOR_USER_AGENT, 'Accept-Language': 'ko-KR,ko;q=0.9' },
    responseType: 'text',
    transformResponse: [(data) => data],
  });
  return { status: res.status, body: typeof res.data === 'string' ? res.data : '' };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const logNo = positional[0];
const blogId =
  positional[1] || process.env.BLOG_POSTER_PLATFORM_NAVER_BLOG_ID || resolveBlogIdFromConfig();

if (!logNo || !/^\d+$/.test(logNo)) {
  console.error('usage: node scripts/inspect-published-post.mjs <logNo> [blogId] [--json]');
  process.exit(2);
}
if (!blogId) {
  console.error(
    'blogId를 해석하지 못했다 — 두 번째 인자로 넘기거나 config yaml의 platforms.naver.blogId를 설정하라.',
  );
  process.exit(2);
}

const doc = await fetchPublishedPostDocument(blogId, logNo, httpGet);
const components = inspectPublishedComponents(doc.html);
const summary = summarizePublishedPost(doc.html, components);
const checks = evaluatePublishedPost(summary);

if (asJson) {
  console.log(
    JSON.stringify(
      { blogId, logNo, url: doc.url, viaFrame: doc.viaFrame, summary, components, checks },
      null,
      2,
    ),
  );
  process.exit(checks.some((c) => c.pass === false) ? 1 : 0);
}

console.log(`[inspect] blogId=${blogId} logNo=${logNo}`);
console.log(
  `[inspect] ${doc.url} — ${doc.bytes} bytes${doc.viaFrame ? ' (frameset 내부 프레임)' : ''}`,
);
console.log('');
console.log(`컴포넌트 시퀀스 (.se-main-container, ${summary.total}개)`);
for (const c of components) {
  const marks = [];
  if (c.images.length > 0) marks.push(`img: ${c.images[0]}`);
  const textLinks = c.anchors.filter((a) => !a.isImageLink && /^https?:\/\//i.test(a.href));
  if (textLinks.length > 0) marks.push(`link: ${textLinks[0].href}`);
  const imageLinks = c.anchors.filter((a) => a.isImageLink && a.imageLinkHref);
  if (imageLinks.length > 0) marks.push(`imglink: ${imageLinks[0].imageLinkHref}`);
  if (c.placeholders > 0) marks.push(`플레이스홀더 ${c.placeholders}회`);
  if (c.iframes > 0) marks.push(`iframe ${c.iframes}개`);
  const detail = marks.length > 0 ? `  ${marks.join(' | ')}` : '';
  const text = c.text ? `  "${c.text}"` : '';
  console.log(`  #${String(c.index + 1).padStart(2, '0')} ${c.type.padEnd(14)}${detail}${text}`);
}

console.log('');
console.log('집계');
console.log(
  `  컴포넌트 ${summary.total}개 — ` +
    Object.entries(summary.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(', '),
);
console.log(
  `  이미지 ${summary.imageCount}장 (네이버 호스팅 ${summary.naverHostedImages}장), 위치 #` +
    (summary.imageComponentIndexes.map((i) => i + 1).join(', #') || '-'),
);
console.log(
  `  본문 텍스트 링크 ${summary.httpTextLinkCount}개 / ` +
    `살아있는 이미지 링크 ${summary.liveImageLinkCount}개 ` +
    `(이미지 앵커 ${summary.imageLinkAnchorCount}개 중)`,
);
console.log(
  `  iframe ${summary.iframeCount}개 / ⟦IMGn⟧ ${summary.placeholderCount}회 / ` +
    `파트너스 고지 ${summary.disclosureCount}회 / 중복발행 ${summary.duplicated ? 'YES' : 'no'}`,
);

console.log('');
console.log('합격 기준');
for (const c of checks) {
  const tag = c.pass === null ? '[INFO]' : c.pass ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${c.label} -> ${c.detail}`);
}

const failed = checks.some((c) => c.pass === false);
console.log('');
console.log(failed ? '결과: FAIL — 발행물이 합격 기준을 충족하지 않는다.' : '결과: PASS');
process.exit(failed ? 1 : 0);
