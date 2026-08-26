# API 설계

## REST API 엔드포인트

| 메서드 | 경로 | 설명 | 인증 |
|--------|------|------|------|
| GET | `/health` | 헬스체크 (서비스/DB/외부API 상태) | Public |
| POST | `/api/auth/login` | 관리자 로그인 (JWT 발급) | Public |
| POST | `/api/auth/refresh` | 토큰 갱신 | JWT |
| GET | `/api/auth/me` | 현재 사용자 정보 | JWT |
| GET | `/api/dashboard/stats` | 대시보드 통계 (포스트/수익/성공률) | JWT |
| GET | `/api/blogs` | 연동된 블로그 목록 및 상태 | JWT |
| POST | `/api/blogs/:name/sync-categories` | 카테고리 동기화 | JWT |
| GET | `/api/coupang/status` | 쿠팡 파트너스 현황 | JWT |
| GET | `/api/keywords` | 키워드 리서치 결과 조회/검색/필터 | JWT |
| POST | `/api/keywords/research` | 새 키워드 리서치 트리거 | JWT |
| GET | `/api/posts` | 생성된 포스트 목록 (상태별 필터) | JWT |
| POST | `/api/posts` | 수동 포스트 생성 | JWT |
| POST | `/api/posts/:id/publish` | 특정 포스트 발행 | JWT |
| GET | `/api/scheduler/jobs` | 스케줄러 잡 상태 | JWT |
| POST | `/api/scheduler/jobs/:id/trigger` | 잡 수동 실행 | JWT |
| PUT | `/api/scheduler/config` | 스케줄 설정 수정 | JWT |
| GET | `/api/analytics` | 기간별 분석 데이터 | JWT |

## 인증

### JWT 토큰
- Access Token: 7일 만료 (`jwtExpiresIn: "7d"`)
- Refresh Token: `/api/auth/refresh`로 갱신
- Header: `Authorization: Bearer <token>`

### 로그인 요청
```bash
POST /api/auth/login
Content-Type: application/json

{
  "username": "admin",
  "password": "changeme"
}
```

### 응답
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": { "username": "admin", "role": "admin" }
}
```

## 주요 DTO

### PostContent (생성된 포스트)
```typescript
interface PostContent {
  id: string;
  template: string;
  productId: string;
  platform: string;
  status: 'DRAFT' | 'GENERATING' | 'READY' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';
  title: string;
  content: string;
  meta: { description: string; keywords: string[]; jsonLd?: object };
  tags: string[];
  categories: string[];
  platformContent: Record<string, PlatformPostContent>;
  affiliateUrl: string;
  images: string[];
  createdAt: string;
  updatedAt: string;
}
```

### PlatformPostContent (플랫폼별 변형)
```typescript
interface PlatformPostContent {
  title: string;
  content: string;
  excerpt?: string;
  tags: string[];
  categories: string[];
  visibility: 'public' | 'private' | 'protected' | 'draft';
  images?: PlatformImage[];
  meta?: Record<string, unknown>;
  allowComments?: boolean;
  description?: string;
  videoPath?: string;  // YouTube Shorts
}
```

### KeywordData
```typescript
interface KeywordData {
  keyword: string;
  volume: number;
  competition: number;
  trend: 'rising' | 'falling' | 'stable';
  related: string[];
  source: string;
  metadata?: Record<string, unknown>;
}
```

### JobProgress (WebSocket)
```typescript
interface JobProgress {
  jobId: string;
  type: string;
  status: string;
  progress: number;  // 0-100
  message?: string;
}
```

## 요청/응답 예시

### 키워드 리서치 트리거
```bash
POST /api/keywords/research
Content-Type: application/json
Authorization: Bearer <token>

