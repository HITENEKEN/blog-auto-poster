/* eslint-disable no-console -- 진단용 CLI 스크립트 */
/**
 * 발행물 진단(이슈 #20 T7).
 *
 * 네이버 SmartEditor ONE은 라이브 DOM이 아니라 내부 모듈 모델
 * (`<script type="text/data" class="__se_module_data" data-module-v2="…">`)을
 * 직렬화해 발행한다. 그래서 "에디터 DOM에서 봤던 모양"과 "실제 발행물"이
 * 어긋날 수 있다(이미지가 본문 앞/끝에 몰림, ⟦IMGn⟧ 플레이스홀더 노출,
 * 링크 소실). 이 스크립트는 발행된 글의 `.se-main-container` 컴포넌트
 * 시퀀스를 문서 순서 그대로 덤프해 실제 결과를 매번 확인할 수 있게 한다.
 *
 * usage:
 *   node scripts/inspect-published-post.mjs <logNo> [blogId] [--json]
 *
 * blogId 생략 시 env BLOG_POSTER_PLATFORM_NAVER_BLOG_ID → config/*.yaml
 * (platforms.naver.blogId) 순으로 해석한다.
 *
 * 종료 코드: 이슈 #20 T9 합격 기준을 모두 충족하면 0, 하나라도 어긋나면 1.
 */
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';
import yaml from 'js-yaml';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 본문 이미지 플레이스홀더 잔여물(이슈 #20 원인 A-2) */
const PLACEHOLDER_RE = /⟦IMG\d+⟧/g;

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

/**
 * PostView.naver는 frameset 문서를 반환하고, 본문은 내부 프레임(redirect=Dlog)에 있다.
 * `.se-main-container`가 없으면 iframe/frame src를 따라 한 번 더 가져온다.
 */
async function fetchPostDocument(blogId, logNo) {
  const get = async (url) => {
    const res = await axios.get(url, {
      timeout: 20_000,
      maxRedirects: 5,
      validateStatus: () => true,
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'ko-KR,ko;q=0.9' },
      responseType: 'text',
      transformResponse: [(data) => data],
    });
    return { status: res.status, body: typeof res.data === 'string' ? res.data : '' };
  };

  const firstUrl = `https://blog.naver.com/PostView.naver?blogId=${encodeURIComponent(
    blogId,
  )}&logNo=${encodeURIComponent(logNo)}`;
  const first = await get(firstUrl);
  if (first.status !== 200) {
    throw new Error(`PostView.naver responded ${first.status} for ${firstUrl}`);
  }
  if (first.body.includes('se-main-container')) {
    return { html: first.body, url: firstUrl, viaFrame: false, bytes: first.body.length };
  }

  // frameset: 내부 프레임 src 추출(상대경로일 수 있으므로 firstUrl 기준으로 해석)
  const srcMatch = /<(?:iframe|frame)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(first.body);
  if (!srcMatch) {
    throw new Error(
      `본문 프레임(.se-main-container)을 찾지 못했다 — 비공개 글이거나 logNo/blogId가 잘못됐다: ${firstUrl}`,
    );
  }
  const innerUrl = new URL(srcMatch[1], firstUrl).toString();
  const inner = await get(innerUrl);
  if (!inner.body.includes('se-main-container')) {
    throw new Error(`내부 프레임에도 .se-main-container가 없다: ${innerUrl}`);
  }
  return { html: inner.body, url: innerUrl, viaFrame: true, bytes: inner.body.length };
}

/** class 토큰에서 컴포넌트 종류(se-text/se-image/…)를 뽑는다. */
function componentType(classAttr) {
  const tokens = (classAttr || '').split(/\s+/).filter(Boolean);
  const kind = tokens.find(
    (t) => t.startsWith('se-') && t !== 'se-component' && !t.startsWith('se-l-'),
  );
  return kind ? kind.replace(/^se-/, '') : 'unknown';
}

