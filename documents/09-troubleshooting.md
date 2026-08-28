# 트러블슈팅 가이드

## 자주 발생하는 문제

### 인증 관련

| 문제                      | 증상                                         | 원인                                                             | 해결                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **쿠팡 401 Unauthorized** | `AUTHENTICATION_FAILED` 에러, 토큰 갱신 실패 | API 키/시크릿 오타, 만료된 리프레시 토큰, IP 화이트리스트 미등록 | 1. `config/secrets.yaml`의 `apiKey`, `apiSecret` 확인<br>2. 쿠팡 파트너스 센터에서 키 재발급<br>3. IP 화이트리스트에 서버 IP 추가<br>4. `config/secrets.yaml`의 `refreshToken` 삭제 후 재초기화 |
| **티스토리 로그인 실패**  | 세션 쿠키 없음, 403 Forbidden                | 아이디/비밀번호 오타, 2차 인증 활성화, IP 차단                   | 1. `config/secrets.yaml` 자격증명 확인<br>2. 티스토리 보안 설정에서 2차 인증 해제 또는 앱 비밀번호 사용<br>3. 티스토리 센터에서 IP 허용 설정                                                    |
| **워드프레스 401/403**    | Application Password 거부                    | 앱 비밀번호 오타, 권한 부족, REST API 비활성화                   | 1. 워드프레스 사용자 → 애플리케이션 비밀번호 재생성<br>2. 관리자 권한 확인<br>3. `Settings > Permalinks` 저장으로 REST API 활성화                                                               |
| **유튜브 403 Forbidden**  | `youtube.upload` 스코프 부족                 | OAuth 동의 화면에서 `youtube.upload` 미포함, 토큰 만료           | 1. Google Cloud Console에서 OAuth 동의 화면 수정<br>2. `https://www.googleapis.com/auth/youtube.upload` 스코프 추가<br>3. `refreshToken` 삭제 후 재인증                                         |
| **JWT 토큰 만료**         | 웹 대시보드 401, 자동 로그아웃               | `jwtExpiresIn` 만료, 시계 동기화 문제                            | 1. `config/secrets.yaml`의 `jwtSecret` 확인<br>2. 서버 시간 동기화 (`ntpdate`)<br>3. `/api/auth/refresh` 호출로 갱신                                                                            |

---

### API 및 레이트 리밋

| 문제                            | 증상                                   | 원인                                       | 해결                                                                                                                                                         |
| ------------------------------- | -------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **쿠팡 429 Too Many Requests**  | `RATE_LIMIT_EXCEEDED`, 재시도 후 실패  | 분당 100회 초과, 동시 다중 워커 실행       | 1. `config/default.yaml`의 `rateLimit.requestsPerMinute` 확인 (기본 100)<br>2. 멀티 워커 시 Redis 분산 락 필요 (Phase 3)<br>3. 크론 잡 시간 겹치지 않게 조정 |
| **티스토리 이미지 업로드 실패** | 413 Payload Too Large, 업로드 타임아웃 | 파일 크기 > 5MB, 네트워크 느림             | 1. 이미지 리사이징/압축 (Phase 2에서 청크 업로드 예정)<br>2. `axios` 타임아웃 증가 (`timeout: 120000`)<br>3. 이미지 CDN 프록시 경유                          |
| **네이버 DataLab 403/429**      | 키워드 리서치 실패                     | Client ID/Secret 오타, 일일 쿼리 한도 초과 | 1. 네이버 개발자 센터에서 Client ID/Secret 확인<br>2. 일일 10,000 쿼리 한도 체크<br>3. 캐시 TTL 조정 (24h → 48h)                                             |
| **구글 트렌드 데이터 없음**     | 키워드 볼륨 0, 트렌드 stable           | SerpAPI 키 미설정, 비공식 API 차단         | 1. `config/secrets.yaml`에 `serpApiKey` 설정<br>2. `useSerpApi: true`로 변경<br>3. 쿠팡/네이버 프로바이더만 사용하도록 `providers` 조정                      |

---

### 스케줄러 및 작업 큐

| 문제                       | 증상                                   | 원인                                           | 해결                                                                                                                                     |
| -------------------------- | -------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **스케줄러가 실행 안 됨**  | 크론 잡 미실행, `scheduler: "stopped"` | `enabled: false`, 타임존 불일치, 프로세스 사망 | 1. `config/default.yaml` `scheduler.enabled: true` 확인<br>2. `timezone: "Asia/Seoul"` 설정 확인<br>3. PM2로 프로세스 관리 (`pm2 start`) |
| **작업이 QUEUED에서 멈춤** | `dequeue` 시 null 반환, `running` 0    | `maxConcurrentJobs` 도달, 모든 워커 busy       | 1. `jobQueue.maxConcurrentJobs` 증가 (기본 3)<br>2. `pm2 monit`로 메모리/CPU 확인<br>3. 긴 작업 분리 (별도 워커)                         |
| **재시도 무한 루프**       | `RETRYING` 상태 반복, 데드레터 안 감   | `isRetryableError` 판정 오류, 에러 타입 불일치 | 1. `errors.ts`의 `isRetryableError()` 로직 확인<br>2. 커스텀 에러에 `isRetryable: true` 명시<br>3. `deadLetterAfterAttempts: 5` 확인     |
| **데드레터 쌓임**          | `DEAD_LETTER` 상태 작업 다수           | 영구적 에러 (권한 없음, 잘못된 설정)           | 1. `job_logs`에서 에러 상세 확인<br>2. 원인 수정 후 `npm run cli -- schedule retry <jobId>`<br>3. 주기적 정리 스크립트 실행              |

