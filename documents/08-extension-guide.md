# 확장 가이드

## 개요
본 시스템은 **어댑터 패턴**과 **레지스트리 패턴**으로 설계되어 새로운 제휴 네트워크, 블로그 플랫폼, 이미지 생성 프로바이더, 템플릿을 코드 수정 없이 플러그인 형태로 추가할 수 있습니다.

---

## 1. 새 제휴 네트워크 어댑터 추가

### 1.1 인터페이스 구현
```typescript
// src/affiliates/new-affiliate/NewAffiliateAdapter.ts
import {
  AffiliateAdapter,
  AffiliateConfig,
  AffiliateProduct,
  AffiliateSearchOptions,
  AffiliateSearchResult,
} from '@core/interfaces';
import { AffiliateError, AuthenticationError } from '@core/errors';

export class NewAffiliateAdapter implements AffiliateAdapter {
  readonly name = 'new-affiliate';                    // 고유 식별자
  readonly supportedCategories = ['electronics', 'fashion', 'home']; // 지원 카테고리

  private config: AffiliateConfig | null = null;

  async initialize(config: AffiliateConfig): Promise<void> {
    this.config = config;
    // 인증 토큰 획득, 클라이언트 설정 등
  }

  async searchProducts(options: AffiliateSearchOptions): Promise<AffiliateSearchResult> {
    // 키워드 검색 API 호출 → AffiliateProduct[] 변환
    const products: AffiliateProduct[] = await this.callSearchAPI(options);
    return { products, totalCount: products.length, currentPage: 1, totalPages: 1 };
  }

  async getProductDetails(productId: string): Promise<AffiliateProduct> {
    // 상품 상세 API 호출 → AffiliateProduct 변환
    return this.callDetailAPI(productId);
  }

  async generateTrackingUrl(productId: string, subId?: string): Promise<string> {
    // 트래킹 URL 생성 (subId 포함)
    const baseUrl = await this.getProductLink(productId);
    return subId ? `${baseUrl}?subId=${subId}` : baseUrl;
  }

  async getCommissionRates(categoryId: string): Promise<Record<string, number>> {
    // 카테고리별 커미션율 조회
    return { [categoryId]: 0.03 }; // 3% 예시
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.searchProducts({ keyword: 'test', limit: 1 });
      return true;
    } catch {
      return false;
    }
  }

  // 내부 헬퍼 메서드들...
  private async callSearchAPI(options: AffiliateSearchOptions): Promise<AffiliateProduct[]> { ... }
  private async callDetailAPI(productId: string): Promise<AffiliateProduct> { ... }
  private async getProductLink(productId: string): Promise<string> { ... }
}
```

### 1.2 레지스트리에 등록
```typescript
// src/affiliates/registry.ts 에 추가
import { NewAffiliateAdapter } from './new-affiliate/NewAffiliateAdapter';

// adapterRegistry.set('new-affiliate', NewAffiliateAdapter);
// 또는 런타임에 동적 등록:
getAffiliateRegistry().register('new-affiliate', NewAffiliateAdapter);
```

### 1.3 설정 추가
```yaml
# config/default.yaml
affiliates:
  new-affiliate:
    enabled: true
    apiKey: ""          # 환경변수 또는 secrets.yaml
    apiSecret: ""
    baseUrl: "https://api.new-affiliate.com"
    rateLimit:
      requestsPerMinute: 60
```

### 1.4 AffiliateConfig 인터페이스 확장 (필요시)
```typescript
// src/core/interfaces.ts 에서 필요 필드 추가
export interface AffiliateConfig {
  apiKey?: string;
  apiSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  trackingId?: string;
  baseUrl?: string;           // 신규 추가
  customField?: string;       // 어댑터별 커스텀 필드
  rateLimit?: { requestsPerMinute: number };
  extra?: Record<string, unknown>;
}
```

---

## 2. 새 블로그 플랫폼 어댑터 추가