/** 공백을 한 칸으로 정규화하고 앞부분만 자른다. */
function snippet(text, max = 70) {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** `.se-main-container`의 컴포넌트 시퀀스를 문서 순서로 덤프한다. */
function inspectComponents(html) {
  const $ = cheerio.load(html);
  const container = $('.se-main-container').first();
  const components = [];
  (container.length ? container : $('body')).find('.se-component').each((_, el) => {
    const node = $(el);
    const type = componentType(node.attr('class') || '');

    const images = node
      .find('img')
      .toArray()
      .map((img) => $(img).attr('src') || '')
      .filter(Boolean);

    // SE는 이미지마다 <a href="#" class="se-module-image-link">를 붙이므로
    // "본문 텍스트 하이퍼링크" 집계에서는 제외한다(이슈 #20 원인 E — 위양성 방지).
    const anchors = node
      .find('a[href]')
      .toArray()
      .map((a) => ({
        href: $(a).attr('href') || '',
        isImageLink: /se-module-image-link/.test($(a).attr('class') || ''),
        text: snippet($(a).text(), 40),
      }));

    components.push({
      index: components.length,
      type,
      images,
      anchors,
      text: snippet(node.text()),
      iframes: node.find('iframe').length,
      placeholders: (node.text().match(PLACEHOLDER_RE) ?? []).length,
    });
  });
  return components;
}

/** 본문 컨테이너(.se-main-container) 내부 HTML만 뽑는다 — 페이지 장식(댓글/공유 iframe) 제외. */
function extractContainerHtml(html) {
  const $ = cheerio.load(html);
  const container = $('.se-main-container').first();
  return container.length ? (container.html() ?? '') : '';
}

/** 컴포넌트 시퀀스 → 합격/불합격 판정이 가능한 집계. */
function summarize(bodyHtml, components) {
  const byType = {};
  for (const c of components) byType[c.type] = (byType[c.type] ?? 0) + 1;

  const imageComponents = components.filter((c) => c.images.length > 0);
  const allImages = imageComponents.flatMap((c) => c.images);
  const allAnchors = components.flatMap((c) => c.anchors);
  const textLinks = allAnchors.filter((a) => !a.isImageLink);

  return {
    total: components.length,
    byType,
    imageComponentIndexes: imageComponents.map((c) => c.index),
    imageCount: allImages.length,
    naverHostedImages: allImages.filter((src) => /(?:postfiles|blogfiles)\.pstatic\.net/i.test(src))
      .length,
    textLinkCount: textLinks.length,
    httpTextLinkCount: textLinks.filter((a) => /^https?:\/\//i.test(a.href)).length,
    imageLinkAnchorCount: allAnchors.filter((a) => a.isImageLink).length,
    // 본문 컨테이너 기준 — 페이지 하단 댓글/공유 위젯 iframe은 발행물 본문과 무관하다.
    iframeCount: (bodyHtml.match(/<iframe\b/gi) ?? []).length,
    placeholderCount: (bodyHtml.match(PLACEHOLDER_RE) ?? []).length,
  };
}

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

const doc = await fetchPostDocument(blogId, logNo);
const components = inspectComponents(doc.html);
const summary = summarize(extractContainerHtml(doc.html), components);

if (asJson) {
  console.log(
    JSON.stringify(
      { blogId, logNo, url: doc.url, viaFrame: doc.viaFrame, summary, components },
      null,
      2,
    ),
  );
  process.exit(0);
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
  const realLinks = c.anchors.filter((a) => !a.isImageLink && /^https?:\/\//i.test(a.href));
  if (realLinks.length > 0) marks.push(`link: ${realLinks[0].href}`);
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
  `  본문 텍스트 링크 ${summary.httpTextLinkCount}개 (비-http ` +
    `${summary.textLinkCount - summary.httpTextLinkCount}개, se-module-image-link 앵커 ` +
    `${summary.imageLinkAnchorCount}개 제외)`,
);
console.log(
  `  iframe ${summary.iframeCount}개 / ⟦IMGn⟧ 플레이스홀더 ${summary.placeholderCount}회`,
);

// 이슈 #20 T9 합격 기준
const checks = [
  {
    label: '⟦IMG 플레이스홀더 0회',
    pass: summary.placeholderCount === 0,
    detail: `${summary.placeholderCount}회 검출`,
  },
  {
    label: '본문 텍스트 <a href="https://…"> >= 1',
    pass: summary.httpTextLinkCount >= 1,
    detail: `${summary.httpTextLinkCount}개`,
  },
  { label: '<iframe> 0회', pass: summary.iframeCount === 0, detail: `${summary.iframeCount}개` },
  {
    // 자동 판정 불가 — 위치를 출력해 "본문 사이 분산" 여부를 육안 확인하게 한다.
    label: '이미지가 본문 앞/끝이 아니라 섹션 사이에 분산',
    pass: null,
    detail: `위치 #${summary.imageComponentIndexes.map((i) => i + 1).join(', #') || '-'} / 전체 ${summary.total}개`,
  },
];

console.log('');
console.log('합격 기준 (이슈 #20 T9)');
for (const c of checks) {
  const tag = c.pass === null ? '[INFO]' : c.pass ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${c.label} -> ${c.detail}`);
}

const failed = checks.some((c) => c.pass === false);
console.log('');
console.log(failed ? '결과: FAIL — 발행물이 합격 기준을 충족하지 않는다.' : '결과: PASS');
process.exit(failed ? 1 : 0);
