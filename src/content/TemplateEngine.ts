import Handlebars from 'handlebars';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { getLogger } from '@core/logger';
import {
  TemplateEngine,
  TemplateFrontmatter,
  TemplateRenderResult,
  TemplateData,
  HandlebarsHelper,
  HandlebarsContext,
  HandlebarsOptions,
} from '@core/interfaces';
import { TemplateError, ValidationError } from '@core/errors';

const logger = getLogger('template-engine');

interface ParsedTemplate {
  frontmatter: TemplateFrontmatter;
  content: string;
  rawContent: string;
}

/**
 * Handlebars 헬퍼는 전역 싱글턴에 등록되므로 모듈 레벨에서 한 번만 등록한다.
 * (이전에는 TemplateEngineImpl 인스턴스 플래그로 관리하고 `math`는 프리뷰
 *  라우트에서만 등록해, 프리뷰를 거치지 않은 초안 생성이 Missing helper로 실패했다.)
 */
let builtinHelpersRegistered = false;

export function registerBuiltinTemplateHelpers(): void {
  if (builtinHelpersRegistered) return;

  // Format price with Korean won formatting
  Handlebars.registerHelper('formatPrice', (price: number): string => {
    if (typeof price !== 'number') return String(price);
    return price.toLocaleString('ko-KR');
  });

  // Truncate text to specified length
  Handlebars.registerHelper(
    'truncate',
    (text: string, length: number, suffix: string = '...'): string => {
      if (!text || text.length <= length) return text || '';
      return text.substring(0, length - suffix.length) + suffix;
    },
  );

  // Render stars for rating
  Handlebars.registerHelper('renderStars', (rating: number, maxStars: number = 5): string => {
    const fullStars = Math.floor(rating);
    const hasHalfStar = rating - fullStars >= 0.5;
    const emptyStars = maxStars - fullStars - (hasHalfStar ? 1 : 0);

    let stars = '★'.repeat(fullStars);
    if (hasHalfStar) stars += '☆';
    stars += '☆'.repeat(emptyStars);
    return stars;
  });

  // SEO keywords extraction
  Handlebars.registerHelper(
    'seoKeywords',
    (data: TemplateData, maxKeywords: number = 10): string => {
      const keywords: string[] = [];

      if (data.productName) keywords.push(String(data.productName));
      if (data.categoryName) keywords.push(String(data.categoryName));
      if (data.brand) keywords.push(String(data.brand));
      if (data.tags && Array.isArray(data.tags)) {
        keywords.push(...data.tags.map(String));
      }

      // Add default keywords
      keywords.push('리뷰', '추천', '가성비', '후기');

      const unique = [...new Set(keywords)];
      return unique.slice(0, maxKeywords).join(', ');
    },
  );

  // Affiliate link formatter
  Handlebars.registerHelper(
    'affiliateLink',
    (url: string, text: string, subId?: string): string => {
      if (!url) return text;
      const separator = url.includes('?') ? '&' : '?';
      const finalUrl = subId ? `${url}${separator}subId=${subId}` : url;
      return `<a href="${finalUrl}" target="_blank" rel="nofollow sponsored">${text}</a>`;
    },
  );

  // Format date
  Handlebars.registerHelper(
    'formatDate',
    (date: string | Date, format: string = 'YYYY-MM-DD'): string => {
      const d = new Date(date);
      if (isNaN(d.getTime())) return '';
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return format.replace('YYYY', String(year)).replace('MM', month).replace('DD', day);
    },
  );

  // Conditional helper
  Handlebars.registerHelper(
    'ifEq',
    function (this: HandlebarsContext, a: unknown, b: unknown, options: HandlebarsOptions): string {
      return a === b ? options.fn!(this) : options.inverse!(this);
    },
  );

  Handlebars.registerHelper(
    'ifNe',
    function (this: HandlebarsContext, a: unknown, b: unknown, options: HandlebarsOptions): string {
      return a !== b ? options.fn!(this) : options.inverse!(this);
    },
  );

  Handlebars.registerHelper(
    'ifGt',
    function (this: HandlebarsContext, a: number, b: number, options: HandlebarsOptions): string {
      return a > b ? options.fn!(this) : options.inverse!(this);
    },
  );

  Handlebars.registerHelper(
    'ifLt',
    function (this: HandlebarsContext, a: number, b: number, options: HandlebarsOptions): string {
      return a < b ? options.fn!(this) : options.inverse!(this);
    },
  );

  // JSON stringify for debugging
  Handlebars.registerHelper('json', (context: unknown): string => {
    return JSON.stringify(context, null, 2);
  });

  // Join array
  Handlebars.registerHelper('join', (arr: unknown[], separator: string = ', '): string => {
    if (!Array.isArray(arr)) return '';
    return arr.join(separator);
  });

  // Arithmetic — 템플릿의 {{math @index "+" 1}} 같은 인덱스 계산용
  Handlebars.registerHelper('math', (a: number, op: string, b: number): number => {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return NaN;
    switch (op) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        return right === 0 ? NaN : left / right;
      case '%':
        return right === 0 ? NaN : left % right;
      default:
        return NaN;
    }
  });

  builtinHelpersRegistered = true;
}