---

### 콘텐츠 생성 및 발행

| 문제                      | 증상                                            | 원인                                                    | 해결                                                                                                                                                              |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **템플릿 렌더링 에러**    | `TemplateError: COMPILATION_FAILED`             | 핸들바 문법 오류, 헬퍼 미등록, 필드 누락                | 1. 템플릿 `.hbs` 파일 문법 검사<br>2. `{{#if field}}`로 조건부 렌더링<br>3. `TemplateEngine.validateTemplate()`로 사전 검증                                       |
| **필수 필드 누락**        | `ValidationError: Required field missing: pros` | 상품 데이터에 필드 없음, 템플릿 `requiredFields` 불일치 | 1. `AffiliateProduct`에 기본값 설정 (`pros: ['기본 장점']`)<br>2. 템플릿 `requiredFields` 최소화<br>3. `PostAssembler`에서 기본값 주입                            |
| **이미지 생성 실패**      | `TemplateError: GENERATION_FAILED`              | API 키 없음, 프롬프트 과도, 할당량 초과                 | 1. `imageProviders` 설정에서 `enabled: true` 및 API 키 확인<br>2. `imageGenerator.setDefaultProvider('placeholder')`로 폴백<br>3. 프롬프트 길이 제한 (200자 내외) |
| **발행 후 링크 404**      | 쿠팡 링크 클릭 시 404, 추적 파라미터 없음       | `generateTrackingUrl` 미호출, `subId` 누락              | 1. `PostAssembler`에서 `subId` 전달 확인<br>2. `CoupangAdapter.generateTrackingUrl()` 호출 검증<br>3. 발행된 포스트 HTML에서 링크 직접 확인                       |
| **유튜브 쇼츠 60초 초과** | 업로드 거부, `videoDuration` 에러               | 비디오 길이 > 60초                                      | 1. 업로드 전 `ffprobe`로 길이 체크<br>2. 60초 초과 시 에러 반환 및 알림<br>3. 자동 트리밍 기능 추가 (Phase 2)                                                     |

---

### 웹 대시보드

| 문제                        | 증상                                                         | 원인                                                 | 해결                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **웹소켓 연결 실패**        | 실시간 로그/진행률 안 뜸, 콘솔 `WebSocket connection failed` | 프록시/방화벽 차단, HTTP 대신 HTTPS, 포트 차단       | 1. Nginx에서 `proxy_set_header Upgrade $http_upgrade` 설정<br>2. `ws://` → `wss://` (SSL 적용)<br>3. 방화벽 3000포트 허용                              |
| **CORS 에러**               | 브라우저 콘솔 `CORS policy` 에러                             | 프론트엔드 포트(5173) → 백엔드(3000) 크로스 오리진   | 1. `config/default.yaml` `cors.origin: "*"` 또는 구체적 도메인<br>2. `@fastify/cors` 설정 확인<br>3. 개발 모드에서 Vite 프록시 사용 (`vite.config.ts`) |
| **로그인 후 바로 로그아웃** | JWT 만료, `localStorage` 토큰 제거                           | `jwtSecret` 불일치, 시계 동기화, 토큰 만료 시간 짧음 | 1. `config/secrets.yaml` `jwtSecret` 일치 확인<br>2. 서버 시간 동기화 (`timedatectl set-ntp true`)<br>3. `jwtExpiresIn: "7d"` 이상 설정                |
| **빌드 후 흰 화면**         | `dist/index.html` 로드 시 빈 페이지                          | 베이스 경로 불일치, 정적 파일 경로 오류              | 1. `vite.config.ts` `base: './'` 설정<br>2. `fastify-static` 루트 경로 확인 (`src/web/client/dist`)<br>3. `index.html`에서 상대 경로 사용              |

---

### 데이터베이스

