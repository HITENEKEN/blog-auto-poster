# 키워드 리서치 재구성: SCH_TRND + SHPP_INST (구현 완료 ✅)

> **목적**: 현재 블로그 검색(NAVER_SCH_BLOG) 카운트 기반 추정치로만 나오는 키워드 리서치를
> **검색어트렌드(SCH_TRND)** + **쇼핑인사이트(SHPP_INST)** 실데이터 기반으로 교체하고,
> **NAVER_SCH_BLOG**는 템플릿 벤치마킹 데이터로만 사용하도록 역할 분리.
> **계획**: 2026-08-28 / **구현 완료**: 2026-08-28

## 구현 결과 (계획 대비 차이 포함)

| 파일 | 변경 |
|---|---|
| `src/intelligence/TrendAnalysis.ts` (신규) | 순수 헬퍼: `classifyTrend`, `scaleVolume`, `isShoppingKeyword`, `pickShoppingCategory` — 유닛 테스트 대상 |
| `src/intelligence/NaverApiHubProvider.ts` | trend/shopping 클라이언트, `research()` 3단계 재구성, `getSearchTrend`/`getShoppingKeywordTrend` |
| `src/content/PostAssembler.ts` | `keywordInsight` 주입 (`trend`/`trendLabel`/`trendSeries`/`shoppingCategory`/`shoppingRatio`/`relatedKeywords`) |
| `templates/*.hbs` (5종) | `keywordInsight` optionalFields + "요즘 인기 추이" 섹션 |
| `config/*.yaml`, `config/e2e/default.yaml` | `searchTrend`/`shoppingInsight`/`trendAnchor`/`shoppingSignals`/`shoppingCategoryPool` |
| `e2e/mock/naver-hub-mock.mjs` | `POST /search-trend/v1/search`, `POST /shopping/v1/category/keywords` 핸들러 |
| `tests/unit/trend-analysis.test.ts` (신규) | trend 분류/리스케일/선별기/probe 선정 14 케이스 |

**계획 대비 결정 차이**

1. **volume 스케일 통일**: 계획서의 단일 조회(×1000)와 배치 리스케일(/anchor×1000) 공식이 상충했음.
   구현은 **모든 요청에 anchor 키워드(`keywords.trendAnchor`, 기본 '쇼핑')를 공통 포함**하고
   `scaleVolume = 키워드피크/앵커피크 × 1000` (0..1000)으로 통일 — 단일 그룹 요청은 항상 피크 100이라
   anchor 없이는 비교 불가능하기 때문.
2. **`estimateVolumeFromResults()` 유지**: 계획은 제거였으나, SCH_TRND 비활성/실패 시 블로그 폴백
   (`metadata.volumeBasis: 'blog-estimate'`)에 필요해 유지. 주 경로에서는 미사용.
3. `keywords.shoppingCategoryPool`은 기본 빈 배열 — 실제 cat_id를 넣기 전까지 probe는 생략됨.

**검증**: `tsc` 빌드 성공, vitest 14 통과, playwright e2e 13 통과,
mock 대상 스모크에서 SCH_TRND 볼륨/트렌드·SHPP_INST 카테고리 채택(쇼핑 키워드만) 확인.
실제 API 스모크(`npm run cli -- research "무선청소기"`)는 NCP 키로 1회 실행해 확인할 것.

---

## 1. 현황 (As-Is)

| 항목 | 현재 구현 | 문제 |
|---|---|---|
| 볼륨 | `estimateVolumeFromResults()` — `log10(블로그 검색 total)×3000` (`NaverApiHubProvider.ts:404-410`) | 실제 검색량 아님. 블로그 검색 결과 수 추정치 |
| 트렌드 | 블로그 postdate 분포 휴리스틱 (`:443-470`) | 실제 검색 추이 아님 |
| 경쟁도 | 최근 6개월 포스트 비율 (`:415-438`) | 블로그 검색 기반 — 유지 가능 |
| 연관 키워드 | 블로그 제목/설명 TF (`:370-398`) | 블로그 검색 기반 — 유지 가능 |
| 쇼핑 데이터 | 없음 | 쿠팡 파트너스 콘텐츠인데 쇼핑 수요 반영 불가 |
| 템플릿 데이터 | `topPosts`(블로그 벤치마크) + LLM 경험 카피 (`PostAssembler.ts:141-174`) | 트렌드/쇼핑 인사이트 미주입 |