export class TemplateEngineImpl implements TemplateEngine {
  private templates = new Map<string, ParsedTemplate>();
  private compiledTemplates = new Map<string, HandlebarsTemplateDelegate>();
  private templatesDir: string;

  constructor(templatesDir: string = './templates') {
    this.templatesDir = templatesDir;
    registerBuiltinTemplateHelpers();
  }

  registerHelper(name: string, helper: HandlebarsHelper): void {
    Handlebars.registerHelper(name, helper);
  }

  async loadTemplates(): Promise<void> {
    if (!fs.existsSync(this.templatesDir)) {
      logger.warn({ dir: this.templatesDir }, 'Templates directory does not exist');
      return;
    }

    const files = fs
      .readdirSync(this.templatesDir)
      .filter((f) => f.endsWith('.hbs') || f.endsWith('.handlebars'));

    for (const file of files) {
      try {
        const template = await this.parseTemplate(file);
        this.templates.set(template.frontmatter.name, template);
        logger.debug({ name: template.frontmatter.name }, 'Template loaded');
      } catch (error) {
        logger.error({ file, error: String(error) }, 'Failed to load template');
      }
    }

    logger.info({ count: this.templates.size }, 'Templates loaded');
  }

  private async parseTemplate(filename: string): Promise<ParsedTemplate> {
    const filePath = path.join(this.templatesDir, filename);
    const rawContent = fs.readFileSync(filePath, 'utf-8');

    // Parse frontmatter (YAML between --- delimiters)
    const frontmatterMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!frontmatterMatch) {
      throw new TemplateError(
        `Invalid template format: missing frontmatter in ${filename}`,
        'PARSE_FAILED',
        filename,
      );
    }

    const frontmatterYaml = frontmatterMatch[1]!;
    const content = frontmatterMatch[2]!;

    let frontmatter: TemplateFrontmatter;
    try {
      frontmatter = yaml.load(frontmatterYaml) as TemplateFrontmatter;
    } catch (error) {
      throw new TemplateError(
        `Invalid frontmatter YAML in ${filename}: ${String(error)}`,
        'PARSE_FAILED',
        filename,
      );
    }

    // Validate required fields
    if (!frontmatter.name) {
      throw new TemplateError(
        `Template missing 'name' in frontmatter: ${filename}`,
        'VALIDATION_FAILED',
        filename,
      );
    }

    if (!frontmatter.requiredFields || !Array.isArray(frontmatter.requiredFields)) {
      frontmatter.requiredFields = [];
    }

