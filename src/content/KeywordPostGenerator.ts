import { getLogger } from '@core/logger';
import { PostContent, PostStatus, AffiliateProduct, TemplateRenderResult } from '@core/interfaces';
import { createTemplateEngine, TemplateEngineImpl } from './TemplateEngine';
import {
  resolveImageGenerator,
  generateImagesSafely,
  resolveGeminiImageConfig,
  interleaveImageSpecs,
} from './ImageGenerator';
import { buildProductImagePrompts, buildSectionImageSpecs } from './imagePrompts';
import { createPostAssembler } from './PostAssembler';
import { createContentGeneratorFromConfig } from './ContentGenerator';
import { fetchTopPosts, fetchKeywordInsight } from './InsightFetch';
import { savePostFiles } from './postStorage';

const logger = getLogger('keyword-post-generator');

/** routes가 쓰는 것과 동일한 createTemplateEngine 팩토리의 모듈 싱글턴 */
let templateEngineSingleton: TemplateEngineImpl | null = null;
function getTemplateEngine(): TemplateEngineImpl {
  if (!templateEngineSingleton) {
    templateEngineSingleton = createTemplateEngine('./templates');
  }
  return templateEngineSingleton;
}

/**
 * LLM 키가 없거나 생성 실패 시 사용하는 필드별 폴백 값.
 * text 필드는 키워드 기반 기본 문장, 배열/객체 필드는 제네릭 항목.
 */
export function defaultFieldValues(keyword: string): Record<string, unknown> {
  return {
    experienceIntro: `${keyword}를 오래 찾아보다가 결국 제가 직접 써보게 되었어요. 이 글에는 그때의 솔직한 사용 경험을 담았습니다.`,
    realUsageStory: `제가 직접 ${keyword}를 사용해 본 결과, 실제로 체감하는 장점과 아쉬운 점을 구체적으로 정리했습니다. 실사용 중심으로 확인해 보세요.`,
    whyIChoseIt: `여러 대안을 비교한 끝에 ${keyword}를 선택했습니다. 가격 대비 성능과 사용 편의성을 기준으로 비교해 보셔도 좋겠어요.`,
    conclusion: `${keyword}에 대한 총평을 정리하면, 무난하게 만족스러운 선택이었다고 말씀드릴 수 있습니다. 구매 전 아래 체크리스트도 함께 확인해 보세요.`,
    description: `${keyword}에 대해 직접 사용해 본 솔직한 후기를 정리했습니다.`,
    intro: `${keyword}를 찾고 계신가요? 제가 직접 사용해 보고 정리한 기준과 후기를 소개합니다.`,
    oneLineReview: `${keyword}, 직접 써본 결과 가성비와 편의성의 균형이 괜찮았습니다.`,
    pros: ['가성비가 좋음', '사용이 간편함'],
    cons: ['세부 기능 아쉬움'],
    usageTips: [
      '사용 전 설명서의 기본 설정을 먼저 확인하세요.',
      '정기적인 관리로 수명을 늘릴 수 있습니다.',
      '사용 후에는 깨끗하게 보관하는 것이 좋습니다.',
    ],
    buyingChecklist: [
      '예산 범위를 먼저 정해 보세요.',
      '실사용 후기를 비교해 보세요.',
      '사후 관리(A/S) 조건을 확인하세요.',
    ],
    targetAudience: ['합리적인 가격의 제품을 찾는 분', '처음 구매를 고민하는 분'],
    faqList: [
      {
        question: '초보자도 사용하기 쉬운가요?',
        answer: '기본 사용법이 간단해서 처음에도 무난하게 사용했습니다.',
      },
      {
        question: '가격대는 어느 정도인가요?',
        answer: '실제 가격은 변동이 있으니 쿠팡에서 최신 가격을 확인해 주세요.',
      },
      {
        question: '사후 관리는 어떤가요?',
        answer: '제조사 A/S 정책을 구매 전에 함께 확인해 보시길 권합니다.',
      },
    ],
    checklist: [
      { title: '예산 확인', description: '지출 가능한 범위를 먼저 정해 두면 비교가 쉬워집니다.' },
      { title: '필수 기능 확인', description: '실제 사용 목적에 맞는 기능인지 확인하세요.' },
      { title: '후기 비교', description: '실사용 후기를 여러 개 비교해 보고 선택하세요.' },
    ],
    mistakesToAvoid: [
      { title: '가격만 보고 선택하기', description: '내구성과 사후 관리까지 함께 고려하세요.' },
      {
        title: '후기 무시하기',
        description: '실사용 후기의 반복적인 불만 포인트는 중요한 신호입니다.',
      },
      {
        title: '설명서 넘기기',
        description: '기본 설정만 잘 확인해도 사용 경험이 크게 달라집니다.',
      },
    ],
    budgetSteps: [
      {
        range: '1~3만원',
        productName: `${keyword} 보급형`,
        reason: '기본 기능만 가볍게 사용할 경우 합리적인 선택입니다.',
        affiliateUrl: '',
      },
      {
        range: '3~10만원',
        productName: `${keyword} 중급형`,
        reason: '가격 대비 성능의 균형이 좋아 가장 무난한 선택입니다.',
        affiliateUrl: '',
      },
    ],
    budgetRanges: [
      {
        range: '1~3만원',
        productName: `${keyword} 보급형`,
        reason: '기본 기능 위주로 사용하기에 충분합니다.',
      },
      {
        range: '3~10만원',
        productName: `${keyword} 중급형`,
        reason: '성능과 가격의 균형이 좋습니다.',
      },
    ],
    recommendations: [
      {
        title: '가성비 추천',
        productName: `${keyword} 중급형`,
        reason: '가격 대비 성능의 균형이 가장 좋았습니다.',
      },
      {
        title: '입문 추천',
        productName: `${keyword} 보급형`,
        reason: '부담 없는 가격으로 시작하기 좋습니다.',
      },
    ],
    products: [
      {
        name: `${keyword} 대안 A`,
        price: 0,
        brand: '',
        description: '기본 기능 중심의 보급형 선택지입니다.',
        pros: ['가격이 부담스럽지 않음'],
        cons: ['세부 기능 아쉬움'],
        affiliateUrl: '',
      },
      {
        name: `${keyword} 대안 B`,
        price: 0,
        brand: '',
        description: '성능과 편의 기능을 더한 중급 선택지입니다.',
        pros: ['사용이 간편함'],
        cons: ['가격대가 다소 높음'],
        affiliateUrl: '',
      },
    ],
    topPick: {
      productName: `${keyword} 대안 A`,
      reason: '종합적으로 가격 대비 만족도가 가장 높았습니다.',
      affiliateUrl: '',
    },
    comparisonTable: {
      columns: ['대안 A', '대안 B'],
      rows: [
        { label: '가격', values: ['부담 없음', '다소 높음'] },
        { label: '사용 편의성', values: ['기본적', '편리함'] },
      ],
    },
    specs: {},
    price: 0,
  };
}

