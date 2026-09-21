/**
 * 광고 파이프라인 공용 타입 (설계 §3-1).
 *
 * 순수 모듈 — 네트워크·DB·fs에 의존하지 않는다. web 서버(배치·게이트)와
 * robot 프로세스(매칭·판정)가 같은 규칙을 쓴다. 인벤토리 저장은
 * `src/affiliates/AdInventory.ts`가 맡는다.
 */

/** 소재 출처 — manual(사람이 붙여넣은 파트너스 링크) | api(쿠팡 Open API) */
export type AdSource = 'manual' | 'api';

/** active만 배치 대상이다. dead/expired/removed는 매칭에서 제외된다(설계 §3-2). */
export type AdStatus = 'active' | 'dead' | 'expired' | 'removed';

/** 링크 생존 확인 결과(설계 §3-7) — 첫 리다이렉트만 본다. */
export interface AdCheckResult {
  ok: boolean;
  status: number | null;
  location: string | null;
  checkedAt: string;
}

export interface AdItem {
  id: string;
  source: AdSource;
  /** 소재 종류 — 지금은 'product-link'만 쓴다(이벤트/배너도 같은 테이블에 둔다) */
  kind: string;
  productName: string;
  /** 파트너스 트래킹 링크 (https://link.coupang.com/a/…) */
  url: string;
  imageUrl?: string;
  /** 표기 변형을 함께 담는다("트위드자켓", "트위드 자켓") — 정규화 전 원문 */
  keywords: string[];
  categoryId?: string;
  /** 소재 요청으로 등록된 경우 그 요청 id */
  requestId?: string;
  status: AdStatus;
  lastCheckedAt?: string;
  lastCheckResult?: AdCheckResult;
  usedCount: number;
  lastUsedAt?: string;
  /** api 소스만 — 이 시각이 지나면 매칭에서 제외한다 */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 글의 주제 — 매칭 입력(설계 §3-2). */
export interface AdTopic {
  keyword: string;
  categoryId?: string;
  /** 조상 카테고리 id 경로(루트 → 리프). 조상 일치 판정에 쓴다. */
  categoryPath?: string[];
}

/** 배치 정책 — config/default.yaml의 robot.ads가 이 셰이프로 덮어쓴다(설계 §6). */
export interface AdPolicy {
  /** 글 1건에 필요한 최소 상품 수 */
  minAds: number;
  minBlocks: number;
  maxBlocks: number;
  /** 몇 번째 h2 섹션 끝부터 배치 후보인가(1-based) */
  firstAfterSection: number;
  /** 광고끼리·하단 앵커와의 최소 섹션 간격 */
  minSectionGap: number;
  /** 묶음 상품 수 범위 [min, max] */
  bundleSize: [number, number];
  /** 가격 표시 여부 — 기본 false(가격은 수시로 바뀌고 발행 후 고칠 수 없다) */
  showPrice: boolean;
}

/** config/default.yaml robot.ads 기본값과 동일한 값. robot이 설정으로 덮어쓴다. */
export const DEFAULT_AD_POLICY: AdPolicy = {
  minAds: 2,
  minBlocks: 2,
  maxBlocks: 4,
  firstAfterSection: 2,
  minSectionGap: 2,
  bundleSize: [2, 3],
  showPrice: false,
};

/** 매칭 점수와 근거(설계 §3-2). */
export interface RankedAd {
  ad: AdItem;
  score: number;
  matchedBy: 'keyword' | 'category';
}

/** 배치 슬롯 — afterSection은 1-based h2 순번. */
export interface AdSlot {
  kind: 'single' | 'bundle';
  afterSection: number;
  sectionTitle: string;
  adIds: string[];
}

/** 발행 전 게이트 위반(설계 §3-6). code는 표의 왼쪽 열과 1:1 대응한다. */
export interface GateViolation {
  code: string;
  message: string;
  detail?: unknown;
}

/** 자동 배치 마커/고지를 구분하는 속성값 — 사용자가 직접 넣은 위젯과 섞이지 않게 한다. */
export const AUTO_AD_SOURCE = 'auto';

/** 묶음 앞에 붙는 고정 문구(설계 §3-4). LLM 문장을 쓰지 않는다. */
export const AD_BUNDLE_LEAD_TEXT = '함께 비교해 볼 만한 상품';
