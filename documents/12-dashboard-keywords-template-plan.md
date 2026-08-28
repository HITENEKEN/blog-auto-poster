# 웹 대시보드 확장 (구현 완료 ✅)

> **목적 1**: 네이버 API Hub 키워드 검색으로 인기 키워드를 뽑는 화면을 웹 대시보드에 추가  
> **목적 2**: 쿠팡 파트너스 가이드 기반 블로그 템플릿을 작성하고 대시보드에서 미리보기/편집 가능하게 구현  
> **구현 완료**: 2026-08-26

---

## 구현 결과 요약

| 항목                                   | 상태 | 파일                                      |
| -------------------------------------- | ---- | ----------------------------------------- |
| 파트너스 최적화 템플릿 3종             | ✅   | `templates/coupang-partner-review.hbs` 등 |
| 템플릿 CRUD API (7개 엔드포인트)       | ✅   | `src/web/server/routes/index.ts`          |
| 키워드 trending/research API (API Hub) | ✅   | `src/web/server/routes/index.ts`          |
| Keywords.tsx 재작성 (API Hub 연동)     | ✅   | `src/web/client/src/pages/Keywords.tsx`   |
| Templates.tsx 재작성 (CRUD + 미리보기) | ✅   | `src/web/client/src/pages/Templates.tsx`  |
| 백엔드 TypeScript 빌드                 | ✅   | `npm run build`                           |
| 프론트엔드 Vite 프로덕션 빌드          | ✅   | `npx vite build`                          |

---

## Part A: 인기 키워드 대시보드 화면

### 구현된 백엔드 API

**`GET /api/keywords/trending?q={키워드}&limit={N}`**

- 네이버 API Hub 블로그 검색 → 볼륨/경쟁도/트렌드 산출
- 경쟁 블로그 TOP N 반환

**`GET /api/keywords/:keyword/blogs?limit={N}&sort={sim|date}`**

- 특정 키워드의 경쟁 블로그 목록만 조회

**`POST /api/keywords/research`**

- `providers: ['naver-api-hub', 'coupang', ...]` 지원
- API Hub + legacy 프로바이더 결과 병합, 스코어 순 정렬

### 구현된 프론트엔드 (`Keywords.tsx`)

```
┌─────────────────────────────────────────────────────┐
│  검색어 입력 + [분석] 버튼                           │
├─────────────────────────────────────────────────────┤
│  📊 키워드 분석 결과                                 │
│  순위 | 키워드 | 추정검색량 | 경쟁도(바) | 트렌드 | 연관│
├─────────────────────────────────────────────────────┤
│  📝 경쟁 블로그 TOP N                                │
│  제목 / 블로거명 / 날짜 / URL                        │
└─────────────────────────────────────────────────────┘
```

---

## Part B: 쿠팡 파트너스 최적화 템플릿 3종

### 생성된 템플릿

| 파일                           | 이름                     | 용도             |
| ------------------------------ | ------------------------ | ---------------- |
| `coupang-partner-review.hbs`   | coupang-partner-review   | 단일 제품 리뷰형 |
| `coupang-comparison-guide.hbs` | coupang-comparison-guide | 다중 제품 비교형 |
| `coupang-buying-guide.hbs`     | coupang-buying-guide     | 초보자 가이드형  |

### 리뷰형 템플릿 구조 (10단계)

1. **한 줄 평** - 핵심 요약 (첫 3줄 이내)
2. **제품 헤더** - H1 + 카테고리/브랜드/평점 메타
3. **가격 카드** - 현재가/원가/할인율 + 첫 번째 CTA
4. **장단점 표** - ✅ 장점 vs ❌ 단점 좌우 비교
5. **상세 리뷰** - H2 소제목, 스펙 테이블
6. **비교 표** - 경쟁 제품과 나란히 비교 (옵셔널)
7. **추천 대상** - 타겟 독자 명시 (옵셔널)
8. **FAQ** - 검색 SEO (옵셔널)
9. **최종 CTA** - 두 번째 구매 링크 (배경 강조)
10. **파트너스 고지** - 법적 필수 문구

### 비교형 템플릿 구조

전체 비교표 → 개별 제품 카드(순위 뱃지+장단점 태그+CTA) → 예산별 추천 → 최종 추천 → FAQ → 고지

### 가이드형 템플릿 구조

체크리스트(numbered ✓ 아이콘) → 예산별 스텝 카드 → TOP PICK 강조박스 → 실수 방지 → FAQ → 고지

---

## Part C: 템플릿 관리 화면

### 구현된 백엔드 API

| 메서드 | 경로                           | 설명                         |
| ------ | ------------------------------ | ---------------------------- |
| GET    | `/api/templates`               | 목록 (frontmatter 자동 파싱) |
| GET    | `/api/templates/:name`         | 상세 (raw HBS 포함)          |
| POST   | `/api/templates`               | 생성                         |
| PUT    | `/api/templates/:name`         | 수정                         |
| DELETE | `/api/templates/:name`         | 삭제                         |
| POST   | `/api/templates/:name/preview` | 샘플 데이터 렌더링           |

### Preview 엔드포인트 기능

- Handlebars 헬퍼 자동 등록 (`formatPrice`, `renderStars`, `math`)
- 각 템플릿 유형별 기본 샘플 데이터 자동 주입
- 커스텀 샘플 데이터 오버라이드 가능

### 구현된 프론트엔드 (`Templates.tsx`)

**3가지 뷰 모드:**

1. **List View**: 카드 그리드 (플랫폼 배지, 필수필드 태그, 액션 버튼)
2. **Preview View**: iframe sandbox HTML 렌더링 + 데스크톱/모바일 전환
3. **Editor View**: 다크 테마 코드 에디터 + 저장/취소

---

## 빌드 검증 결과

```
$ npm run build          # 백엔드 TypeScript
✅ 성공 (0 errors)

$ npx vite build         # 프론트엔드 프로덕션
✅ built in 1.03s
   dist/index.html                   0.47 kB
   dist/assets/index-C2Q722Y3.css   23.87 kB
   dist/assets/index-Bwp6JS3-.js   324.74 kB
```
