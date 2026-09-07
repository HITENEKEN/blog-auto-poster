/**
 * R5 이미지 프롬프트 빌더 — 순수 함수 모음.
 *
 * 상품 이미지(2-3장)와 본문 섹션 이미지(2-3장)의 프롬프트를 만들고,
 * 생성된 이미지 경로를 템플릿 섹션키에 대응시키는 매핑을 제공한다.
 * I/O가 없으므로 단위 테스트 대상.
 */

/** 섹션 이미지가 주입되는 표준 키와 우선순위(앞에서부터 경로 배정) */
export const SECTION_IMAGE_KEYS = ['usage', 'specs', 'compare', 'tips', 'checklist'] as const;

export type SectionImageKey = (typeof SECTION_IMAGE_KEYS)[number];

/**
 * 섹션키 → 기본 한국어 제목.
 * 이슈 #20 원인 D: 호출부가 템플릿의 실제 슬롯 키만 넘겨도 프롬프트/캡션 제목을
 * 만들 수 있게 한다(제목 매핑이 이 모듈 안에 남아 있어야 템플릿과 어긋나지 않는다).
 */
export const SECTION_IMAGE_TITLES: Record<SectionImageKey, string> = {
  usage: '직접 사용해 본 모습',
  specs: '주요 스펙과 구성품',
  compare: '경쟁 제품과의 비교',
  tips: '실전 활용 팁',
  checklist: '구매 전 체크리스트',
};

/** SECTION_IMAGE_KEYS 멤버 여부 (런타임 가드 — 외부 문자열을 키로 좁힐 때 쓴다) */
export function isSectionImageKey(value: string): value is SectionImageKey {
  return (SECTION_IMAGE_KEYS as readonly string[]).includes(value);
}

/**
 * 템플릿 소스에서 실제로 참조되는 `sectionImages.<key>` 슬롯을 **문서 순서**로
 * 추출한다. 순수 함수 — 유닛 테스트 대상.
 *
 * 배경(이슈 #20 원인 D): 고정 순서(SECTION_IMAGE_KEYS)로 이미지를 배정하면
 * 템플릿이 쓰지 않는 키(예: naver-coupang-review의 `compare`)에 이미지가 배정돼
 * 본문에 한 번도 등장하지 않는 "고아 이미지"가 생기고, 그 만큼 실제 슬롯에는
 * 이미지가 모자라 생성 이미지가 본문 앞/끝에 몰린다. 템플릿이 참조하는 슬롯만
 * 문서 순서로 써서 "생성 이미지 수 == 본문 슬롯 수"를 맞춘다.
 *
 * `sectionImages.usage` / `sectionImages.[usage]` / `sectionImages['usage']`
 * 세 표기를 모두 인식하고, 중복 참조는 한 번만 센다.
 */
