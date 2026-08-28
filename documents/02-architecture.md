# 아키텍처

## 디렉토리 구조

```
blog-auto-poster/
├── src/
│   ├── core/           # 설정, 로깅, 에러, HTTP, 캐시
│   ├── affiliates/     # 제휴 네트워크 어댑터
│   ├── platforms/      # 블로그 플랫폼 어댑터
│   ├── content/        # 콘텐츠 파이프라인
│   ├── intelligence/   # 인텔리전스 레이어
│   ├── scheduler/      # 스케줄러 및 작업 큐
│   ├── cli/            # 커맨드라인 인터페이스
│   └── web/            # 관리자 웹 대시보드
│       ├── server/     # Fastify 백엔드 API
│       ├── client/     # React + Vite 프론트엔드
│       └── shared/     # 공통 타입 정의
├── templates/          # 핸들바 템플릿 (.hbs + 프론트매터)
├── config/             # YAML 설정 파일
├── data/               # SQLite DB, 로그, 캐시
└── output/             # 생성된 포스트, 이미지
```

## 모듈 간 의존성

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Config    │────▶│   Logger    │◀───│   Errors    │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              Core Interfaces (계약)                   │
│  AffiliateAdapter │ PlatformAdapter │ TemplateEngine │
│  ImageGenerator   │ KeywordProvider │ CompetitorAnalyzer│
│  JobQueue         │ TopicSelector   │ ConfigManager  │
└─────────────────────────────────────────────────────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ Affiliates  │     │ Platforms   │     │  Content    │
│  Coupang    │     │  Tistory    │     │  Template   │
│  (확장가능) │     │  WordPress  │     │  Image Gen  │
│             │     │  YouTube    │     │  Assembler  │
└─────────────┘     └─────────────┘     └─────────────┘
       │                   │                   │
       └───────────────────┼───────────────────┘
                           ▼
              ┌─────────────────────┐
              │   Intelligence      │
              │ KeywordResearcher   │
              │ CompetitorAnalyzer  │
              │ TopicSelector       │
              └─────────────────────┘
                           │
                           ▼
              ┌─────────────────────┐
              │    Scheduler        │
              │ JobQueue (SQLite)   │
              │ CronScheduler       │
              └─────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
        ┌──────────┐              ┌──────────┐
        │   CLI    │              │   Web    │
        │Commands  │              │Dashboard │
        └──────────┘              └──────────┘
```

## 데이터 플로우

### 1. 키워드 리서치 (매일 06:00)

```
Seed Keywords → KeywordResearcher (Multi-provider: Naver/Google/Coupang)
→ Volume/Competition/Trend 수집 → 캐싱 (24h TTL)
```

### 2. 경쟁 분석

```
Keywords → CompetitorAnalyzer (Naver Blog/Tistory/YouTube)
→ 상위 포스트 구조/제휴링크/CTA 추출 → TopicRecommendation 생성
```

### 3. 주제 선정

```
TopicSelector.select() → Score = Volume×0.3 + Commission×0.25 + Gap×0.25 + Trend×0.2
→ 우선순위 큐에 Job(RESEARCH/GENERATE) 인큐
```

### 4. 콘텐츠 생성 (매일 07:00)

```
Job(GENERATE) → CoupangAdapter.getProductDetails()
→ TemplateEngine.render() → ImageGenerator.generate()
→ PostAssembler.assemble() → PostContent (플랫폼별 변형 포함)
```

### 5. 발행 (매일 08:00)

```
Job(PUBLISH) → PlatformAdapter.createPost()
→ 발행 결과 기록 (published_posts 테이블)
```

### 6. 분석 동기화 (매시간)

```
Job(SYNC_ANALYTICS) → 플랫폼별 조회수/클릭/수익 수집
```

## 핵심 인터페이스 (src/core/interfaces.ts)

### AffiliateAdapter

```typescript
interface AffiliateAdapter {
  readonly name: string;
  readonly supportedCategories: string[];
  initialize(config: AffiliateConfig): Promise<void>;
  searchProducts(options: AffiliateSearchOptions): Promise<AffiliateSearchResult>;
  getProductDetails(productId: string): Promise<AffiliateProduct>;
  generateTrackingUrl(productId: string, subId?: string): Promise<string>;
  getCommissionRates(categoryId: string): Promise<Record<string, number>>;
  validateCredentials(): Promise<boolean>;
}
```

### PlatformAdapter

```typescript
interface PlatformAdapter {
  readonly name: string;
  readonly supportedFeatures: PlatformFeature[];
  initialize(credentials: PlatformCredentials): Promise<void>;
  createPost(content: PlatformPostContent): Promise<PlatformPostResult>;
  updatePost(postId: string, content: Partial<PlatformPostContent>): Promise<PlatformPostResult>;
  getCategories(blogName?: string): Promise<PlatformCategory[]>;
  uploadImage(imagePath: string, options?: any): Promise<PlatformImage>;
  validateCredentials(): Promise<boolean>;
}
```

### TemplateEngine

```typescript
interface TemplateEngine {
  registerHelper(name: string, helper: HandlebarsHelper): void;
  loadTemplates(): Promise<void>;
  validateTemplate(templateName: string): Promise<boolean>;
  render(templateName: string, data: TemplateData): Promise<TemplateRenderResult>;
  getTemplateNames(): string[];
  getTemplateInfo(templateName: string): TemplateFrontmatter | null;
}
```

### JobQueue

```typescript
interface JobQueue {
  enqueue(job: Omit<Job, 'id' | 'retryCount' | 'status'>): Promise<string>;
  dequeue(types?: JobType[]): Promise<Job | null>;
  complete(jobId: string, result?: Record<string, unknown>): Promise<void>;
  fail(jobId: string, error: string): Promise<void>;
  retry(jobId: string): Promise<boolean>;
  getJob(jobId: string): Promise<Job | null>;
  getJobs(filters?: JobFilters): Promise<Job[]>;
  getStats(): JobQueueStats;
  cleanup(olderThanDays: number): Promise<number>;
}
```

## 레지스트리 패턴

모든 어댑터는 팩토리 패턴으로 등록/조회:

```typescript
// 제휴 어댑터 등록
getAffiliateRegistry().register('coupang', CoupangAdapter);
const adapter = getAffiliateRegistry().getAdapter('coupang');

// 플랫폼 어댑터 등록
getPlatformRegistry().register('tistory', TistoryAdapter);
const platform = getPlatformRegistry().getAdapter('tistory');
```