| 문제                  | 증상                              | 원인                               | 해결                                                                                                                               |
| --------------------- | --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **SQLite 잠금 에러**  | `SQLITE_BUSY: database is locked` | 동시 쓰기 충돌, WAL 모드 미적용    | 1. `PRAGMA journal_mode = WAL` 확인<br>2. `busy_timeout = 5000` 설정<br>3. 단일 프로세스에서만 DB 접근                             |
| **마이그레이션 필요** | 스키마 불일치, 컬럼 없음 에러     | 코드 업데이트 후 DB 스키마 미반영  | 1. 앱 재시작 시 자동 마이그레이션 확인<br>2. 수동: `sqlite3 data/jobs.sqlite < migrations/001_add_column.sql`                      |
| **디스크 공간 부족**  | `ENOSPC`, DB 쓰기 실패            | 로그/캐시/이미지 누적, 백업 미수행 | 1. `data/logs/` 오래된 로그 삭제 (`find -mtime +30 -delete`)<br>2. `.cache/` 주기적 정리<br>3. `output/images/` 미사용 이미지 정리 |

---

## 디버깅 팁

### 1. 상세 로그 활성화

```bash
# 환경변수로 로그 레벨 변경
export BLOG_POSTER_APP_LOG_LEVEL=debug
npm run cli -- research "키워드"

# 또는 config/local.yaml
app:
  logLevel: "debug"
```

### 2. 작업 큐 직접 조회

```bash
# 전체 작업 조회
sqlite3 data/jobs.sqlite "SELECT id, type, status, priority, created_at FROM jobs ORDER BY created_at DESC LIMIT 20;"

# 특정 작업 상세
sqlite3 data/jobs.sqlite "SELECT * FROM jobs WHERE id = 'job-1703123456789-abc123';"

# 로그 조회
sqlite3 data/jobs.sqlite "SELECT level, message, created_at FROM job_logs WHERE job_id = 'job-...' ORDER BY created_at;"

# 발행 기록
sqlite3 data/jobs.sqlite "SELECT platform, title, status, url, published_at FROM published_posts ORDER BY published_at DESC LIMIT 10;"
```

### 3. API 직접 테스트

```bash
# 헬스체크
curl http://localhost:3000/health

# 로그인
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"changeme"}'

# 토큰 저장 후 사용
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"username":"admin","password":"changeme"}' | jq -r .token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/dashboard/stats
```

### 4. 설정 검증

```bash
# 설정 위자드 실행 (대화형 검증)
npm run cli -- config

# 설정 파일 문법 검사
npm run cli -- config 2>&1 | grep -E "(error|Error|ERROR)"
```

### 5. 프로세스 상태 확인

```bash
# PM2 상태
pm2 list
pm2 monit

# 포트 점유 확인
lsof -i :3000
lsof -i :5173

# 메모리/CPU
pm2 show blog-poster-scheduler
pm2 show blog-poster-web
```

### 6. 네트워크/방화벽 진단

```bash
# 외부 API 연결 테스트
curl -I https://api-gateway.coupang.com
curl -I https://www.tistory.com/apis
curl -I https://www.googleapis.com/youtube/v3

# DNS 확인
dig api-gateway.coupang.com
nslookup api-gateway.coupang.com
```

---

## 로그 레벨 가이드

| 레벨    | 용도                          | 예시                                |
| ------- | ----------------------------- | ----------------------------------- |
| `trace` | 극도로 상세 (변수 값, 플로우) | 함수 진입/종료, 변수 값             |
| `debug` | 디버깅 정보                   | API 요청/응답, 캐시 히트/미스       |
| `info`  | 일반 정보 (기본)              | 작업 시작/완료, 설정 로드           |
| `warn`  | 경고 (복구 가능)              | 재시도, 레이트 리밋 근접, 폴백 사용 |
| `error` | 에러 (복구 불가)              | 인증 실패, API 에러, 발행 실패      |

### 로그 출력 예시

```json
{
  "level": 30,
  "time": 1703123456789,
  "pid": 12345,
  "hostname": "server-1",
  "module": "coupang-adapter",
  "msg": "Product search completed",
  "keyword": "무선청소기",
  "count": 20
}
```

---

## 긴급 대응 체크리스트

### 발행 완전 중단 시

1. `pm2 list`로 프로세스 생존 확인
2. `pm2 logs --err`로 에러 로그 확인
3. `sqlite3 data/jobs.sqlite "SELECT COUNT(*) FROM jobs WHERE status='RUNNING';"`로 멈춘 작업 확인
4. `pm2 restart all`로 전체 재시작
5. `npm run cli -- schedule list`로 스케줄러 상태 확인

### 쿠팡 수익 0원 지속 시

1. `config/secrets.yaml`의 `trackingId` 확인 (서브 ID 필수)
2. 쿠팡 파트너스 센터에서 승인 상태 확인
3. 발행된 포스트의 제휴 링크 직접 클릭 테스트
4. `npm run cli -- analytics --days=7`로 클릭/전환 수 확인

### 데이터 손실 의심 시

1. `data/backups/` 최신 백업 확인
2. `sqlite3 data/jobs.sqlite ".backup data/emergency-backup.sqlite"` 즉시 백업
3. `sqlite3 data/jobs.sqlite "PRAGMA integrity_check;"`로 무결성 검사
4. 필요 시 백업에서 복원