/** generatePlatformContent 호출용 최소 AffiliateProduct 스텁 (platformContent 조립에만 사용) */
function stubProductFor(keyword: string): AffiliateProduct {
  return {
    id: `keyword:${keyword}`,
    name: keyword,
    price: 0,
    currency: 'KRW',
    productUrl: '',
    categoryId: '',
    categoryName: keyword,
    availability: 'in_stock',
  };
}

/**
 * 키워드 → AI(또는 폴백) 템플릿 데이터 → 렌더 → DRAFT PostContent → 파일 저장.
 * LLM 키가 없으면 DEFAULT_FIELD_VALUES 폴백으로라도 드래프트를 보장한다.
 * 템플릿 로드/렌더 실패는 그대로 throw한다(라우트가 500 반환).
 */
export async function generateDraftFromKeyword(input: {
  keyword: string;
  templateName: string;
  /**
   * 기존 드래프트(비동기 생성 플레이스홀더)를 같은 id로 교체 저장할 때 사용.
   * 미지정 시 기존처럼 새 id를 생성한다.
   */
  postId?: string;
  /**
   * 저장 직전 취소 확인 — true면 파일을 쓰지 않고 중단한다(DELETE 취소 계약).
   * 이 경우 드래프트는 저장되지 않고 상태 기록도 없다.
   */
  isCancelled?: () => boolean;
}): Promise<PostContent> {
  const { keyword, templateName, postId } = input;
  const templateEngine = getTemplateEngine();
  await templateEngine.loadTemplates();

  const info = templateEngine.getTemplateInfo(templateName);
  if (!info) {
    throw new Error(`Template not found: ${templateName}`);
  }
  const fields = [...info.requiredFields, ...(info.optionalFields ?? [])];

  const topPosts = await fetchTopPosts(keyword, 10);
  const generator = createContentGeneratorFromConfig();
  const defaults = defaultFieldValues(keyword);
  // LLM 초안 생성과 키워드 인사이트 조회는 서로 독립 — 병렬로 가져와 총 응답 시간을 단축한다.
  const [generatedRaw, keywordInsight] = await Promise.all([
    generator.generateTemplateData({ keyword, topPosts, fields, templateName }),
    fetchKeywordInsight(keyword),
  ]);
  let generated = generatedRaw;
  if (generated === null) {
    generated = { ...defaults };
  }
  // 검증에서 탈락한 필드는 폴백으로 채워 requiredFields 누락 ValidationError를 방지
  for (const field of fields) {
    if (!(field in generated) && field in defaults) {
      generated[field] = defaults[field];
    }
  }

  const templateData: Record<string, unknown> = {
    ...generated,
    productName: keyword,
    categoryName: keyword,
    price: typeof generated.price === 'number' ? generated.price : 0,
    currency: 'KRW',
    productUrl: '',
    // 템플릿 requiredFields 검증이 빈 문자열을 거부하므로 자리표시자 사용 —
    // 실제 링크는 에디터에서 쿠팡 위젯(상품 링크)으로 삽입됨
    affiliateUrl: '#',
    topPosts,
  };
  // R5 이미지 생성: 이미지 프로바이더(openai→gemini)가 설정된 경우에만 상품+섹션 프롬프트로 생성한다.
  // 미설정/실패 시 images 없이 진행(경고 로그) — placeholder 네트워크 호출·글 발행 지연 없음.
  // 스펙은 상품/섹션 교차 배치(#8) — generateImagesSafely의 maxImagesPerPost 상한이
  // 잘리더라도 상품 컷과 섹션 컷이 균형 있게 남도록 한다.
  const imageGenerator = resolveImageGenerator('./output/images');
  const images = resolveGeminiImageConfig()
    ? await generateImagesSafely(
        imageGenerator,
        interleaveImageSpecs(
          buildProductImagePrompts({ productName: keyword, categoryName: keyword }).map(
            (prompt) => ({ prompt }),
          ),
          buildSectionImageSpecs({ productName: keyword, categoryName: keyword })
            .slice(0, 3)
            .map((spec) => ({ key: spec.key, prompt: spec.prompt })),
        ),
      )
    : { urls: [], localPaths: [], sectionImages: {} };
  templateData.sectionImages = images.sectionImages;
  if (images.localPaths.length > 0) {
    templateData.imageUrl = images.localPaths[0];
  }

  if (keywordInsight) {
    templateData.keywordInsight = keywordInsight;
  }

  const renderResult: TemplateRenderResult = await templateEngine.render(
    templateName,
    templateData,
  );

  const postAssembler = createPostAssembler(templateEngine, imageGenerator);
  const platformContent = postAssembler.generatePlatformContent(
    renderResult,
    undefined,
    stubProductFor(keyword),
  );

  const now = new Date().toISOString();
  const post: PostContent = {
    id: postId ?? `post-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    template: templateName,
    productId: `keyword:${keyword}`,
    platform: 'unknown',
    status: 'DRAFT' as PostStatus,
    title: renderResult.title,
    content: renderResult.content,
    meta: renderResult.meta,
    tags: renderResult.tags,
    categories: renderResult.categories,
    platformContent,
    affiliateUrl: '',
    images: images.localPaths,
    createdAt: now,
    updatedAt: now,
  };

  // DELETE 등으로 취소된 생성은 파일을 쓰지 않고 중단한다(좀비 부활 방지, 상태 기록 없음).
  if (input.isCancelled?.()) {
    logger.info(
      { postId: post.id, keyword, template: templateName },
      'Keyword draft generation cancelled before save',
    );
    return post;
  }

  savePostFiles(post);
  logger.info({ postId: post.id, keyword, template: templateName }, 'Draft generated from keyword');
  return post;
}