    return { frontmatter, content, rawContent };
  }

  async validateTemplate(templateName: string): Promise<boolean> {
    const template = this.templates.get(templateName);
    if (!template) {
      return false;
    }

    // Compile to check for syntax errors
    try {
      Handlebars.compile(template.content);
      return true;
    } catch (error) {
      logger.error({ templateName, error: String(error) }, 'Template validation failed');
      return false;
    }
  }

  async render(templateName: string, data: TemplateData): Promise<TemplateRenderResult> {
    const template = this.templates.get(templateName);
    if (!template) {
      throw new TemplateError(`Template not found: ${templateName}`, 'NOT_FOUND', templateName);
    }

    // Validate required fields
    for (const field of template.frontmatter.requiredFields) {
      if (
        !(field in data) ||
        data[field] === undefined ||
        data[field] === null ||
        data[field] === ''
      ) {
        throw new ValidationError(
          `Required field missing: ${field}`,
          field,
          data[field],
          [`Required field: ${field}`],
          'VALIDATION_ERROR',
          400,
          { templateName, missingField: field },
        );
      }
    }

    // Get or compile template
    let compiled = this.compiledTemplates.get(templateName);
    if (!compiled) {
      compiled = Handlebars.compile(template.content);
      this.compiledTemplates.set(templateName, compiled);
    }

    // Prepare data with helpers
    const renderData: TemplateData = {
      ...data,
      // Add computed fields
      currentYear: new Date().getFullYear(),
      currentDate: new Date().toISOString().split('T')[0],
    };

    // Render content
    const content = compiled(renderData);

    // Render SEO fields if present
    let title = '';
    let description = '';
    let keywords: string[] = [];
    let jsonLd: Record<string, unknown> | undefined;

    if (template.frontmatter.seo) {
      const seo = template.frontmatter.seo;
      const seoTemplate = Handlebars.compile(seo.titleTemplate || '');
      title = seoTemplate(renderData);

      const descTemplate = Handlebars.compile(seo.descriptionTemplate || '');
      description = descTemplate(renderData);

      if (seo.keywords && Array.isArray(seo.keywords)) {
        const keywordTemplates = seo.keywords.map((k) => Handlebars.compile(k));
        keywords = keywordTemplates.map((t) => t(renderData));
      }

      if (seo.jsonLd) {
        jsonLd = this.generateJsonLd(seo, renderData);
      }
    }

    return {
      title,
      content,
      meta: {
        description,
        keywords,
        jsonLd,
      },
      tags: template.frontmatter.requiredFields.includes('tags') ? (data.tags as string[]) : [],
      categories: template.frontmatter.requiredFields.includes('category')
        ? [data.category as string]
        : [],
    };
  }

  private generateJsonLd(
    seo: TemplateFrontmatter['seo'],
    data: TemplateData,
  ): Record<string, unknown> | undefined {
    if (!seo || (!seo.jsonLd?.includeReview && !seo.jsonLd?.includeAggregateRating))
      return undefined;

    const jsonLd: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': seo.jsonLd.type || 'Product',
    };

    if (data.productName) jsonLd.name = data.productName;
    if (data.imageUrl) jsonLd.image = data.imageUrl;
    if (data.description) jsonLd.description = data.description;
    if (data.brand) jsonLd.brand = { '@type': 'Brand', name: data.brand };
    if (data.price) {
      jsonLd.offers = {
        '@type': 'Offer',
        price: data.price,
        priceCurrency: data.currency || 'KRW',
        availability:
          data.availability === 'in_stock'
            ? 'https://schema.org/InStock'
            : 'https://schema.org/OutOfStock',
        url: data.affiliateUrl,
      };
    }

    if (seo.jsonLd.includeAggregateRating && data.rating && data.reviewCount) {
      jsonLd.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: data.rating,
        reviewCount: data.reviewCount,
        bestRating: 5,
        worstRating: 1,
      };
    }

    if (seo.jsonLd.includeReview && data.reviewCount && (data.reviewCount as number) > 0) {
      jsonLd.review = {
        '@type': 'Review',
        author: { '@type': 'Person', name: '블로그 자동 포스터' },
        datePublished: new Date().toISOString(),
        reviewBody: data.description || '',
        reviewRating: {
          '@type': 'Rating',
          ratingValue: data.rating || 0,
          bestRating: 5,
          worstRating: 1,
        },
      };
    }

    return jsonLd;
  }

  getTemplateNames(): string[] {
    return Array.from(this.templates.keys());
  }

  getTemplateInfo(templateName: string): TemplateFrontmatter | null {
    return this.templates.get(templateName)?.frontmatter || null;
  }

  /**
   * 템플릿 본문 원문(frontmatter 제거된 handlebars 소스)을 반환한다.
   *
   * 이슈 #20 원인 D: 생성 이미지 수를 본문 슬롯 수와 맞추려면 템플릿이 실제로
   * 참조하는 `sectionImages.<key>` 슬롯을 알아야 한다. 프론트매터에는 슬롯 정보가
   * 없으므로 본문 소스를 노출해 imagePrompts.extractSectionImageSlots가 문서 순서로
   * 스캔하게 한다. 미로드/미존재 템플릿은 null.
   */
  getTemplateSource(templateName: string): string | null {
    return this.templates.get(templateName)?.content ?? null;
  }

  getAllTemplateInfos(): Map<string, TemplateFrontmatter> {
    const infos = new Map<string, TemplateFrontmatter>();
    for (const [name, template] of this.templates) {
      infos.set(name, template.frontmatter);
    }
    return infos;
  }
}

export function createTemplateEngine(templatesDir?: string): TemplateEngineImpl {
  return new TemplateEngineImpl(templatesDir);
}
