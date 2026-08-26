# 네이버 API Hub 연동 (구현 완료 ✅)

> **목적**: 네이버 API Hub(`naverapihub.apigw.ntruss.com`)을 통한 키워드 검색 + 블로그 검색으로 콘텐츠 생성 품질 향상  
> **API 인증**: `X-NCP-APIGW-API-KEY-ID` / `X-NCP-APIGW-API-KEY` (secrets.yaml에 설정됨)  
> **구현 완료**: 2026-08-26

---

## 구현 결과

### 신규 파일
| 파일 | 설명 |
|------|------|
| `src/intelligence/NaverApiHubProvider.ts` | `NaverApiHubKeywordProvider` + `NaverApiHubBlogAnalyzer` |
| `scripts/path-alias.js` | 런타임 `@core/*` path alias resolver |

### 수정된 파일
| 파일 | 변경 내용 |
|------|-----------|
| `config/secrets.yaml` | YAML 형식으로 NCP API 키 설정 |
| `src/core/interfaces.ts` | `KeywordProviderConfig.useApiHub` 플래그 추가 |
| `src/core/config.ts` | `NAVER_API_HUB` 환경변수 오버라이드 추가 |
| `src/intelligence/index.ts` | `NaverApiHubProvider` export 추가 |
| `src/cli/index.ts` | research 명령을 API Hub로 교체 (기존 stub 제거) |
| `package.json` | scripts에 path-alias resolver 등록 |

### 기존 코드 유지
기존 `NaverKeywordProvider`(DataLab 방식)와 `NaverBlogAnalyzer`(openapi.naver.com 방식)는 삭제하지 않고 유지합니다. 향후 다른 프로젝트에서 재사용 가능합니다.

---

## 아키텍처

```
npm run cli -- research "무선청소기"
         │
         ▼
┌──────────────────────────────┐
│  ConfigManager.load()        │
│  → secrets.yaml 읽기         │
│  → keywordProviders          │
│    .naver-api-hub.apiKey     │
│    .naver-api-hub.apiSecret  │
└──────────┬───────────────────┘
           ▼
┌───────────────────────────────────────────────┐
│  NaverApiHubKeywordProvider                   │
│  baseUrl: naverapihub.apigw.ntruss.com/v1     │
│  headers: X-NCP-APIGW-API-KEY-ID / KEY        │
├───────────────────────────────────────────────┤
│  GET /blog?query=무선청소기&sort=sim          │ ← 블로그 검색
│  → total, items[], postdate[]                 │
│                                               │
│  estimateVolume()   → log10(total) * 3000     │
│  calculateCompetition() → 최근 6개월 포스트 비율│
│  calculateTrend()   → 3개월 vs 9개월 포스트 비율│
│  extractRelatedKeywords() → 제목+설명 TF       │
└──────────┬────────────────────────────────────┘
           ▼
    KeywordData[] 출력
```

## 사용법

```bash
# 빌드 후 실행
npm run build
npm run cli -- research "무선청소기" --limit=20

# 또는 직접 실행
node -r ./scripts/path-alias.js dist/cli/index.js research "무선청소기"
```

## 테스트 결과 (2026-08-26)

```
$ npm run cli -- research "무선청소기" --limit=5

=== Keyword Research Results ===
  Keyword:    무선청소기
  Volume:     ~17,864
  Competition:██░░░░░░░░ 20%
  Trend:      stable
  Related:    청소, 청소기, 코드제로, 건식진공청소기...

=== Blog Search Results ===
  Total results: 900,676
```

---

## secrets.yaml 설정

```yaml
keywordProviders:
  naver-api-hub:
    enabled: true
    apiKey: "m8gv2ia7pq"                    # X-NCP-APIGW-API-KEY-ID
    apiSecret: "1AeVlPZgo..."               # X-NCP-APIGW-API-KEY
    baseUrl: "https://naverapihub.apigw.ntruss.com/search/v1"
    useApiHub: true
```

---

## 웹 대시보드 확장 (Part B/C)

`12-dashboard-keywords-template-plan.md` 참조.

**완료된 항목:**
- [x] 파트너스 최적화 템플릿 3종 (`coupang-partner-review.hbs`, `coupang-comparison-guide.hbs`, `coupang-buying-guide.hbs`)
- [x] 템플릿 CRUD API (`/api/templates/*`)
- [x] 키워드 trending/research API (`/api/keywords/trending`, `/api/keywords/:keyword/blogs`)
- [x] `Keywords.tsx` 재작성 (API Hub 인기 키워드 + 경쟁 블로그 분석)
- [x] `Templates.tsx` 재작성 (CRUD + Handlebars 에디터 + 데스크톱/모바일 미리보기)
- [x] 백엔드 TypeScript 컴파일 성공
- [x] 프론트엔드 Vite 프로덕션 빌드 성공