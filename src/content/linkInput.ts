/**
 * 링크 입력값 파서 — **의존성 0** (서버와 브라우저 에디터가 같은 규칙을 쓴다).
 *
 * 배경(2026-09-07 실발행물 logNo 224404059950): 사용자가 상품 링크 위젯의 URL 칸에
 * 쿠팡 파트너스 **이미지 배너 스니펫**을 통째로 붙여넣었다.
 *
 *   <a href="https://link.coupang.com/a/…" target="_blank" referrerpolicy="unsafe-url">
 *     <img src="https://img4a.coupangcdn.com/image/affiliate/banner/….jpg"
 *          alt="[백화점 정품] Guess 게스 여성 롱 와이드 데님 청바지" width="120" height="240">
 *   </a>
 *
 * 어느 단계에서도 이걸 검증하지 않아 `<a href="<a href=…">`라는 앵커가 만들어졌고,
 * 발행물에는 링크 없는 평문 "상품 보기"만 남았다. 스니펫 자체는 script 없는
 * `<a><img>`라 네이버에서 잘 살아남는 형태이므로 **버리지 않고 뜯어서 쓴다**.
 *
 * cheerio/DOM에 기대지 않는다 — 에디터(브라우저 번들)와 발행 파이프라인(Node)이
 * 같은 파일을 공유해야 규칙이 갈라지지 않는다.
 */

export interface ParsedLinkInput {
  /** 첫 앵커의 href, 없으면 텍스트에서 찾은 첫 http(s) URL */
  url: string;
  /** 첫 이미지의 src (배너 이미지) */
  imageUrl: string;
  /** 첫 이미지의 alt — 보통 실제 상품명이다 */
  altText: string;
  /** 입력이 URL이 아니라 HTML 스니펫이었는지 */
  fromHtml: boolean;
}

/** 속성값에 흔히 섞이는 HTML 엔티티만 되돌린다. */
function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

/** 태그 문자열에서 속성 하나를 뽑는다(따옴표 필수 — 파트너스 스니펫이 항상 그렇다). */
function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i').exec(tag);
  return m ? decodeEntities(m[2]).trim() : '';
}

/** 발행 후에도 링크로 살아남는 http(s) 주소인지. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test((value ?? '').trim());
}

/** 프로토콜 상대(`//host/…`)까지 허용하는 이미지 주소 판정. */
export function isPublishableImageUrl(value: string): boolean {
  return /^(?:https?:)?\/\/\S+$/i.test((value ?? '').trim());
}

/**
 * URL 칸 입력을 파싱한다. 순수 함수 — 유닛 테스트 대상.
 * 평범한 URL이면 그대로, HTML 스니펫이면 href/이미지/alt를 뽑아 돌려준다.
 */
export function parseLinkInput(raw: string): ParsedLinkInput {
  const input = (raw ?? '').trim();
  const empty: ParsedLinkInput = { url: '', imageUrl: '', altText: '', fromHtml: false };
  if (!input) return empty;

  if (!/<\s*(?:a|img)\b/i.test(input)) {
    return { ...empty, url: input };
  }

  const anchorTag = /<a\b[^>]*>/i.exec(input)?.[0] ?? '';
  const imgTag = /<img\b[^>]*>/i.exec(input)?.[0] ?? '';

  let url = attr(anchorTag, 'href');
  if (!url) {
    // 앵커가 없는 스니펫 — 텍스트에서 첫 http(s) URL을 찾는다(마지막 시도).
    url = decodeEntities(/https?:\/\/[^\s"'<>]+/i.exec(input)?.[0] ?? '');
  }
  return {
    url,
    imageUrl: attr(imgTag, 'src'),
    altText: attr(imgTag, 'alt'),
    fromHtml: true,
  };
}
