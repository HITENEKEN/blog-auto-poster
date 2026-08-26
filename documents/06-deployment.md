# 배포 및 기동 가이드

## 🚀 쿠팡 승인 후 즉시 시작 가이드 (5분)

> **쿠팡 파트너스 승인 완료 후 즉시 실행할 수 있는 최소 단계**

```bash
# 1. 프로젝트 진입
cd blog-auto-poster

# 2. 의존성 설치 (최초 1회)
npm install --legacy-peer-deps

# 3. 프론트엔드 빌드
cd src/web/client && npm install && npm run build && cd ../..

# 4. 설정 파일 작성
cp config/default.yaml config/local.yaml
cp config/secrets.yaml.example config/secrets.yaml
# → config/secrets.yaml 에 실제 API 키 입력 (쿠팡 API Key/Secret/Tracking ID)

# 5. 백엔드 빌드
npm run build

# 6. 스케줄러 활성화 및 실행
npm run cli -- schedule enable daily-keyword-research
npm run cli -- schedule enable daily-content-generation
npm run cli -- schedule enable daily-publishing
npm run cli -- schedule enable hourly-analytics-sync

# 7. PM2로 백그라운드 실행 (권장)
pm2 start dist/cli/index.js --name "blog-poster-scheduler" -- schedule
pm2 start dist/web/server/index.js --name "blog-poster-web"

# 9. 웹 대시보드 접속
# http://localhost:3000 (admin/changeme)
```

---

## 사전 요구사항

- **Node.js** ≥ 20.0.0
- **npm** ≥ 9.0.0
- **쿠팡 파트너스** 승인된 계정 (API 키/시크릿 발급 필요)
- **선택적**: 티스토리/워드프레스/유튜브 계정

## 설치

### 1. 백엔드 의존성 설치
```bash
cd blog-auto-poster
npm install --legacy-peer-deps
```

### 2. 프론트엔드 의존성 설치
```bash
cd src/web/client
npm install
npm run build
cd ../..
```

### 3. 설정 파일 준비
```bash
# 기본 설정 복사
cp config/default.yaml config/local.yaml

# 시크릿 템플릿 복사
cp config/secrets.yaml.example config/secrets.yaml

# 실제 값 입력
vim config/secrets.yaml
```

## 설정 파일 구조

```
config/
├── default.yaml          # 기본 설정 (git 관리)
├── local.yaml            # 로컬 오버라이드 (gitignored)
├── test.yaml             # 테스트용 설정
├── secrets.yaml          # API 키/비밀번호 (gitignored)
└── secrets.yaml.example  # 시크릿 템플릿
```

### config/secrets.yaml 작성 예시
```yaml
affiliates:
  coupang:
    apiKey: "your-coupang-api-key"
    apiSecret: "your-coupang-api-secret"
    trackingId: "your-tracking-id"

platforms:
  tistory:
    blogName: "your-blog-name"
    username: "your-username"
    password: "your-password"
    apiKey: "your-api-key"

  wordpress:
    url: "https://your-site.com"
    username: "your-username"
    appPassword: "your-app-password"

  youtube-shorts:
    clientId: "your-client-id"
    clientSecret: "your-client-secret"
    refreshToken: "your-refresh-token"

web:
  jwtSecret: "your-super-secret-jwt-key-min-32-chars"
```

### 환경변수로 대체 가능 (우선순위: 환경변수 > secrets.yaml > local.yaml > default.yaml)
```bash
export BLOG_POSTER_AFFILIATES_COUPANG_API_KEY=your_key
export BLOG_POSTER_AFFILIATES_COUPANG_API_SECRET=your_secret
export BLOG_POSTER_AFFILIATES_COUPANG_TRACKING_ID=your_tracking_id
export BLOG_POSTER_PLATFORMS_TISTORY_USERNAME=your_user
export BLOG_POSTER_PLATFORMS_TISTORY_PASSWORD=your_pass
export BLOG_POSTER_PLATFORMS_TISTORY_API_KEY=your_api_key
export BLOG_POSTER_PLATFORMS_WORDPRESS_URL=https://yoursite.com
export BLOG_POSTER_PLATFORMS_WORDPRESS_USERNAME=your_user
export BLOG_POSTER_PLATFORMS_WORDPRESS_APP_PASSWORD=your_app_pass
export BLOG_POSTER_PLATFORMS_YOUTUBE_CLIENT_ID=your_client_id
export BLOG_POSTER_PLATFORMS_YOUTUBE_CLIENT_SECRET=your_client_secret
export BLOG_POSTER_PLATFORMS_YOUTUBE_REFRESH_TOKEN=your_refresh_token
export BLOG_POSTER_WEB_JWT_SECRET=your-super-secret-jwt-key-min-32-chars
```

## 빌드

### 백엔드
```bash
npm run build
# → dist/ 디렉토리에 컴파일 산출물 생성
```

### 프론트엔드
```bash
cd src/web/client
npm run build
# → src/web/client/dist/ 디렉토리에 프로덕션 빌드 산출물 생성
```

## 실행

### 개발 모드

#### CLI
```bash
# 설정 위자드 (대화형)
npm run cli -- config

# 키워드 리서치
npm run cli -- research "무선청소기" --limit=20

# 포스트 생성 (드라이런)
npm run cli -- generate \
  --template=coupang-product-review \
  --product=123456789 \
  --platform=tistory \
  --dry-run

# 포스트 발행
npm run cli -- publish --post-id=test-xyz --platform=tistory

# 스케줄러 관리
npm run cli -- schedule list
npm run cli -- schedule enable daily-publishing
npm run cli -- schedule disable daily-publishing

# 분석 조회
npm run cli -- analytics --days=30
```