### 2.1 인터페이스 구현
```typescript
// src/platforms/new-platform/NewPlatformAdapter.ts
import {
  PlatformAdapter,
  PlatformCredentials,
  PlatformPostContent,
  PlatformPostResult,
  PlatformCategory,
  PlatformImage,
} from '@core/interfaces';
import { PlatformError, AuthenticationError } from '@core/errors';

export class NewPlatformAdapter implements PlatformAdapter {
  readonly name = 'new-platform';
  readonly supportedFeatures: PlatformFeature[] = [
    'categories', 'tags', 'featured_image', 'media_upload', 'scheduling'
  ];

  private client: AxiosInstance;
  private credentials: PlatformCredentials | null = null;

  async initialize(credentials: PlatformCredentials): Promise<void> {
    this.credentials = credentials;
    this.client = createHttpClient({
      baseURL: credentials.baseURL || 'https://api.new-platform.com',
      // 인증 헤더 설정 등
    });
    await this.validateConnection();
  }

  async createPost(content: PlatformPostContent): Promise<PlatformPostResult> {
    const response = await this.client.post('/posts', this.transformContent(content));
    return {
      postId: response.data.id,
      url: response.data.url,
      platform: 'new-platform',
      publishedAt: new Date().toISOString(),
    };
  }

  async updatePost(postId: string, content: Partial<PlatformPostContent>): Promise<PlatformPostResult> {
    await this.client.put(`/posts/${postId}`, this.transformContent(content));
    return { postId, url: '', platform: 'new-platform', publishedAt: new Date().toISOString() };
  }

  async getCategories(blogName?: string): Promise<PlatformCategory[]> {
    const response = await this.client.get('/categories');
    return response.data.map(c => ({ id: c.id, name: c.name, parentId: c.parent_id, slug: c.slug }));
  }

  async uploadImage(imagePath: string, options?: any): Promise<PlatformImage> {
    const formData = new FormData();
    formData.append('file', fs.createReadStream(imagePath), options);
    const response = await this.client.post('/media', formData, { headers: formData.getHeaders() });
    return {
      url: response.data.url,
      localPath: imagePath,
      filename: path.basename(imagePath),
      size: fs.statSync(imagePath).size,
      mimeType: response.data.mime_type,
    };
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.client.get('/me');
      return true;
    } catch {
      return false;
    }
  }

  private transformContent(content: PlatformPostContent): any {
    // 플랫폼별 포맷 변환 (HTML → 마크다운, 블록 에디터 포맷 등)
    return {
      title: content.title,
      content: content.content,
      tags: content.tags,
      categories: content.categories,
      status: content.visibility === 'private' ? 'private' : 'publish',
    };
  }
}
```

### 2.2 레지스트리에 등록
```typescript
// src/platforms/registry.ts
import { NewPlatformAdapter } from './new-platform/NewPlatformAdapter';

getPlatformRegistry().register('new-platform', NewPlatformAdapter);
```

### 2.3 설정 추가
```yaml
# config/default.yaml
platforms:
  new-platform:
    enabled: false
    baseURL: "https://api.new-platform.com"
    username: ""      # 환경변수
    apiKey: ""        # 환경변수
    rateLimit:
      requestsPerMinute: 30
```

---

## 3. 새 이미지 생성 프로바이더 추가

### 3.1 인터페이스 구현
```typescript
// src/content/providers/NewImageProvider.ts
import { ImageProvider, ImageGenerationOptions, ImageGenerationResult } from '@core/interfaces';

export class NewImageProvider implements ImageProvider {
  readonly name = 'new-provider';

  constructor(private config: { apiKey: string; model?: string }) {}

  async generate(prompt: string, options: ImageGenerationOptions): Promise<ImageGenerationResult> {
    // API 호출
    const response = await this.callAPI({
      prompt,
      model: this.config.model || 'default',
      aspect_ratio: options.aspectRatio || '1:1',
      n: options.count || 1,
    });

    return {
      urls: response.data.images.map(img => img.url),
      localPaths: [], // 다운로드는 ImageGeneratorImpl에서 처리
      provider: this.name,
    };
  }

  async validateConfig(): Promise<boolean> {
    return !!this.config.apiKey;
  }
}
```

### 3.2 등록
```typescript
// 사용 시
const imageGenerator = createImageGenerator();
imageGenerator.registerProvider('new-provider', new NewImageProvider({ apiKey: 'xxx' }));
imageGenerator.setDefaultProvider('new-provider');
```

---

## 4. 새 템플릿 추가

### 4.1 템플릿 파일 생성
```handlebars
---
name: "my-custom-template"
platforms: ["tistory", "wordpress", "youtube-shorts"]
requiredFields: ["productName", "price", "pros", "cons", "affiliateUrl"]
optionalFields: ["originalPrice", "discountRate", "rating", "reviewCount", "imageUrl", "brand", "categoryName", "description", "specs"]
seo:
  titleTemplate: "{{productName}} 리뷰 - 맞춤형 템플릿"
  descriptionTemplate: "{{productName}} 구매 가이드. 가격 {{price}}원..."
  keywords: ["{{productName}}", "리뷰", "추천", "{{categoryName}}"]
  jsonLd:
    type: "Product"
    includeReview: true
    includeAggregateRating: true
---

<div class="my-template">
  <h1>{{productName}}</h1>
  
  {{#if imageUrl}}
  <img src="{{imageUrl}}" alt="{{productName}}" loading="lazy" />
  {{/if}}

  <div class="price">{{formatPrice price}}원</div>

  <section class="pros">
    <h3>장점</h3>
    <ul>{{#each pros}}<li>{{this}}</li>{{/each}}</ul>
  </section>

  <section class="cons">
    <h3>단점</h3>
    <ul>{{#each cons}}<li>{{this}}</li>{{/each}}</ul>
  </section>

  <a href="{{affiliateUrl}}" target="_blank" rel="nofollow sponsored" class="cta">
    구매하러 가기 →
  </a>
</div>

<style>
/* 템플릿 전용 CSS */
</style>
```

### 4.2 템플릿 저장
```bash
# templates/my-custom-template.hbs 로 저장
# 자동으로 로드됨 (TemplateEngine.loadTemplates() 시 *.hbs 파일 스캔)
```