{
  "keywords": ["무선청소기", "로봇청소기"],
  "providers": ["google-trends", "coupang"],
  "limit": 20
}
```

**응답**
```json
{
  "keywords": [
    {
      "keyword": "무선청소기 추천",
      "volume": 12500,
      "competition": 0.65,
      "trend": "rising",
      "related": ["무선청소기 순위", "가성비 무선청소기"],
      "source": "google-trends"
    }
  ]
}
```

### 포스트 수동 생성
```bash
POST /api/posts
Content-Type: application/json
Authorization: Bearer <token>

{
  "template": "coupang-product-review",
  "productId": "123456789",
  "platform": "tistory",
  "subId": "my-tracking-id"
}
```

**응답**
```json
{
  "post": {
    "id": "post-1703123456789-abc123",
    "template": "coupang-product-review",
    "productId": "123456789",
    "platform": "tistory",
    "status": "READY",
    "title": "다이슨 V15 리뷰 - 장단점 총정리",
    "content": "<div class=\"coupang-product-review\">...</div>",
    "meta": {
      "description": "다이슨 V15 구매 전 꼭 확인하세요...",
      "keywords": ["다이슨 V15", "리뷰", "추천", "가성비"],
      "jsonLd": { "@context": "https://schema.org", "@type": "Product", ... }
    },
    "platformContent": {
      "tistory": { "title": "...", "content": "...", "visibility": "public" }
    },
    "affiliateUrl": "https://link.coupang.com/...",
    "images": ["./output/images/1703123456_dyson_v15_1.webp"],
    "createdAt": "2026-08-25T07:00:00.000Z",
    "updatedAt": "2026-08-25T07:00:00.000Z"
  }
}
```

### 포스트 발행
```bash
POST /api/posts/post-1703123456789-abc123/publish
Content-Type: application/json
Authorization: Bearer <token>

{
  "platform": "tistory"
}
```

**응답**
```json
{
  "results": [
    {
      "platform": "tistory",
      "postId": "1234567",
      "url": "https://myblog.tistory.com/1234567",
      "publishedAt": "2026-08-25T08:00:00.000Z",
      "success": true
    }
  ]
}
```

### 스케줄러 잡 수동 실행
```bash
POST /api/scheduler/jobs/daily-publishing/trigger
Authorization: Bearer <token>
```

**응답**
```json
{ "jobId": "job-1703123456789-def456" }
```

## WebSocket

### 연결
```javascript
const ws = new WebSocket('ws://localhost:3000/ws');
```

### 메시지 타입

#### 클라이언트 → 서버
```json
{ "type": "subscribe", "jobId": "job-123" }
{ "type": "unsubscribe", "jobId": "job-123" }
{ "type": "ping" }
```

#### 서버 → 클라이언트
```json
{ "type": "status", "data": { "jobQueue": {...}, "scheduler": "running" }, "timestamp": 1703123456789 }
{ "type": "progress", "data": { "jobId": "job-123", "type": "GENERATE", "status": "RUNNING", "progress": 45, "message": "템플릿 렌더링 중..." }, "timestamp": 1703123456789 }
{ "type": "log", "data": { "level": "info", "message": "템플릿 렌더링 완료", "jobId": "job-123" }, "timestamp": 1703123456789 }
{ "type": "notification", "data": { "title": "발행 완료", "message": "티스토리 발행 성공" }, "timestamp": 1703123456789 }
{ "type": "pong", "timestamp": 1703123456789 }
```

## 에러 응답 형식
```json
{
  "error": "Unauthorized",
  "message": "Invalid or missing authentication token",
  "statusCode": 401
}
```

또는 비즈니스 에러:
```json
{
  "error": "PlatformError",
  "message": "Tistory post write failed: 인증 만료",
  "code": "CREATE_POST_FAILED",
  "statusCode": 502,
  "isRetryable": true,
  "details": { "platform": "tistory", "operation": "createPost" }
}
```

## 레이트 리미팅
- 기본: 15분당 100 요청 (`windowMs: 900000, maxRequests: 100`)
- 설정: `config/web.yaml`의 `rateLimit` 섹션