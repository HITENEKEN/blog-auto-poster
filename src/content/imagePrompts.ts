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
}

/** 모든 프롬프트에 공통으로 붙는 한국어 블로그 스타일 접미사 (일관된 톤 유지) */
const STYLE_SUFFIX =
  '한국 쇼핑 블로그에 쓰는 실사 사진, 밝은 자연광, 깔끔한 단색 배경, 고해상도, 상업용 스톡사진 퀄리티, 텍스트·워터마크 없음.';

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

/** 기본 섹션 정의 (키 순서 = SECTION_IMAGE_KEYS와 일치) */
export function buildSectionImageSpecs(input: SectionImagePromptInput): SectionImageSpec[] {
  const sections =
    input.sections ??
    ([
      { key: 'usage', title: '직접 사용해 본 모습' },
      { key: 'specs', title: '주요 스펙과 구성품' },
      { key: 'compare', title: '경쟁 제품과의 비교' },
      { key: 'tips', title: '실전 활용 팁' },
      { key: 'checklist', title: '구매 전 체크리스트' },
    ] as Array<{ key: SectionImageKey; title: string; summary?: string }>);

  return sections.map(({ key, title, summary }) => {
    const target = input.productName || input.categoryName || '제품';
    const detail = summary ? ` ${summary}` : '';
    return {
      key,
      title,
      prompt: `${target}과(와) 관련된 "${title}"을(를) 보여주는 사진.${detail} ${STYLE_SUFFIX}`,
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