`research()`는 `/search/v1/blog` 1개 엔드포인트만 호출한다 (`:279`).
SCH_TRND / SHPP_INST는 코드에 존재하지 않는다.

## 2. API 스펙 (To-Be 데이터 소스)

공식 문서 확인 완료 (2026-08-28 기준).

### SCH_TRND — 검색어 트렌드 조회
- `POST https://naverapihub.apigw.ntruss.com/search-trend/v1/search`
- 바디: `startDate`, `endDate` (`yyyy-mm-dd`, 2016-01-01 이후), `timeUnit`(`date|week|month`),
  `keywordGroups` (최대 **5그룹**, 각 그룹 `groupName` + `keywords` 최대 20개), 선택 `device|gender|ages`
- 응답: `results[].data[]` = `{ period, ratio }` — **구간 내 최대=100 상대비율** (절대 검색량 아님)
- 인증: `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` (기존과 동일 키)

### SHPP_INST — 쇼핑 인사이트 (키워드별 트렌드)
- `POST https://naverapihub.apigw.ntruss.com/shopping/v1/category/keywords`
  - 바디: 기간/`timeUnit` 동일 + `category` (쇼핑 분야 코드 — 네이버쇼핑 URL의 `cat_id`) **필수**,
  `keyword` 배열 최대 5쌍 (`{ name, param: [검색어 1개] }`)
- **카테고리 사전 매핑 없음** — SCH_TRND 선정 키워드 중 쇼핑 관련 키워드를 선별하고,
  후보 카테고리 풀 probe(§3.2)로 키워드별 카테고리를 동적 선정한다.
- 응답: `results[].data[]` = `{ period, ratio }` — 쇼핑 클릭량 상대비율

### NAVER_SCH_BLOG — 블로그 검색 (역할 축소)
- `GET /search/v1/blog` — **이미 구현됨** (`searchBlog()`)
- 키워드 리서치의 볼륨/트렌드 소스에서 **제외**하고, 아래 용도로만 유지:
  1. 경쟁도 계산 (최근 6개월 포스트 비율)
  2. 연관 키워드 추출
  3. 템플릿 벤치마크(topPosts) + SEO 키워드

## 3. 변경 설계

### 3.1 `NaverApiHubKeywordProvider` 확장 (`src/intelligence/NaverApiHubProvider.ts`)

현재 HTTP 클라이언트 baseURL이 `.../search/v1`로 고정(`:250`)이라
트렌드/쇼핑 경로와 베이스가 다르다. 클라이언트 2개 추가:

```ts
private trendClient = createHttpClient({ baseURL: 'https://naverapihub.apigw.ntruss.com/search-trend/v1', ... });
private shoppingClient = createHttpClient({ baseURL: 'https://naverapihub.apigw.ntruss.com/shopping/v1', ... });

async getSearchTrend(groups: TrendKeywordGroup[], opts?: { months?: number }): Promise<TrendResult[]>
  // POST /search — 월간 12개월 기본, ratio 시계열 반환
async getShoppingKeywordTrend(category: string, keywords: Array<{name: string; param: string[]}>): Promise<TrendResult[]>
  // POST /category/keywords
```

각각 캐시: `getCache<TrendResult[]>('naver-api-hub-trend' / '-shopping')`, TTL 24h (월간 데이터라 안전).

```
[1단계] SCH_TRND 선정
  후보 키워드 전체(시드 + 연관) → 12개월 monthly ratio
  → trend(rising|falling|stable) + volumeScore 산출
  → 트렌드 스코어 순 정렬 (Top N 키워드 선정)

[2단계] 쇼핑 관련 키워드 선별 (규칙 기반, API 호출 없음)
  1단계 결과에서 keywords.shoppingSignals 패턴 매칭
  (추천/가격/최저가/리뷰/랭킹/비교/순위/가성비 …)
  → SHPP_INST 조회 대상 키워드 확정, 나머지는 shopping 데이터 없이 진행

[3단계] SHPP_INST 카테고리 probe (선별 키워드에만)
  keywords.shoppingCategoryPool 후보 카테고리 × 선별 키워드 청크(최대 5쌍/요청)
  → 카테고리별 클릭 ratio 조회
  → 응답 ratio 최대 카테고리를 해당 키워드의 카테고리로 채택
  → metadata.shoppingCategory / shoppingRatio 기록
  (전 카테고리에서 ratio 0/빈 응답 또는 오류 → shopping 데이터 없이 skip, try/catch)

키워드별 병합 (NAVER_SCH_BLOG: 경쟁도 + 연관 키워드, 기존 로직 유지)
→ KeywordData { volume: volumeScore, competition, trend, related,
                metadata: { trendSeries, volumeBasis: 'search-trend',
                            shoppingCategory, shoppingRatio, totalResults, topBlogs } }
```