#### 웹 대시보드 개발 서버
```bash
# 백엔드 + 프론트엔드 동시 실행
npm run web:dev

# 개별 실행
npm run web:dev:server    # 백엔드 (port 3000)
npm run web:dev:client    # 프론트엔드 (port 5173)

# 접속
# 프론트엔드: http://localhost:5173
# 백엔드 API: http://localhost:3000
# 헬스체크: http://localhost:3000/health
```

### 프로덕션 모드

#### PM2로 프로세스 관리 (권장)
```bash
# PM2 설치
npm install -g pm2

# 스케줄러 백그라운드 실행
pm2 start dist/cli/index.js --name "blog-poster-scheduler" -- schedule

# 웹 서버 백그라운드 실행
pm2 start dist/web/server/index.js --name "blog-poster-web"

# 상태 확인
pm2 list
pm2 logs blog-poster-scheduler
pm2 logs blog-poster-web

# 모니터링
pm2 monit

# 자동 재시작 설정 (서버 재부팅 시)
pm2 startup
pm2 save
```

#### 직접 실행
```bash
# 스케줄러 실행 (포그라운드)
NODE_ENV=production node dist/cli/index.js schedule

# 웹 서버 실행 (포그라운드)
NODE_ENV=production node dist/web/server/index.js
```

## 헬스체크
```bash
# 서비스 상태 확인
curl http://localhost:3000/health

# 응답 예시
{
  "status": "ok",
  "timestamp": "2026-08-25T07:00:00.000Z",
  "version": "1.0.0",
  "services": {
    "affiliates": { "coupang": true },
    "platforms": { "tistory": true, "wordpress": false },
    "jobQueue": { "total": 15, "pending": 2, "running": 1, "completed": 10, "failed": 2 },
    "scheduler": "running"
  }
}
```

## 로그 확인
```bash
# 실시간 로그 (PM2)
pm2 logs blog-poster-scheduler --lines 100
pm2 logs blog-poster-web --lines 100

# 파일 로그
tail -f data/logs/app.log
tail -f data/logs/error.log

# 작업 큐 상태
sqlite3 data/jobs.sqlite "SELECT id, type, status, created_at FROM jobs ORDER BY created_at DESC LIMIT 10;"

# 발행 기록
sqlite3 data/jobs.sqlite "SELECT platform, title, status, published_at FROM published_posts ORDER BY published_at DESC LIMIT 10;"
```

## 디렉토리 구조 (런타임)
```
blog-auto-poster/
├── data/
│   ├── jobs.sqlite              # 작업 큐 DB
│   ├── logs/
│   │   ├── app.log              # 일반 로그
│   │   └── error.log            # 에러 로그
│   └── backups/                 # DB 백업
├── output/
│   ├── posts/                   # 생성된 포스트 (HTML + 메타)
│   │   └── post-{id}/
│   │       ├── post.html
│   │       ├── meta.json
│   │       └── platform-content.json
│   └── images/                  # AI 생성 이미지
│       └── {timestamp}_{prompt}_{n}.webp
├── .cache/
│   ├── coupang-tokens/          # 쿠팡 토큰 캐시
│   ├── naver-keywords/          # 네이버 키워드 캐시
│   └── ...
├── config/
│   ├── local.yaml
│   └── secrets.yaml
└── dist/                        # 컴파일 산출물
```

## 트러블슈팅

| 문제 | 원인 | 해결 |
|------|------|------|
| `Module not found` | 의존성 미설치 | `npm install --legacy-peer-deps` |
| `better-sqlite3` 빌드 실패 | Python/빌드 도구 없음 | `xcode-select --install` (macOS) 또는 `build-essential` (Linux) |
| 쿠팡 401 에러 | 토큰 만료/키 오류 | `secrets.yaml` 키 확인, 자동 갱신 로직 확인 |
| 티스토리 이미지 업로드 실패 | 파일 > 5MB | Phase 2에서 청크 업로드 구현 예정 |
| 유튜브 403 Forbidden | OAuth 스코프 부족 | `youtube.upload` 스코프 포함 확인 |
| 스케줄러 미작동 | 타임존 불일치 | `scheduler.timezone: "Asia/Seoul"` 확인 |
| WebSocket 연결 끊김 | 프록시/방화벽 | `ws://` → `wss://` 또는 프록시 설정 확인 |
| PM2 프로세스 죽음 | 메모리 부족/에러 | `pm2 logs`로 원인 분석, `--max-memory-restart` 설정 |

## 백업/복원
```bash
# 자동 백업 (cron 예시)
0 2 * * * sqlite3 /path/to/data/jobs.sqlite ".backup /path/to/data/backups/jobs-$(date +\%Y\%m\%d).sqlite"

# 수동 백업
sqlite3 data/jobs.sqlite ".backup data/backups/jobs-$(date +%Y%m%d).sqlite"

# 복원
sqlite3 data/jobs.sqlite ".restore data/backups/jobs-20260825.sqlite"
```

## SSL/HTTPS (프로덕션)
```nginx
# Nginx 리버스 프록시 예시
server {
    listen 443 ssl;
    server_name your-domain.com;
    
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```