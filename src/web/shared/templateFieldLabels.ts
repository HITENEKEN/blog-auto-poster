/**
 * 템플릿 frontmatter 필드 키 → 한국어 라벨 맵.
 *
 * src/web/shared에 두어 서버(`GET /api/templates` 응답 가공)와 클라이언트
 * (`Templates.tsx` 목록/편집 화면)가 **같은 규칙**을 쓰게 한다.
 * (hbsConvert.ts·coupangWidgets.ts가 이미 쓰는 shared 패턴.)
 *
 * 맵에 없는 키는 영문 키를 그대로 노출한다 — 새 필드가 생겨도 화면이 비지 않는다.
 */
export const TEMPLATE_FIELD_LABELS: Record<string, string> = {
  // 핵심 상품 정보
  productName: '상품명',
  price: '가격',
  originalPrice: '정가',
  discountRate: '할인율',
  rating: '평점',
  reviewCount: '리뷰 수',
  imageUrl: '대표 이미지 URL',
  brand: '브랜드',
  categoryName: '카테고리명',
  description: '상품 설명',
  affiliateUrl: '제휴 링크',
  productCount: '상품 개수',

  // 후기 본문 슬롯
  experienceIntro: '사용 계기',
  realUsageStory: '실사용 후기',
  whyIChoseIt: '선택 이유',
  usageTips: '실전 활용 팁',
  buyingChecklist: '구매 전 체크리스트',
  checklist: '체크리스트',
  conclusion: '총평',
  oneLineReview: '한 줄 평',
  pros: '장점',
  cons: '단점',
  specs: '주요 스펙',
  targetAudience: '추천 대상',
  faqList: '자주 묻는 질문',
  intro: '도입부',

  // 비교/가이드 전용
  products: '비교 상품 목록',
  comparisonTable: '비교표',
  budgetSteps: '예산별 추천',
  budgetRanges: '가격대별 추천',
  recommendations: '추천 정리',
  topPick: '베스트 추천 상품',
  mistakesToAvoid: '피해야 할 실수',

  // 인사이트/내부 연결
  topPosts: '연관 인기글',
  keywordInsight: '키워드 인사이트',
  tags: '태그',
  category: '분류',
  currentYear: '연도',
};

/** 필드 키의 한국어 라벨. 맵에 없으면 키를 그대로 돌려준다(영문 폴백). */
export function labelForTemplateField(key: string): string {
  return TEMPLATE_FIELD_LABELS[key] ?? key;
}
