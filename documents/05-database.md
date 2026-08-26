# 데이터베이스 스키마

## SQLite 테이블

### 1. jobs (작업 큐)
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,                              -- job-{timestamp}-{random}
  type TEXT NOT NULL,                               -- RESEARCH, GENERATE, PUBLISH, SYNC_ANALYTICS, REFRESH_TOKEN, CLEANUP
  status TEXT NOT NULL DEFAULT 'PENDING',           -- PENDING, QUEUED, RUNNING, COMPLETED, FAILED, RETRYING, DEAD_LETTER
  priority INTEGER NOT NULL DEFAULT 0,              -- 높을수록 먼저 처리
  payload TEXT NOT NULL,                            -- JSON 직렬화 (작업 파라미터)
  result TEXT,                                      -- JSON 직렬화 (완료 결과)
  error TEXT,                                       -- 에러 메시지
  attempts INTEGER NOT NULL DEFAULT 0,              -- 시도 횟수
  max_attempts INTEGER NOT NULL DEFAULT 3,          -- 최대 재시도
  scheduled_at TEXT,                                -- ISO 8601 (예약 실행 시각)
  started_at TEXT,                                  -- 실행 시작 시각
  completed_at TEXT,                                -- 완료 시각
  created_at TEXT NOT NULL,                         -- 생성 시각
  updated_at TEXT NOT NULL                          -- 수정 시각
);
```

### 2. job_logs (작업 로그)
```sql
CREATE TABLE job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  level TEXT NOT NULL,                              -- info, warn, error, debug
  message TEXT NOT NULL,
  metadata TEXT,                                    -- JSON 직렬화
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
```

### 3. published_posts (발행 기록)
```sql
CREATE TABLE published_posts (
  id TEXT PRIMARY KEY,                              -- pub-{platform}-{postId}
  job_id TEXT,                                      -- 원본 작업 ID
  platform TEXT NOT NULL,                           -- tistory, wordpress, youtube-shorts
  post_id TEXT NOT NULL,                            -- 플랫폼별 포스트 ID
  url TEXT NOT NULL,                                -- 발행된 URL
  title TEXT,
  template TEXT,                                    -- 사용된 템플릿명
  product_id TEXT,                                  -- 쿠팡 상품 ID
  affiliate_url TEXT,                               -- 트래킹 포함 제휴 URL
  status TEXT NOT NULL,                             -- published, failed
  published_at TEXT NOT NULL,                       -- 발행 시각
  metadata TEXT,                                    -- JSON (플랫폼 응답, 에러 상세 등)
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE SET NULL
);
```

## 인덱스
```sql
-- jobs 테이블
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_type ON jobs(type);
CREATE INDEX idx_jobs_scheduled_at ON jobs(scheduled_at);
CREATE INDEX idx_jobs_priority_created ON jobs(priority DESC, created_at ASC);

-- job_logs 테이블
CREATE INDEX idx_job_logs_job_id ON job_logs(job_id);

-- published_posts 테이블
CREATE INDEX idx_published_posts_platform ON published_posts(platform);
CREATE INDEX idx_published_posts_published_at ON published_posts(published_at);
```

## PRAGMA 설정
```sql
PRAGMA journal_mode = WAL;        -- Write-Ahead Logging (동시 읽기/쓰기 성능)
PRAGMA busy_timeout = 5000;       -- 5초 락 대기
```

## Job 타입별 Payload 예시

### RESEARCH
```json
{
  "seedKeywords": ["무선청소기", "로봇청소기"],
  "providers": ["google-trends", "coupang"],
  "limit": 20
}
```

### GENERATE
```json
{
  "template": "coupang-product-review",
  "productId": "123456789",
  "platforms": ["tistory", "wordpress"],
  "subId": "my-tracking-id"
}
```

### PUBLISH
```json
{
  "platforms": ["tistory"],
  "maxPostsPerRun": 5
}
```

### SYNC_ANALYTICS
```json
{
  "platforms": ["tistory", "wordpress"],
  "affiliates": ["coupang"]
}
```

## Job 상태 전이
```
PENDING → QUEUED → RUNNING → COMPLETED
                ↓
            RETRYING → QUEUED (지수 백오프)
                ↓
            FAILED → DEAD_LETTER (최대 재시도 초과)
```

## 재시도 정책
- **기본 재시도**: 3회 (`defaultRetryAttempts: 3`)
- **지수 백오프**: `delay = baseDelay * 2^(attempt-1)` (기본 5초)
- **데드레터**: 5회 실패 시 (`deadLetterAfterAttempts: 5`)

## 동시성 제어
- **전역 최대 동시 작업**: 3개 (`maxConcurrentJobs: 3`)
- **플랫폼별/제휴별**: `scheduler.concurrency.perPlatform`, `perAffiliate`로 세부 제어

## 데이터 보존 정책
| 데이터 | 보존 기간 | 비고 |
|--------|-----------|------|
| jobs (COMPLETED/FAILED) | 90일 | `cleanup(olderThanDays: 90)`로 주기적 정리 |
| job_logs | 90일 | 작업 삭제 시 CASCADE 삭제 |
| published_posts | 영구 | 수익 분석용 |

## 마이그레이션 전략
- **스키마 버전**: `PRAGMA user_version`으로 관리
- **변경 시**: `ALTER TABLE` 또는 새 테이블 생성 + 데이터 복사
- **Phase 3**: 일일 10k+ 잡 시 PostgreSQL 마이그레이션 예정 (`QueueBackend` 인터페이스로 추상화)

## 백업/복원
```bash
# 백업
sqlite3 data/jobs.sqlite ".backup data/backups/jobs-$(date +%Y%m%d).sqlite"

# 복원
sqlite3 data/jobs.sqlite ".restore data/backups/jobs-20260825.sqlite"
```