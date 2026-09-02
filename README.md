# Blog Auto Poster

> 쿠팡 파트너스를 초기 타겟으로 하는 자동화된 블로그 포스팅 시스템  
> 티스토리, 워드프레스, 유튜브 쇼츠 발행 지원 | 확장 가능한 플러그인 아키텍처

---

## 📚 문서

| 문서                                                                                                   | 설명                                                                              |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| [`documents/NEXT_STEPS.md`](documents/NEXT_STEPS.md)                                                   | **⚡ 즉시 실행: 쿠팡 승인 후 5분 만에 자동화 시작**                               |
| [`documents/01-overview.md`](documents/01-overview.md)                                                 | 시스템 개요, 구현 상태, 핵심 특징, 지원 플랫폼, 자동화 파이프라인                 |
| [`documents/02-architecture.md`](documents/02-architecture.md)                                         | 디렉토리 구조, 모듈 의존성, 데이터 플로우, 핵심 인터페이스, 레지스트리 패턴       |
| [`documents/03-api.md`](documents/03-api.md)                                                           | REST API 엔드포인트, 인증, DTO, 요청/응답 예시, WebSocket, 에러 응답              |
| [`documents/04-tech-stack.md`](documents/04-tech-stack.md)                                             | 백엔드/프론트엔드/외부 API/개발 도구 기술 스택, 버전, 설정                        |
| [`documents/05-database.md`](documents/05-database.md)                                                 | SQLite 스키마 (jobs/job_logs/published_posts), 인덱스, Job 상태 전이, 재시도 정책 |
| [`documents/06-deployment.md`](documents/06-deployment.md)                                             | 사전 요구사항, 설치/설정/빌드/실행, PM2 운영, 헬스체크, 로그, 백업                |
| [`documents/07-roadmap.md`](documents/07-roadmap.md)                                                   | Phase 1~4 단계별 마일스톤, 우선순위 기준, 리스크 대응, 즉시 실행 체크리스트       |
| [`documents/08-extension-guide.md`](documents/08-extension-guide.md)                                   | 확장: 어댑터/템플릿/잡/CLI/웹페이지 추가 가이드                                   |
| [`documents/09-troubleshooting.md`](documents/09-troubleshooting.md)                                   | 인증/API/스케줄러/콘텐츠/웹/DB 문제 해결, 디버깅 팁, 긴급 대응                    |
| [`documents/10-naver-blog-bootstrap.md`](documents/10-naver-blog-bootstrap.md)                         | 네이버 블로그 부트스트랩: 수동 글 작성 → 쿠팡 승인 → 자동화 연동 가이드           |
| [`documents/11-naver-api-hub-plan.md`](documents/11-naver-api-hub-plan.md)                             | 네이버 API Hub 연동 구현 계획 (키워드 검색 + 블로그 검색)                         |
| [`documents/12-dashboard-keywords-template-plan.md`](documents/12-dashboard-keywords-template-plan.md) | **대시보드 확장: 인기 키워드 화면 + 쿠팡 파트너스 템플릿 구현 계획**              |

---

## 🚀 빠른 시작

```bash
# 1. 의존성 설치
cd blog-auto-poster
npm install --legacy-peer-deps

# 2. 프론트엔드 빌드
cd src/web/client && npm install && npm run build && cd ../..

# 3. 설정 파일 작성
cp config/default.yaml config/local.yaml
cp config/secrets.yaml.example config/secrets.yaml
# → config/secrets.yaml 에 실제 API 키 입력

# 4. 백엔드 빌드
npm run build

# 5. 실행
npm run cli -- config                    # 설정 위자드
npm run cli -- research "무선청소기"     # 키워드 리서치
npm run dev:web                          # 대시보드 (http://localhost:5173)
```

---

## 🛠️ 개발 워크플로