**쇼핑 관련 키워드 선별기** (`isShoppingKeyword(kw)`): 순수 규칙 함수 —
`shoppingSignals` 목록 중 하나라도 포함하면 쇼핑 키워드. LLM 호출 없음(비용 0, 결정론적).
쇼핑 키워드가 아닌 트렌드 키워드는 SHPP_INST를 호출하지 않는다 (쿼리 절약).

- **trend 산출**: 최근 3개월 ratio 평균 vs 이전 9개월 평균, ±20% 임계 (기존 기준 재사용).
- **volume 산출 (결정 사항)**: SCH_TRND는 절대 검색량을 주지 않는다(상대 ratio).
  - 단일 키워드 조회(`npm run cli -- research "무선청소기"`, `/api/keywords/trending?q=`): 그룹 1개 요청 → `ratio` 그대로 × 1000 스케일 → `volume`.
  - Top-20 배치(`/api/keywords/top`): 각 청크(최대 5그룹)에 **anchor 시드 키워드를 공통 포함**하고,
    `rescaled = ratio / anchorMaxRatio * 1000`으로 청크 간 비교 가능하게 정규화.
    anchor는 `keywords.topSeeds[0]` 사용.
- `estimateVolumeFromResults()` 제거 (dead code — 블로그 카운트 추정은 역할 종료).
- 랭킹 공식 `volume*(1-competition)`(`Keywords.tsx`, `routes/index.ts:256`)은 그대로 유지 — 스케일만 바뀜.

### 3.3 템플릿 데이터 흐름 (NAVER_SCH_BLOG → 템플릿 업데이트)

`PostAssembler.prepareTemplateData()` (`PostAssembler.ts:101-177`) 확장:

- 신규 optional 필드 `keywordInsight` 주입:
  ```ts
  keywordInsight = {
    keyword,                    // benchmarkKeyword || 상품명
    trend,                      // SCH_TRND 'rising'|'falling'|'stable'
    trendSeries,                // [{period, ratio}] — SCH_TRND 월간
    shoppingCategory, shoppingRatio, // SHPP_INST (probe로 선정된 카테고리)
    relatedKeywords,            // 블로그 검색 기반 (기존 extractRelatedKeywords)
  }
  ```
- 기존 `topPosts` (NAVER_SCH_BLOG 벤치마크, `fetchBenchmarkPosts` `:190-215`) 유지 —
  여기에 SCH_TRND/SHPP_INST 결과를 함께 묶어 `keywordInsight`로 템플릿에 전달.
- `seoData.keywords`에 related 키워드 반영 (SEO 메타 강화).
- 템플릿 5종(`templates/*.hbs`) 업데이트:
  - `optionalFields`에 `keywordInsight` 추가
  - 조건부 "요즘 인기 추이" 섹션 추가 (`{{#if keywordInsight}}`) — 상승/하락 문구 + 연관 키워드 칩.
    `topPosts` 벤치마크 섹션은 이미 존재(`coupang-buying-guide.hbs:88`, `coupang-comparison-guide.hbs:128`,
    `coupang-partner-review.hbs:172`, `coupang-product-review.hbs:164`) — 그대로 유지.
  - `naver-coupang-review.hbs`도 동일 패턴 적용.

### 3.4 설정

`config/default.yaml`:

```yaml
keywordProviders:
  naver-api-hub:
    searchTrend: true        # SCH_TRND 사용
    shoppingInsight: true    # SHPP_INST 사용
keywords:
  topSeeds: ['무선청소기', '로봇청소기', '공기청정기', '가습기']
  shoppingSignals: ['추천', '가격', '최저가', '리뷰', '랭킹', '비교', '순위', '가성비']  # 쇼핑 관련 키워드 판별 패턴 (§3.2 2단계)
  shoppingCategoryPool:      # SHPP_INST probe 후보 카테고리 (cat_id = 네이버쇼핑 URL cat_id, 예시)
    - { name: '가전디지털', category: '50000158' }
    - { name: '주방용품', category: '50000159' }
```

