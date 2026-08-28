import { getLogger } from '@core/logger';
import { getConfigManager } from '@core/config';
import { TemplateEngineImpl } from './TemplateEngine';
import { ImageGeneratorImpl } from './ImageGenerator';
import { ContentGenerator, createContentGeneratorFromConfig, TopPost } from './ContentGenerator';
import {
  PostContent,
  PlatformPostContent,
  AffiliateProduct,
  TemplateRenderResult,
  ImageGenerationResult,
  PostStatus,
} from '@core/interfaces';

const logger = getLogger('post-assembler');

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

export interface SEOData {
  title: string;
  description: string;
  keywords: string[];
  jsonLd?: Record<string, unknown>;
}

export interface AssembleOptions {
  template: string;
  affiliateData: AffiliateProduct;
  images?: ImageGenerationResult;
  seoData?: SEOData;
  platform?: string;
  subId?: string;
  benchmarkKeyword?: string;
}

export class PostAssembler {
  private templateEngine: TemplateEngineImpl;
  private imageGenerator: ImageGeneratorImpl;
  private _contentGenerator: ContentGenerator | null | undefined;

  constructor(templateEngine: TemplateEngineImpl, imageGenerator: ImageGeneratorImpl) {
    this.templateEngine = templateEngine;
    this.imageGenerator = imageGenerator;
  }

