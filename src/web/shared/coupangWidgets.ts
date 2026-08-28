import type { CoupangWidgetKind } from '../../content/CoupangWidgets';

/** 클라이언트(에디터 위젯 버튼/칩) 공용 위젯 라벨 — vite alias `@shared`로 import */
export const COUPANG_WIDGET_LABELS: Record<CoupangWidgetKind, string> = {
  'product-link': '상품 링크',
  'event-link': '이벤트/프로모션 링크',
  'dynamic-banner': '다이나믹 배너',
  'search-widget': '검색 위젯',
  'category-banner': '카테고리 배너',
};