- `KeywordProviderConfig`에 `searchTrend?`, `shoppingInsight?` 플래그 추가 (`src/core/interfaces.ts`).
- `config/test.yaml`, `e2e/config/e2e/default.yaml`에도 동일 키(false) 추가.
- 트렌드/쇼핑 API 비활성 시 기존 블로그 기반 휴리스틱으로 폴백 (호환성 유지).

### 3.5 모킹/테스트

- `e2e/mock/naver-hub-mock.mjs`에 핸들러 추가:
  - `POST /search-trend/v1/search` → 고정 ratio 시계열 (rising 패턴)
  - `POST /shopping/v1/category/keywords` → 고정 클릭 추이
- 유닛 테스트 (`tests/`):
  - ratio 시계열 → trend 분류 (±20% 경계값 포함)
  - anchor 리스케일 정확성 (두 청크에서 같은 키워드가 같은 score)
  - 쇼핑 키워드 선별기 (signals 매칭/비매칭 경계)
  - probe: 최고 ratio 카테고리 채택 / 전 카테고리 미검출 시 graceful skip / probe 오류 try/catch
  - SCH_TRND 실패 시 블로그 폴백 유지

### 3.6 파일 변경 목록

| 파일 | 변경 |
|---|---|
| `src/intelligence/NaverApiHubProvider.ts` | trend/shopping 클라이언트 + research 재구성(쇼핑 키워드 선별기, 카테고리 probe) + `estimateVolumeFromResults` 제거 |
| `src/core/interfaces.ts` | `KeywordProviderConfig` 플래그, `KeywordData.metadata` 스키마 주석 |
| `src/core/config.ts` | 신규 config 키 기본값 |
| `src/content/PostAssembler.ts` | `keywordInsight` 주입 |
| `templates/*.hbs` (5종) | `keywordInsight` optionalFields + 추이 섹션 |
| `config/default.yaml` / `test.yaml` / `e2e/.../default.yaml` | 키 추가 |
| `e2e/mock/naver-hub-mock.mjs` | 2개 엔드포인트 핸들러 |
| `tests/` | 유닛 테스트 |
| `documents/01-overview.md` 등 | 데이터 흐름 표 갱신 (구현 완료 후) |

## 4. 검증 계획

1. 유닛: `npm test` (trend 분류, 리스케일, skip/폴백)
2. e2e: `npx playwright test e2e/keywords.spec.ts` — TOP 20 카드가 mock 트렌드 데이터로 렌더링
3. 실 API 스모크:
   ```bash
   npm run build && npm run cli -- research "무선청소기" --limit=5
   ```
   - 출력 `Volume`이 SCH_TRND ratio 기반 값인지 (블로그 total 로그 기반이 아니라 metadata.volumeBasis로 확인)
   - NCP 콘솔에서 SCH_TRND/SHPP_INST 호출 건수 증가 확인
4. 템플릿 미리보기: 대시보드 Templates 페이지에서 `keywordInsight` 섹션 렌더링 확인

## 5. 리스크 / 열린 질문

| 항목 | 내용 | 기본 결정 |
|---|---|---|
| ratio 절대값 부재 | SCH_TRND는 상대값만 제공. 절대 검색량 불가 | volume을 "트렌드 스코어(상대)"로 명시. anchor 리스케일로 Top-20 비교 가능 |
| SHPP_INST 카테고리 | 키워드가 어느 쇼핑 분야에 속하는지 API가 직접 알려주지 않음 | 규칙 기반 쇼핑 키워드 선별 후 후보 카테고리 풀 probe로 최고 ratio 카테고리 동적 선정. 풀은 config로 관리(초기 5~10개 권장) |
| probe 비용 | 후보 카테고리 수 × 키워드 청크(5개) 만큼 SHPP_INST 호출 | 쇼핑 키워드에만 probe + 24h 캐시 + 풀 상한(config, 기본 10) |
| 쿼리 한도 | 검색 API 일 25,000회 / DataLab 계열 일 할당량 | 캐시 24h + 월간 timeUnit으로 호출 최소화 |
| 블로그 검색 종료 공지 | 쇼핑·책 검색은 2026-07-31 종료, 블로그 검색은 개발자센터 2027-06-30까지 | 현재 전부 API Hub 경로라 영향 없음 — 구조 유지가 정답 |
