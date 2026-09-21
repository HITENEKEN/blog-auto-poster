// ---------------------------------------------------------------------------
// RSS 기반 발행 재검증 (이슈 #10 — 발행 확인 클릭은 성공했지만 post view URL
// 감지가 실패해 '실패'로 기록되는 오판 방지). rss.blog.naver.com/{blogId}.xml은
// 로그인 없이 최근 게시물의 제목/링크(logNo)/pubDate를 제공한다.
//
// 이 파일은 playwright에 의존하지 않는 **순수 함수**만 담는다. 로봇(상주 프로세스)이
// 브라우저 프로필·playwright를 끌어오지 않고 RSS 파싱을 재사용하기 위한 분리다
// (설계 documents/24-auto-poster-robot-design.md §1 import 규칙).
// NaverBrowserPoster.ts는 하위 호환을 위해 이 모듈을 재export한다.
// ---------------------------------------------------------------------------

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

/** RSS XML에서 logNo 집합을 뽑는다(RECONCILE의 차집합 계산용). 빈 값은 버린다. */
export function collectRssLogNos(xml: string): string[] {
  const seen = new Set<string>();
  for (const item of parseNaverRss(xml)) {
    if (item.logNo) seen.add(item.logNo);
  }
  return [...seen].sort();
}
