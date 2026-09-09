import type { CoupangWidgetKind } from '../../content/CoupangWidgets';

export type { CoupangWidgetKind };

// URL 칸 입력 파서 — 에디터와 발행 파이프라인이 **같은 규칙**을 쓰도록 재노출한다
// (파트너스 배너 스니펫을 URL 칸에 붙여넣는 실제 사용 패턴을 양쪽에서 동일하게 처리).
export { isHttpUrl, isPublishableImageUrl, parseLinkInput } from '../../content/linkInput';
export type { ParsedLinkInput } from '../../content/linkInput';

/** 클라이언트(에디터 위젯 버튼/칩) 공용 위젯 라벨 — vite alias `@shared`로 import */
export const COUPANG_WIDGET_LABELS: Record<CoupangWidgetKind, string> = {
  'product-link': '상품 링크',
  'event-link': '이벤트/프로모션 링크',
  'dynamic-banner': '다이나믹 배너',
  'search-widget': '검색 위젯',
  'category-banner': '카테고리 배너',
  'ad-banner': '광고 배너',
};