### 4.3 템플릿 헬퍼 추가 (필요시)
```typescript
// TemplateEngineImpl.registerBuiltinHelpers() 내부 또는 외부에서
Handlebars.registerHelper('myCustomHelper', function(value: any, options: HandlebarsOptions) {
  // 커스텀 로직
  return transformedValue;
});
```

---

## 5. 새 스케줄러 잡 추가

### 5.1 설정 추가
```yaml
# config/default.yaml
scheduler:
  jobs:
    - name: "my-custom-job"
      type: "GENERATE"  # RESEARCH | GENERATE | PUBLISH | SYNC_ANALYTICS | REFRESH_TOKEN | CLEANUP
      cron: "0 9 * * *"  # 매일 09:00
      enabled: true
      priority: 5
      maxAttempts: 3
      config:
        customParam: "value"
```

### 5.2 프로세서 등록 (필요시)
```typescript
// src/scheduler/index.ts 또는 별도 파일
const jobQueue = createJobQueue();

jobQueue.registerProcessor('CUSTOM_TYPE', async (job: Job) => {
  // 커스텀 로직
  const result = await doCustomWork(job.payload);
  return result;
});
```

---

## 6. 새 CLI 명령어 추가

### 6.1 명령어 정의
```typescript
// src/cli/index.ts
program
  .command('my-command')
  .description('내 커스텀 명령어')
  .option('-p, --param <value>', '파라미터 설명')
  .action(async (options) => {
    const configDir = program.opts().config;
    const env = program.opts().env;
    
    await initializeServices(configDir, env);
    
    // 로직 구현
    console.log('실행됨:', options.param);
  });
```

---

## 7. 새 웹 대시보드 페이지 추가

### 7.1 페이지 컴포넌트 생성
```tsx
// src/web/client/src/pages/MyPage.tsx
import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';

export default function MyPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api.get('/api/my-endpoint').then(res => setData(res.data));
  }, []);

  return (
    <Card>
      <CardHeader><CardTitle>내 커스텀 페이지</CardTitle></CardHeader>
      <CardContent>
        {/* UI 구현 */}
      </CardContent>
    </Card>
  );
}
```

### 7.2 라우터 등록
```tsx
// src/web/client/src/App.tsx
import MyPage from './pages/MyPage';

// Routes 내부에 추가
<Route path="my-page" element={<MyPage />} />
```

### 7.3 사이드바 네비게이션 추가
```tsx
// src/web/client/src/components/Layout.tsx
const navigation = [
  // ... 기존 항목들
  { name: '내 페이지', href: '/my-page', icon: MyIcon },
];
```

### 7.4 API 엔드포인트 추가
```typescript
// src/web/server/routes/index.ts
app.get('/api/my-endpoint', async () => {
  return { data: 'my custom data' };
});
```

---

## 8. 타입 안전성 유지 가이드

### 8.1 인터페이스 변경 시 체크리스트
- [ ] `src/core/interfaces.ts` 에서 인터페이스 수정
- [ ] `tsc --noEmit` 으로 타입 에러 확인
- [ ] 구현체들(`*Adapter.ts`, `*Impl.ts`)에서 컴파일 에러 수정
- [ ] 관련 테스트 업데이트

### 8.2 엄격 모드 준수
```typescript
// ❌ 금지: any 타입 사용
const data: any = fetchData();

// ✅ 권장: 명시적 타입 또는 제네릭
const data: MyType = fetchData();
const data = fetchData<MyType>();

// ✅ 선택적 속성은 undefined 포함 명시
interface Config {
  optionalField?: string;  // undefined 허용
  requiredField: string;   // 필수
}
```

---

## 9. 테스트 작성 가이드

### 9.1 단위 테스트 (Vitest)
```typescript
// tests/unit/NewAdapter.test.ts
import { describe, it, expect, vi } from 'vitest';
import { NewAffiliateAdapter } from '@affiliates/new-affiliate/NewAffiliateAdapter';

describe('NewAffiliateAdapter', () => {
  it('should search products', async () => {
    const adapter = new NewAffiliateAdapter();
    // mock 설정
    const result = await adapter.searchProducts({ keyword: 'test' });
    expect(result.products).toBeDefined();
  });
});
```

### 9.2 통합 테스트
```typescript
// tests/integration/pipeline.test.ts
import { describe, it, expect } from 'vitest';
import { createPostAssembler } from '@content/PostAssembler';

describe('Content Pipeline', () => {
  it('should assemble post from template and product', async () => {
    const assembler = createPostAssembler(templateEngine, imageGenerator);
    const post = await assembler.assemble({ template: '...', affiliateData: mockProduct });
    expect(post.status).toBe('READY');
  });
});
```

---

## 10. 배포 시 체크리스트

- [ ] `npm run typecheck` 통과
- [ ] `npm run lint` 통과
- [ ] `npm run test` 통과
- [ ] `npm run build` 성공
- [ ] `npm run build:web` 성공
- [ ] 새 설정 파일이 `config/default.yaml`에 반영됨
- [ ] `config/secrets.yaml.example`에 새 키 템플릿 추가
- [ ] 문서(`documents/`) 업데이트
- [ ] CHANGELOG.md 갱신