export function extractSectionImageSlots(templateSource: string): SectionImageKey[] {
  if (!templateSource) return [];
  const re = /sectionImages\s*(?:\.\s*\[?([\w-]+)\]?|\[\s*['"]([\w-]+)['"]\s*\])/g;
  const slots: SectionImageKey[] = [];
  const seen = new Set<string>();
  for (const match of templateSource.matchAll(re)) {
    const raw = match[1] ?? match[2] ?? '';
    if (!raw || seen.has(raw) || !isSectionImageKey(raw)) continue;
    seen.add(raw);
    slots.push(raw);
  }
  return slots;
}

export interface SectionImageSpec {
  key: SectionImageKey;
  /** 템플릿 figure의 캡션/alt로 쓰는 한국어 섹션 제목 */
  title: string;
  prompt: string;
}

export interface ProductImagePromptInput {
  productName?: string;
  categoryName?: string;
  brand?: string;
  /** 옵션/특징 나열 (색상, 용량 등) */
  options?: string[];
}

export interface SectionImagePromptInput {
  productName?: string;
  categoryName?: string;
  sections?: Array<{ key: SectionImageKey; title: string; summary?: string }>;
  /**
   * 섹션키만 넘겨 스펙을 만든다(이슈 #20 원인 D) — 제목은 SECTION_IMAGE_TITLES에서
   * 채운다. `sections`가 있으면 그게 우선한다(기존 동작 유지).
   */
  sectionKeys?: readonly SectionImageKey[];
}

/**
 * 모든 프롬프트에 공통으로 붙는 한국어 블로그 스타일 접미사 (일관된 톤 유지).
 * 이슈 #11: 생성 이미지로 실제 상품을 오인하게 하지 않는다 — 상품 카탈로그/
 * 광고 컷 스타일(제품 단독 컷, 클로즈업)은 배제하고 장면·상황 중심으로 생성한다.
 * 실제 구매는 구매 링크로 유도하므로, 제품 디테일의 정확한 재현도 금지한다.
 */
const STYLE_SUFFIX =
  '한국 쇼핑 블로그 본문 삽입용 실사 사진, 밝은 자연광, 생활감 있는 장면, ' +
  '특정 제품의 외관·디테일을 정확히 재현하지 않는다(제품 카탈로그·광고 사진 아님, ' +
  '제품 단독 클로즈업 컷 아님), 브랜드 로고·텍스트·워터마크 없음.';

function subject(input: ProductImagePromptInput): string {
  const parts = [input.brand, input.productName].filter(Boolean).join(' ');
  const name = parts || input.categoryName || '제품';
  const options = input.options?.length ? ` (${input.options.slice(0, 5).join(', ')})` : '';
  const category = input.categoryName ? `${input.categoryName} 분야의 ` : '';
  return `${category}${name}${options}`;
}

/**
 * 상품 대표 이미지 프롬프트 2-3개.
 * 1) 제품 단독 컷, 2) 실사용 라이프스타일 컷, 3) 디테일 클로즈업(옵션 정보가 있을 때만).
 *
 * @deprecated 이슈 #11 — 상품 실물을 연상시키는 이미지는 생성하지 않기로 방침 변경.
 * 발행 흐름(KeywordPostGenerator)에서는 호출하지 않는다. 호환성을 위해 유지만 한다.
 */
export function buildProductImagePrompts(input: ProductImagePromptInput): string[] {
  const s = subject(input);
  const prompts = [
    `${s}을(를) 정면에서 담은 제품 단독 컷. ${STYLE_SUFFIX}`,
    `${s}을(를) 일상 공간에서 실제로 사용하는 모습의 라이프스타일 컷. ${STYLE_SUFFIX}`,
  ];
  if (input.options?.length || input.productName) {
    prompts.push(`${s}의 디테일(질감, 버튼, 구성품)을 가까이 담은 클로즈업 컷. ${STYLE_SUFFIX}`);
  }
  return prompts;
}

/**
 * 본문 섹션 이미지 프롬프트 (이슈 #11 — 상품이 아닌 글 내용 관련 주제 이미지).
 *
 * 제품명/브랜드를 프롬프트에 넣지 않고 카테고리(주제)만 사용해, 생성 이미지가
 * 실제 상품을 연상시키지 않게 한다. 각 섹션 제목(사용 장면/스펙/비교/팁/
 * 체크리스트)에 대응하는 "글 내용의 장면·상황"을 묘사하며, STYLE_SUFFIX가
 * 제품 카탈로그 컷/클로즈업 배제와 제품 식별 방지를 강제한다.
 */
export function buildSectionImageSpecs(input: SectionImagePromptInput): SectionImageSpec[] {
  // 두 분기 모두 `summary?`를 갖도록 명시 — sectionKeys 경로에는 summary가 없지만
  // 아래에서 옵션으로 읽으므로 타입을 맞춰 둔다(이슈 #20 원인 D).
  const sections: Array<{ key: SectionImageKey; title: string; summary?: string }> =
    input.sections ??
    (input.sectionKeys ?? SECTION_IMAGE_KEYS).map((key) => ({
      key,
      title: SECTION_IMAGE_TITLES[key],
    }));

  // 제품명/브랜드는 프롬프트에 넣지 않는다(#11) — 카테고리(주제)만 맥락으로 쓴다.
  const topic = input.categoryName || '생활·쇼핑';
  return sections.map(({ key, title, summary }) => {
    const detail = summary ? ` ${summary}` : '';
    return {
      key,
      title,
      prompt:
        `${topic}에 관한 블로그 글의 "${title}" 섹션에 어울리는 본문 삽입용 이미지${detail}. ` +
        '글의 내용을 떠받치는 배경·환경·사람의 활동·정보 정리 장면으로 구성하고, ' +
        '제품 자체나 브랜드를 묘사하지 않는다(어떤 특정 제품인지 식별 불가). ' +
        STYLE_SUFFIX,
    };
  });
}

/**
 * 생성된 이미지 경로(또는 URL) 배열을 섹션키에 순서대로 배정한다.
 * 경로가 keys보다 많으면 초과분은 버리고, 적으면 남는 키는 슬롯이 사라진다.
 */
export function buildSectionImageMap(
  paths: string[],
  keys: readonly SectionImageKey[] = SECTION_IMAGE_KEYS,
): Record<string, string> {
  const map: Record<string, string> = {};
  const limit = Math.min(paths.length, keys.length);
  for (let i = 0; i < limit; i++) {
    if (paths[i]) {
      map[keys[i]] = paths[i];
    }
  }
  return map;
}
