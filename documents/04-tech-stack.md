# 기술 스택

## 백엔드 (Node.js + TypeScript)

| 분류             | 기술                | 버전    | 용도                                                                        |
| ---------------- | ------------------- | ------- | --------------------------------------------------------------------------- |
| **Runtime**      | Node.js             | ≥20.0.0 | 실행 환경                                                                   |
| **Language**     | TypeScript          | 5.5+    | 타입 안전성 (엄격 모드: `strict: true`, `exactOptionalPropertyTypes: true`) |
| **Framework**    | Fastify             | 4.x     | 고성능 웹 서버, 플러그인 생태계                                             |
| **Scheduler**    | node-cron           | 3.x     | 크론 표현식 기반 스케줄링                                                   |
| **Queue/DB**     | better-sqlite3      | 9.x     | 영속적 작업 큐 (WAL 모드, 동시성 지원)                                      |
| **HTTP Client**  | Axios               | 1.7+    | 재시도/지수 백오프/도메인별 레이트리밋 내장                                 |
| **Logging**      | Pino                | 9.x     | 구조화 로깅 (JSON, 파일 로테이션, pretty print)                             |
| **Template**     | Handlebars          | 4.7+    | 템플릿 렌더링 (헬퍼 등록, 프론트매터 파싱)                                  |
| **Config**       | js-yaml             | 4.x     | YAML 설정 파일 파싱                                                         |
| **Validation**   | commander           | 12.x    | CLI 명령어 파싱                                                             |
| **Auth**         | @fastify/jwt        | 8.x     | JWT 기반 인증                                                               |
| **WebSocket**    | @fastify/websocket  | 8.x     | 실시간 통신                                                                 |
| **Rate Limit**   | @fastify/rate-limit | 9.x     | API 레이트리밋                                                              |
| **CORS**         | @fastify/cors       | 9.x     | CORS 설정                                                                   |
| **Static Files** | @fastify/static     | 7.x     | 프론트엔드 빌드 서빙                                                        |
| **Cache**        | File-based (Custom) | -       | TTL 캐시 (`.cache/`, 메모리+디스크)                                         |
| **RSS/HTML**     | rss-parser, cheerio | -       | 경쟁 분석용 피드/페이지 파싱                                                |

### TypeScript 엄격 설정 (tsconfig.json)

```json
{
  "strict": true,
  "noImplicitAny": true,
  "strictNullChecks": true,
  "strictFunctionTypes": true,
  "strictPropertyInitialization": true,
  "noImplicitThis": true,
  "alwaysStrict": true,
  "noUnusedLocals": true,
  "noUnusedParameters": true,
  "noImplicitReturns": true,
  "noFallthroughCasesInSwitch": true,
  "noUncheckedIndexedAccess": true,
  "noImplicitOverride": true,
  "exactOptionalPropertyTypes": true,
  "forceConsistentCasingInFileNames": true
}
```

## 프론트엔드

| 분류           | 기술                 | 버전  | 용도                                   |
| -------------- | -------------------- | ----- | -------------------------------------- |
| **Framework**  | React                | 18.2  | UI 라이브러리                          |
| **Build Tool** | Vite                 | 5.x   | 빠른 개발 서버, 최적화된 프로덕션 빌드 |
| **Router**     | React Router         | 6.20  | SPA 클라이언트 사이드 라우팅           |
| **State**      | React Context        | -     | 전역 상태 (Auth, WebSocket)            |
| **HTTP**       | Axios                | 1.6   | API 통신 (인터셉터로 토큰 자동 갱신)   |
| **Charts**     | Recharts             | 2.10  | 대시보드 차트 (영역/막대/파이)         |
| **Icons**      | Lucide React         | 0.294 | 일관된 아이콘 시스템                   |
| **Styling**    | Tailwind CSS         | 3.3   | 유틸리티 퍼스트 CSS, 다크 모드 지원    |
| **Date**       | date-fns             | 2.30  | 날짜 포맷팅/상대 시간                  |
| **Utils**      | clsx, tailwind-merge | -     | 조건부 클래스명 병합                   |

### Vite 설정 (vite.config.ts)

```typescript
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, '../../shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
```

## 외부 API 의존성

| 서비스                        | 용도                             | 인증                                           | 레이트 리밋 | 비고                   |
| ----------------------------- | -------------------------------- | ---------------------------------------------- | ----------- | ---------------------- |
| **Coupang Partners Open API** | 상품 검색/상세/트래킹URL/커미션  | OAuth 2.0 (Client Credentials + Refresh Token) | 100 req/min | 자동 토큰 갱신         |
| **Tistory API**               | 포스트 작성/수정/카테고리/이미지 | 세션 기반 (Username/Password + API Key)        | 30 req/min  | 멀티파트 업로드        |
| **WordPress REST API**        | 포스트/미디어/카테고리/태그 CRUD | Application Password / JWT                     | 60 req/min  | WooCommerce 확장 가능  |
| **YouTube Data API v3**       | Shorts 업로드/썸네일/통계        | OAuth 2.0 (`youtube.upload` scope)             | 50 req/min  | 재개 가능 업로드       |
| **Naver DataLab API**         | 검색 트렌드/연관 키워드          | Client ID/Secret                               | -           | 일 1만 쿼리            |
| **Google Trends (SerpAPI)**   | 트렌딩 검색어                    | SerpAPI Key (선택)                             | -           | 비공식 API 폴백        |
| **OpenAI DALL-E 3**           | AI 이미지 생성                   | API Key                                        | -           | 제품/라이프스타일/차트 |
| **Stability AI**              | Stable Diffusion 이미지 생성     | API Key                                        | -           | SDXL 엔진              |
| **Google Gemini**             | AI 이미지 생성                   | API Key                                        | -           | gemini-1.5-pro         |

## 개발/빌드 도구

| 도구         | 용도                                    |
| ------------ | --------------------------------------- |
| **ESLint**   | 코드 품질 검사 (`@typescript-eslint/*`) |
| **Prettier** | 코드 포맷팅                             |
| **Vitest**   | 단위/통합 테스트                        |
| **ts-node**  | 개발 모드 직접 실행                     |
| **PM2**      | 프로덕션 프로세스 관리                  |

## 프로젝트 스크립트 (package.json)

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "ts-node src/cli/index.ts",
    "cli": "ts-node src/cli/index.ts",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "smoke": "ts-node scripts/smoke-test.ts",
    "config:wizard": "ts-node src/cli/config-wizard.ts",
    "web:dev": "concurrently \"npm run web:dev:server\" \"npm run web:dev:client\"",
    "web:dev:server": "ts-node src/web/server/index.ts",
    "web:dev:client": "cd src/web/client && npm run dev",
    "build:web": "cd src/web/client && npm run build"
  }
}
```

## 환경별 설정

| 환경            | 설정 파일                                   | 특징                                       |
| --------------- | ------------------------------------------- | ------------------------------------------ |
| **Development** | `config/local.yaml` + `config/secrets.yaml` | 로그 레벨 debug, 핫 리로드                 |
| **Test**        | `config/test.yaml`                          | 샌드박스 자격증명, 인메모리/테스트 DB      |
| **Production**  | 환경변수 + `config/local.yaml`              | 로그 레벨 info, PM2 관리, 빌드 산출물 사용 |

## 의존성 버전 고정 정책

- `package-lock.json` 커밋 필수
- 메이저 버전 업그레이드 시 호환성 검증 후 적용
- 보안 패치는 Dependabot 알림 시 즉시 적용