- `npm run dev:web` — 서버(tsc watch + 변경 시 자동 재시작, 포트 3005)와 클라이언트(vite dev, http://localhost:5173)를 동시에 띄웁니다. 소스 수정이 즉시 반영되며 `/api`, `/ws`는 vite 프록시로 dev 서버에 전달됩니다(PM2 운영 서버의 3002와 충돌하지 않습니다).
- `npm run dev:server` / `npm run dev:client` — 서버/클라이언트 각각 따로 띄울 때 사용합니다.
- `npm run test:e2e:fast` — 빌드를 건너뛰고 기존 `dist/`, `src/web/client/dist`를 재사용해 e2e만 실행합니다(빌드 포함 전체 경로는 `npm run test:e2e`).
- 전체 e2e는 사용자가 요청했을 때만 실행하고, 평소에는 위 dev 모드와 `npm run typecheck`, `npm test`(vitest)로 빠르게 검증합니다.

---

## 🏗️ 아키텍처 개요

```
src/
├── core/           # 설정, 로깅, 에러, HTTP, 캐시
├── affiliates/     # 쿠팡 파트너스 어댑터 (OAuth 2.0)
├── platforms/      # 티스토리, 워드프레스, 유튜브 쇼츠
├── content/        # 템플릿 엔진, 이미지 생성, 포스트 어셈블러
├── intelligence/   # 키워드 리서치, 경쟁 분석, 주제 선정
├── scheduler/      # SQLite 작업 큐 + node-cron 스케줄러
├── cli/            # Commander 기반 CLI
└── web/            # Fastify + React 관리자 대시보드
```

### 핵심 특징

- **모듈식 어댑터 패턴**: 제휴/플랫폼/이미지 프로바이더 교체 가능
- **TypeScript 엄격 모드**: 모든 계약 인터페이스로 타입 안전성 보장
- **영속적 작업 큐**: SQLite 기반, 프로세스 재시작 후 스케줄 유지
- **실시간 웹 대시보드**: WebSocket 기반 로그/진행률/알림

### 현재 구현 상태

| 모듈                                    | 상태    |
| --------------------------------------- | ------- |
| Core / 쿠팡 어댑터 / 플랫폼 어댑터      | ✅ 완료 |
| 템플릿 엔진 / 이미지 생성 / 포스트 조립 | ✅ 완료 |
| 키워드 리서치 / 경쟁 분석 / 주제 선정   | ✅ 완료 |
| 작업 큐 + 스케줄러 / CLI / 웹 대시보드  | ✅ 완료 |
| TypeScript 컴파일                       | ✅ 성공 |

---

## 📋 주요 명령어

```bash
# CLI
npm run cli -- config                           # 대화형 설정
npm run cli -- research "키워드" --limit=20     # 키워드 리서치
npm run cli -- generate -t 템플릿 -p 상품ID --platform=tistory --dry-run
npm run cli -- publish --post-id=xxx --platform=tistory
npm run cli -- schedule list|enable|disable 잡명
npm run cli -- analytics --days=30

# 웹 대시보드
npm run dev:web          # 개발 서버 (프론트: 5173, 백엔드: 3005)
npm run build --prefix src/web/client  # 프론트엔드 프로덕션 빌드

# 프로덕션 실행 (PM2)
pm2 start dist/cli/index.js --name "blog-poster-scheduler" -- schedule
pm2 start dist/web/server/index.js --name "blog-poster-web"
```

---

## 🔧 설정 파일

| 파일                  | 용도                         |
| --------------------- | ---------------------------- |
| `config/default.yaml` | 기본 설정 (git 관리)         |
| `config/local.yaml`   | 로컬 오버라이드 (gitignored) |
| `config/secrets.yaml` | API 키/비밀번호 (gitignored) |
| `config/test.yaml`    | 테스트용 설정                |

### 필수 환경변수 (또는 secrets.yaml)

```bash
BLOG_POSTER_AFFILIATES_COUPANG_API_KEY=xxx
BLOG_POSTER_AFFILIATES_COUPANG_API_SECRET=xxx
BLOG_POSTER_PLATFORMS_TISTORY_USERNAME=xxx
BLOG_POSTER_PLATFORMS_TISTORY_PASSWORD=xxx
BLOG_POSTER_PLATFORMS_TISTORY_API_KEY=xxx
BLOG_POSTER_WEB_JWT_SECRET=your-secret-key
```

### 이미지 생성 비용 통제 (#8)

gpt-image-1 단가(USD/장, 근사치):

| 사이즈 | low | medium | high |
| --- | --- | --- | --- |
| 1024x1024 | $0.011 | $0.063 | $0.17 |
| 1024x1536 / 1536x1024 | $0.016 | $0.119 | $0.25 |

`config/*.yaml`의 `imageProviders` 아래에서 제어:

```yaml
imageProviders:
  openai:
    quality: 'low'        # 코드 기본값도 low (high는 장당 ~$0.17로 크레딧 소진이 빠름)
    size: '1024x1024'     # gpt-image-1 최소 사이즈
  maxImagesPerPost: 3     # 포스트당 생성 상한
  budget:
    dailyImageLimit: 20   # 하루 최대 생성 장수 (0 = 무제한)
    dailyCostLimitUsd: 0  # 하루 누적 예상 비용 한도 (0 = 미사용)
```

- 동일 프롬프트 재실행 시 캐시(`output/images/cache/`)를 재사용해 재과금되지 않습니다.
- 일일 사용량 대장: `output/images/.image-usage.json` — 생성 성공 시 장수·예상 비용이 기록되고, 한도 초과 시 생성을 건너뜁니다(글 발행은 계속 진행).

---

## 📦 기술 스택

| 영역         | 기술                                                               |
| ------------ | ------------------------------------------------------------------ |
| **Runtime**  | Node.js ≥ 20, TypeScript 5.5 (엄격 모드)                           |
| **Backend**  | Fastify, better-sqlite3, node-cron, Axios, Pino                    |
| **Frontend** | React 18, Vite, Tailwind CSS, Recharts                             |
| **API**      | Coupang Open API, Tistory API, WordPress REST, YouTube Data API v3 |
| **AI**       | OpenAI DALL-E 3, Stability AI, Google Gemini                       |

---

## 🗂️ 문서 탐색 가이드

```
documents/
├── NEXT_STEPS.md              # ⚡ 즉시 실행: 쿠팡 승인 후 자동화 시작
├── 01-overview.md             # 시스템 전체 그림 + 구현 상태
├── 02-architecture.md         # 아키텍처 설계
├── 03-api.md                  # API 설계
├── 04-tech-stack.md           # 기술 스택
├── 05-database.md             # DB 스키마
├── 06-deployment.md           # 배포/운영
├── 07-roadmap.md              # 로드맵 (Phase 1~4)
├── 08-extension-guide.md      # 확장 가이드
├── 09-troubleshooting.md      # 트러블슈팅
├── 10-naver-blog-bootstrap.md # 네이버 블로그 부트스트랩
├── 11-naver-api-hub-plan.md   # 네이버 API Hub 연동 계획
└── 12-dashboard-keywords-template-plan.md # 대시보드 확장 계획
```

---

## 📄 라이선스

MIT License
