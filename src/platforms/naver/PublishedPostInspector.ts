import * as cheerio from 'cheerio';

/**
 * 발행물 진단(이슈 #20 T7 → 2026-09-08 모듈화).
 *
 * 네이버 SmartEditor ONE은 라이브 DOM이 아니라 내부 모듈 모델을 직렬화해 발행한다.
 * 그래서 "에디터에서 봤던 모양"과 "실제 발행물"이 어긋난다. 이 모듈은 발행된 글의
 * `.se-main-container` 컴포넌트 시퀀스를 문서 순서대로 뜯어 합격/불합격을 판정한다.
 *
 * 순수 함수만 둔다(네트워크는 fetcher 주입) — `scripts/inspect-published-post.mjs`와
 * 발행 직후 자동 점검이 **같은 판정 로직**을 쓰게 하기 위해서다.
 */

/** 본문 이미지 플레이스홀더 잔여물(이슈 #20 원인 A-2) */
export const PLACEHOLDER_RE = /⟦IMG\d+⟧/g;

export interface PublishedAnchor {
  href: string;
  /** SE가 이미지마다 붙이는 `se-module-image-link` 앵커인지 */
  isImageLink: boolean;
  /** 이미지 링크가 실제로 들고 있는 http(s) 주소(`data-linkdata.link`) */
  imageLinkHref: string;
  text: string;
}

export interface PublishedComponent {
  index: number;
  /** se-text / se-image / se-table … */
  type: string;
  images: string[];
  anchors: PublishedAnchor[];
  text: string;
  iframes: number;
  placeholders: number;
}

export interface PublishedPostSummary {
  total: number;
  byType: Record<string, number>;
  imageComponentIndexes: number[];
  imageCount: number;
  naverHostedImages: number;
  textLinkCount: number;
  httpTextLinkCount: number;
  imageLinkAnchorCount: number;
  /** 실제 http(s) 주소를 들고 있는 이미지 링크 수 */
  liveImageLinkCount: number;
  iframeCount: number;
  placeholderCount: number;
  /** 본문이 통째로 반복 발행됐는지(2026-09-07 사고) */
  duplicated: boolean;
  /** 파트너스 고지 문구 노출 횟수 */
  disclosureCount: number;
}

export interface PublishedPostCheck {
  label: string;
  /** null = 자동 판정 불가(정보 제공) */
  pass: boolean | null;
  detail: string;
}

/** 파트너스 고지 문구 — 카드마다 반복되면 안 된다(실측 발행물에서 4번 노출). */
const DISCLOSURE_TEXT = '쿠팡 파트너스';

/** class 토큰에서 컴포넌트 종류(se-text/se-image/…)를 뽑는다. */
export function componentType(classAttr: string): string {
  const tokens = (classAttr || '').split(/\s+/).filter(Boolean);
  const kind = tokens.find(
    (t) => t.startsWith('se-') && t !== 'se-component' && !t.startsWith('se-l-'),
  );
  return kind ? kind.replace(/^se-/, '') : 'unknown';
}

/** 공백을 한 칸으로 정규화하고 앞부분만 자른다. */
export function snippet(text: string, max = 70): string {
  const flat = (text || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * SE 이미지 링크 앵커의 실제 주소를 뽑는다.
 * 붙여넣은 `<a href="http…"><img></a>`를 SE는 `href="#"` + `data-linkdata`의
 * `"link"`로 직렬화하므로, href만 보면 살아있는 링크를 0개로 세게 된다.
 */
export function extractImageLinkHref(linkData: string): string {
  const raw = (linkData || '').replace(/&quot;/g, '"');
  return /"link"\s*:\s*"(https?:\/\/[^"]+)"/i.exec(raw)?.[1] ?? '';
}

/** 본문 컨테이너(.se-main-container) 내부 HTML만 뽑는다 — 댓글/공유 iframe 제외. */
export function extractContainerHtml(html: string): string {
  const $ = cheerio.load(html);
  const container = $('.se-main-container').first();
  return container.length ? (container.html() ?? '') : (($('body').html() ?? '') as string);
}

/**
 * `.se-main-container`의 컴포넌트 시퀀스를 문서 순서로 덤프한다.
 * 전체 문서 HTML과 컨테이너 innerHTML을 모두 받아들인다.
 */
export function inspectPublishedComponents(html: string): PublishedComponent[] {
  const $ = cheerio.load(html);
  const container = $('.se-main-container').first();
  const scope = container.length ? container : $('body');
  const components: PublishedComponent[] = [];

  scope.find('.se-component').each((_, el) => {
    const node = $(el);
    const images = node
      .find('img')
      .toArray()
      .map((img) => $(img).attr('src') || '')
      .filter(Boolean);

    const anchors: PublishedAnchor[] = node
      .find('a[href]')
      .toArray()
      .map((a) => {
        const anchor = $(a);
        const isImageLink = /se-module-image-link/.test(anchor.attr('class') || '');
        return {
          href: anchor.attr('href') || '',
          isImageLink,
          imageLinkHref: isImageLink
            ? extractImageLinkHref(anchor.attr('data-linkdata') || '')
            : '',
          text: snippet(anchor.text(), 40),
        };
      });

    components.push({
      index: components.length,
      type: componentType(node.attr('class') || ''),
      images,
      anchors,
      text: snippet(node.text()),
      iframes: node.find('iframe').length,
      placeholders: (node.text().match(PLACEHOLDER_RE) ?? []).length,
    });
  });
  return components;
}

/**
 * 본문이 통째로 두 번 발행됐는지 판정한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 2026-09-07 실발행물(logNo 224404059950)은 컴포넌트 30개짜리 글이 60개로,
 * 전반부와 후반부가 종류·텍스트까지 완전히 같았다. 붙여넣기 재시도가 에디터를
 * 비우지 않고 덧붙인 결과다.
 */