  async assemble(options: AssembleOptions): Promise<PostContent> {
    const { template, affiliateData, images, seoData, platform, subId } = options;

    logger.info({ template, productId: affiliateData.id, platform }, 'Assembling post');

    // Generate affiliate tracking URL if subId provided
    const affiliateUrl = subId
      ? `${affiliateData.productUrl}${affiliateData.productUrl.includes('?') ? '&' : '?'}subId=${subId}`
      : affiliateData.productUrl;

    // Prepare template data (async: may fetch benchmark posts + LLM copy)
    const templateData = await this.prepareTemplateData(
      affiliateData,
      affiliateUrl,
      images,
      seoData,
      options.benchmarkKeyword,
    );

    // Render template
    const renderResult = await this.templateEngine.render(template, templateData);

    // Generate platform-specific content
    const platformContent = this.generatePlatformContent(
      renderResult,
      platform,
      affiliateData,
      images,
      seoData,
    );

    const postContent: PostContent = {
      id: `post-${Date.now()}-${Math.random().toString(36).substring(7)}`,
      template,
      productId: affiliateData.id,
      platform: platform || 'unknown',
      status: 'READY' as PostStatus,
      title: renderResult.title,
      content: renderResult.content,
      meta: renderResult.meta,
      tags: renderResult.tags,
      categories: renderResult.categories,
      platformContent,
      affiliateUrl,
      images: images?.localPaths || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    logger.info({ postId: postContent.id }, 'Post assembled successfully');
    return postContent;
  }

  private async prepareTemplateData(
    affiliateData: AffiliateProduct,
    affiliateUrl: string,
    images?: ImageGenerationResult,
    seoData?: SEOData,
    benchmarkKeyword?: string,
  ): Promise<Record<string, unknown>> {
    const pros = affiliateData.tags
      ?.filter((t) => t.startsWith('pro:'))
      ?.map((t) => t.substring(4)) || ['가성비 우수', '배송 빠름', '품질 만족'];
    const cons = affiliateData.tags
      ?.filter((t) => t.startsWith('con:'))
      ?.map((t) => t.substring(4)) || ['색상 옵션 부족', '설명서 미흡'];

    const templateData: Record<string, unknown> = {
      productName: affiliateData.name,
      price: affiliateData.price,
      originalPrice: affiliateData.originalPrice,
      discountRate: affiliateData.discountRate,
      currency: affiliateData.currency,
      rating: affiliateData.rating,
      reviewCount: affiliateData.reviewCount,
      imageUrl: images?.localPaths[0] || images?.urls[0] || affiliateData.imageUrl,
      productUrl: affiliateData.productUrl,
      affiliateUrl,
      categoryId: affiliateData.categoryId,
      categoryName: affiliateData.categoryName,
      brand: affiliateData.brand,
      description: affiliateData.description,
      specs: affiliateData.specs,
      availability: affiliateData.availability,
      tags: affiliateData.tags,
      pros,
      cons,
      seoTitle: seoData?.title,
      seoDescription: seoData?.description,
      seoKeywords: seoData?.keywords,
      jsonLd: seoData?.jsonLd,
    };

    // Benchmark: inject top-ranking Naver blog posts for the keyword as an
    // OPTIONAL `topPosts` field so templates can render a benchmark section.
    const keyword = benchmarkKeyword || affiliateData.name || affiliateData.categoryName || '';
    const topPosts = await this.fetchBenchmarkPosts(keyword);
    if (topPosts.length > 0) {
      templateData.topPosts = topPosts;
    }

    // LLM first-person experience copy (Q3). Optional; when absent the template
    // falls back to its own static first-person copy.
    try {
      const generator = this.getContentGenerator();
      const experience = await generator.generateExperience(
        {
          name: affiliateData.name,
          categoryName: affiliateData.categoryName,
          brand: affiliateData.brand,
          price: affiliateData.price,
          description: affiliateData.description,
        },
        keyword,
        topPosts,
      );
      if (experience) {
        templateData.experienceIntro = experience.experienceIntro;
        templateData.realUsageStory = experience.realUsageStory;
        templateData.whyIChoseIt = experience.whyIChoseIt;
        templateData.conclusion = experience.conclusion;
        templateData.usageTips = experience.usageTips;
        templateData.buyingChecklist = experience.buyingChecklist;
      }
    } catch (error) {
      logger.warn({ error: String(error) }, 'Experience generation skipped; using template copy');
    }

    return templateData;
  }

  private getContentGenerator(): ContentGenerator | null {
    if (this._contentGenerator === undefined) {
      try {
        this._contentGenerator = createContentGeneratorFromConfig();
      } catch {
        this._contentGenerator = null;
      }
    }
    return this._contentGenerator;
  }

  private async fetchBenchmarkPosts(keyword: string): Promise<TopPost[]> {
    if (!keyword) return [];
    try {
      const cm = getConfigManager();
      const hubConfig = cm.getKeywordProviderConfig('naver-api-hub');
      if (!hubConfig?.apiKey || !hubConfig?.apiSecret) return [];
      const { NaverApiHubKeywordProvider } = await import('../intelligence/NaverApiHubProvider.js');
      const provider = new NaverApiHubKeywordProvider(hubConfig);
      const res = (await provider.searchBlog(keyword, 10)) as {
        items?: Array<Record<string, unknown>>;
      };
      const items = res?.items ?? [];
      return items.slice(0, 10).map((i) => ({
        title: stripHtml(String(i.title ?? '')),
        bloggername: String(i.bloggername ?? ''),
        link: String(i.link ?? ''),
        snippet: stripHtml(String(i.description ?? '')),
      }));
    } catch (error) {
      logger.warn(
        { keyword, error: String(error) },
        'Benchmark post fetch failed; continuing without topPosts',
      );
      return [];
    }
  }

  private generatePlatformContent(
    renderResult: TemplateRenderResult,
    platform: string | undefined,
    affiliateData: AffiliateProduct,
    _images?: ImageGenerationResult,
    _seoData?: SEOData,
  ): Record<string, PlatformPostContent> {
    const baseContent: PlatformPostContent = {
      title: renderResult.title,
      content: renderResult.content,
      tags: renderResult.tags,
      categories: renderResult.categories,
      meta: renderResult.meta,
      visibility: 'public',
      allowComments: true,
    };

    const platformContent: Record<string, PlatformPostContent> = {};

    if (!platform || platform === 'tistory') {
      platformContent.tistory = {
        ...baseContent,
        // Tistory specific: HTML content
        content: this.convertToTistoryHtml(renderResult.content),
      };
    }

    if (!platform || platform === 'wordpress') {
      platformContent.wordpress = {
        ...baseContent,
        // WordPress specific: Gutenberg blocks format
        content: this.convertToWordPressBlocks(renderResult.content),
        meta: {
          ...baseContent.meta,
          _yoast_wpseo_title: renderResult.title,
          _yoast_wpseo_metadesc: renderResult.meta?.description,
        },
      };
    }

    if (!platform || platform === 'youtube-shorts') {
      platformContent['youtube-shorts'] = {
        ...baseContent,
        title: this.extractShortsTitle(renderResult.title),
        description: this.generateShortsDescription(renderResult, affiliateData),
        tags: this.extractHashtags(renderResult.meta?.keywords || []),
        categories: ['22'], // People & Blogs
        visibility: 'public',
        videoPath: '', // Will be set separately
      };
    }

    return platformContent;
  }

  private convertToTistoryHtml(content: string): string {
    // Tistory accepts HTML directly, but we may need to adjust
    return content;
  }

  private convertToWordPressBlocks(content: string): string {
    // Convert HTML to Gutenberg blocks format
    // This is a simplified version - real implementation would be more complex
    return `<!-- wp:html -->\n${content}\n<!-- /wp:html -->`;
  }

  private extractShortsTitle(title: string): string {
    // YouTube Shorts title max 100 chars, add #Shorts
    const maxLength = 90;
    const shortTitle = title.length > maxLength ? title.substring(0, maxLength) + '...' : title;
    return `${shortTitle} #Shorts`;
  }

  private generateShortsDescription(
    renderResult: TemplateRenderResult,
    affiliateData: AffiliateProduct,
  ): string {
    const lines = [
      renderResult.meta?.description || '',
      '',
      `🛒 구매 링크: ${affiliateData.productUrl}`,
      '',
      '#Shorts #리뷰 #추천 #가성비',
    ];

    if (renderResult.meta?.keywords) {
      const hashtags = renderResult.meta.keywords
        .slice(0, 10)
        .map((k) => `#${k.replace(/\s+/g, '')}`)
        .join(' ');
      lines.push(hashtags);
    }

    return lines.join('\n');
  }

  private extractHashtags(keywords: string[]): string[] {
    return keywords
      .slice(0, 15)
      .map((k) => k.replace(/\s+/g, ''))
      .filter((k) => k.length > 1);
  }
}

export function createPostAssembler(
  templateEngine: TemplateEngineImpl,
  imageGenerator: ImageGeneratorImpl,
): PostAssembler {
  return new PostAssembler(templateEngine, imageGenerator);
}
