import * as cheerio from 'cheerio';

/**
 * 파트너스 고지 문구의 단일 출처 (설계 §3-5). 순수 모듈 — 유닛 테스트 대상.
 *
 * 규칙: 광고가 1개 이상이면 본문 첫 블록에 **정확히 1회**, 광고가 0개면 0회.
 * 템플릿 6종에 흩어져 있던 두 가지 문구(상단 "…제공받을 수 있습니다", 하단 `<small>`류)는
 * 전부 이 모듈이 걷어내고 다시 넣는다 — 템플릿에는 고지 문구를 두지 않는다.
 */

/** 템플릿·미리보기·발행물·검사기가 모두 쓰는 고지 문구. */
export const DISCLOSURE_TEXT =
  '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.';

/**
 * 고지 문구 판별식. 문구 변형("…제공받을 수 있습니다", "※ 이 링크는 …")까지
 * 한 번에 잡는다 — 발행물 검사기(`PublishedPostInspector`)도 이 판별을 쓴다.
 */
const DISCLOSURE_RE = /쿠팡\s*파트너스\s*활동/;

/** 텍스트에 파트너스 고지가 들어 있는지(문구 변형 포함). 검사기·게이트 공용 판별. */
export function isDisclosureText(text: string): boolean {
  return DISCLOSURE_RE.test(text ?? '');
}

export const DISCLOSURE_STYLE = 'margin:0 0 16px;font-size:.85rem;color:#868e96';

/** 고지 마커에 붙는 속성 — 자동 광고·자동 고지를 한 번에 지우기 위한 표식. */
export const AUTO_AD_ATTR = 'data-ad-source="auto"';

/**
 * 고지 블록으로 볼 수 있는 앞머리 — 템플릿이 붙여 둔 "광고 ·", "※" 정도만 허용한다.
 * 이 앞머리를 넘어서는 텍스트가 있으면 본문 블록이므로 지우지 않는다.
 */
const DISCLOSURE_PREFIX_RE =
  /^(?:※|광고|이\s*포스팅은|이\s*포스트는|이\s*링크는|[\s·:;()\-–—/|.,])*$/;

/**
 * 고지 문구 뒤에 이어질 수 있는 꼬리 — 문장 부호와 "제공받습니다"류뿐이다.
 * 이 꼬리를 넘어서는 텍스트가 있으면 본문이 섞인 블록이므로 지우지 않는다.
 * 받아들이는 변형: "…제공받습니다." / "…제공받을 수 있습니다."
 */
const DISCLOSURE_TAIL_RE =
  /^쿠팡\s*파트너스\s*활동(?:의\s*일환으로)?\s*[,·]?\s*(?:이에\s*따른\s*)?일정액의?\s*수수료(?:를|가)?\s*제공받(?:습니다|을\s*수\s*있습니다)\.?$/;

/** 고지가 통째로 담기는 블록 후보 태그. */
const BLOCK_SELECTOR = 'p,div,small,span,li,section,blockquote,td';

/** 고지 문구만 담은 블록인지(다른 본문 텍스트가 섞여 있으면 false). */
function isDisclosureOnly(text: string): boolean {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const at = flat.search(DISCLOSURE_RE);
  if (at < 0) return false;
  if (!DISCLOSURE_PREFIX_RE.test(flat.slice(0, at))) return false;
  return DISCLOSURE_TAIL_RE.test(flat.slice(at));
}

/** 고지 블록 중 가장 바깥 것만 남긴다 — 안쪽 <small>까지 지우면 빈 껍데기가 남는다. */
function outermostDisclosureBlocks($: cheerio.Root): cheerio.Element[] {
  const candidates = $(BLOCK_SELECTOR)
    .toArray()
    .filter((el) => isDisclosureOnly($(el).text()));
  const kept: cheerio.Element[] = [];
  for (const el of candidates) {
    // 문서 순서상 부모가 먼저 오므로, 이미 담은 블록의 자손이면 건너뛴다.
    if (kept.some((outer) => $(el).parents().toArray().includes(outer))) continue;
    kept.push(el);
  }
  return kept;
}

/**
 * 템플릿이 렌더한 고지(그리고 이전에 배치한 자동 고지)를 모두 제거한다. 순수 함수.
 * 지울 블록이 없으면 원본 문자열을 그대로 돌려준다(cheerio 재직렬화로 문서가
 * 바뀔 여지를 없앤다).
 */
export function stripDisclosures(html: string): string {
  if (!html || !DISCLOSURE_RE.test(html)) return html;
  const $ = cheerio.load(html);
  const blocks = outermostDisclosureBlocks($);
  if (blocks.length === 0) return html;
  for (const el of blocks) $(el).remove();
  return $('body').html() ?? html;
}

/** 고지 문구가 몇 번 노출되는지 — 게이트의 DISCLOSURE_COUNT 판정에 쓴다. */
export function countDisclosures(html: string): number {
  if (!html || !DISCLOSURE_RE.test(html)) return 0;
  return outermostDisclosureBlocks(cheerio.load(html)).length;
}

/**
 * 광고 유무에 맞춰 고지를 보장한다(설계 §3-5). 순수 함수 — 유닛 테스트 대상.
 *
 * 1. 템플릿 기본 고지와 이전 자동 고지를 전부 지운다(멱등).
 * 2. `hasAds`면 본문 첫 블록 앞에 고지 1개를 넣는다. 아니면 아무것도 넣지 않는다.
 */
export function ensureDisclosure(html: string, hasAds: boolean): string {
  const stripped = stripDisclosures(html);
  if (!hasAds) return stripped;

  const $ = cheerio.load(stripped);
  const body = $('body');
  const marker = `<p data-ad-source="auto" data-ad-disclosure="true" style="${DISCLOSURE_STYLE}">${DISCLOSURE_TEXT}</p>`;
  body.prepend(marker);
  return body.html() ?? stripped;
}