export function detectDuplicatedComponents(components: PublishedComponent[]): boolean {
  const n = components.length;
  if (n < 6 || n % 2 !== 0) return false;
  const half = n / 2;
  for (let i = 0; i < half; i += 1) {
    const a = components[i];
    const b = components[i + half];
    if (a.type !== b.type || a.text !== b.text) return false;
  }
  return true;
}

/** 컴포넌트 시퀀스 → 합격/불합격 판정이 가능한 집계. */
export function summarizePublishedPost(
  html: string,
  components: PublishedComponent[],
): PublishedPostSummary {
  const bodyHtml = extractContainerHtml(html);
  const byType: Record<string, number> = {};
  for (const c of components) byType[c.type] = (byType[c.type] ?? 0) + 1;

  const imageComponents = components.filter((c) => c.images.length > 0);
  const allImages = imageComponents.flatMap((c) => c.images);
  const allAnchors = components.flatMap((c) => c.anchors);
  const textLinks = allAnchors.filter((a) => !a.isImageLink);
  const imageLinks = allAnchors.filter((a) => a.isImageLink);

  return {
    total: components.length,
    byType,
    imageComponentIndexes: imageComponents.map((c) => c.index),
    imageCount: allImages.length,
    naverHostedImages: allImages.filter((src) => /(?:postfiles|blogfiles)\.pstatic\.net/i.test(src))
      .length,
    textLinkCount: textLinks.length,
    httpTextLinkCount: textLinks.filter((a) => /^https?:\/\//i.test(a.href)).length,
    imageLinkAnchorCount: imageLinks.length,
    liveImageLinkCount: imageLinks.filter((a) => a.imageLinkHref !== '').length,
    iframeCount: (bodyHtml.match(/<iframe\b/gi) ?? []).length,
    placeholderCount: (bodyHtml.match(PLACEHOLDER_RE) ?? []).length,
    duplicated: detectDuplicatedComponents(components),
    disclosureCount: components.filter((c) => c.text.includes(DISCLOSURE_TEXT)).length,
  };
}

/** 발행물 합격 기준 판정. 순수 함수 — 유닛 테스트 대상. */
export function evaluatePublishedPost(summary: PublishedPostSummary): PublishedPostCheck[] {
  return [
    {
      label: '본문이 중복 발행되지 않음',
      pass: !summary.duplicated,
      detail: summary.duplicated
        ? `컴포넌트 ${summary.total}개 — 전반부와 후반부가 동일하다`
        : `컴포넌트 ${summary.total}개`,
    },
    {
      label: '⟦IMGn⟧ 플레이스홀더 0회',
      pass: summary.placeholderCount === 0,
      detail: `${summary.placeholderCount}회 검출`,
    },
    {
      label: '살아있는 쿠팡 링크 >= 1 (텍스트 링크 + 이미지 링크)',
      pass: summary.httpTextLinkCount + summary.liveImageLinkCount >= 1,
      detail: `텍스트 ${summary.httpTextLinkCount}개 + 이미지 ${summary.liveImageLinkCount}개`,
    },
    {
      label: '<iframe> 0회',
      pass: summary.iframeCount === 0,
      detail: `${summary.iframeCount}개`,
    },
    {
      // 외부 호스팅 이미지는 광고 차단기/DNS 필터에 막히는 순간 네이버가 그 자리에
      // "존재하지 않는 이미지입니다."를 넣는다(실측 224405221163). 본문 이미지는
      // 전부 네이버가 호스팅해야 한다.
      label: '본문 이미지가 전부 네이버 호스팅',
      pass: summary.imageCount === summary.naverHostedImages,
      detail: `${summary.naverHostedImages}/${summary.imageCount}장`,
    },
    {
      label: '파트너스 고지 문구 1회',
      pass: summary.disclosureCount <= 1,
      detail: `${summary.disclosureCount}회 노출`,
    },
    {
      // 자동 판정 불가 — 위치를 출력해 "본문 사이 분산" 여부를 육안 확인하게 한다.
      label: '이미지가 본문 앞/끝이 아니라 섹션 사이에 분산',
      pass: null,
      detail: `위치 #${summary.imageComponentIndexes.map((i) => i + 1).join(', #') || '-'} / 전체 ${summary.total}개`,
    },
  ];
}

/** 합격 기준에 어긋난 항목만 사람이 읽는 한 줄로 만든다(발행 경고용). */
export function collectPublishedPostFailures(html: string): string[] {
  const components = inspectPublishedComponents(html);
  if (components.length === 0) return [];
  const summary = summarizePublishedPost(html, components);
  return evaluatePublishedPost(summary)
    .filter((c) => c.pass === false)
    .map((c) => `발행물 점검 실패 — ${c.label}: ${c.detail}`);
}

// ---------------------------------------------------------------------------
// 네트워크 (스크립트/서버 공용) — fetcher 주입으로 테스트에서 끊는다.
// ---------------------------------------------------------------------------

export const INSPECTOR_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export interface PublishedPostDocument {
  html: string;
  url: string;
  viaFrame: boolean;
  bytes: number;
}

export type DocumentFetcher = (url: string) => Promise<{ status: number; body: string }>;

/**
 * PostView.naver는 frameset 문서를 반환하고, 본문은 내부 프레임에 있다.
 * `.se-main-container`가 없으면 iframe/frame src를 따라 한 번 더 가져온다.
 */
export async function fetchPublishedPostDocument(
  blogId: string,
  logNo: string,
  get: DocumentFetcher,
): Promise<PublishedPostDocument> {
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
