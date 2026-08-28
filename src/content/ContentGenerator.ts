import { getLogger } from '@core/logger';
import { getConfigManager } from '@core/config';
import type { AffiliateProduct } from '@core/interfaces';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

const logger = getLogger('content-generator');

export interface TopPost {
  title: string;
  bloggername: string;
  link: string;
  snippet: string;
}

export interface GeneratedExperience {
  experienceIntro: string;
  realUsageStory: string;
  whyIChoseIt: string;
  conclusion: string;
  usageTips: string[];
  buyingChecklist: string[];
}

export interface TemplateDataRequest {
  keyword: string;
  topPosts: TopPost[];
  /** 해당 템플릿의 requiredFields + optionalFields */
  fields: string[];
}

/**
 * 템플릿 필드 셰이프 스펙 (preview 샘플과 템플릿 사용부에서 확인한 그대로).
 * generateTemplateData의 프롬프트 생성과 응답 검증에 모두 사용된다.
 */
export interface FieldSpec {
  type: 'text' | 'text[]' | 'object[]' | 'object' | 'objectMap' | 'number';
  /** object/object[] 항목의 키 목록 */
  fields?: string[];
  /** object[]: 누락 시 ''로 채우는 선택 키 */
  optionalFields?: string[];
  min?: number;
  max?: number;
}

export const FIELD_SPECS: Record<string, FieldSpec> = {
  // text
  experienceIntro: { type: 'text' },
  realUsageStory: { type: 'text' },
  whyIChoseIt: { type: 'text' },
  conclusion: { type: 'text' },
  description: { type: 'text' },
  intro: { type: 'text' },
  oneLineReview: { type: 'text' },
  // string[]
  pros: { type: 'text[]' },
  cons: { type: 'text[]' },
  usageTips: { type: 'text[]' },
  buyingChecklist: { type: 'text[]' },
  targetAudience: { type: 'text[]' },
  // object[]
  faqList: { type: 'object[]', fields: ['question', 'answer'], min: 3, max: 5 },
  checklist: { type: 'object[]', fields: ['title', 'description'], min: 5, max: 8 },
  mistakesToAvoid: { type: 'object[]', fields: ['title', 'description'], min: 3, max: 5 },
  budgetSteps: {
    type: 'object[]',
    fields: ['range', 'productName', 'reason', 'affiliateUrl'],
    optionalFields: ['affiliateUrl'],
    min: 2,
    max: 4,
  },
  budgetRanges: { type: 'object[]', fields: ['range', 'productName', 'reason'], min: 2, max: 4 },
  recommendations: { type: 'object[]', fields: ['title', 'productName', 'reason'], min: 2, max: 3 },
  products: {
    type: 'object[]',
    fields: ['name', 'price', 'brand', 'description', 'pros', 'cons', 'affiliateUrl'],
    optionalFields: ['affiliateUrl'],
    min: 2,
    max: 3,
  },
  // object
  topPick: {
    type: 'object',
    fields: ['productName', 'reason', 'affiliateUrl'],
    optionalFields: ['affiliateUrl'],
  },
  comparisonTable: { type: 'object', fields: ['columns', 'rows'] },
  // Record<string, string>
  specs: { type: 'objectMap', min: 5, max: 8 },
  price: { type: 'number' },
};

function toText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? String(value) : null;
}

function toTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value
    .map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : ''))
    .filter((s) => s.length > 0);
  return arr.length > 0 ? arr : null;
}

function toSpecItem(item: unknown, spec: FieldSpec): Record<string, unknown> | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of spec.fields || []) {
    const value = rec[key];
    if (Array.isArray(value)) {
      const arr = toTextArray(value);
      if (arr === null) return null;
      out[key] = arr;
      continue;
    }
    if (typeof value === 'number') {
      out[key] = value;
      continue;
    }
    const text = toText(value);
    if (text !== null) {
      out[key] = text;
      continue;
    }
    if (spec.optionalFields?.includes(key)) {
      out[key] = '';
      continue;
    }
    return null;
  }
  return out;
}

function validateComparisonTable(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  const columns = toTextArray(rec.columns);
  if (!columns || !Array.isArray(rec.rows)) return null;
  const rows = rec.rows
    .map((r) => {
      if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
      const rr = r as Record<string, unknown>;
      const label = toText(rr.label);
      const values = toTextArray(rr.values);
      return label !== null && values !== null ? { label, values } : null;
    })
    .filter((r) => r !== null);
  if (rows.length === 0) return null;
  return { columns, rows };
}

/** FIELD_SPECS 셰이프에 맞지 않는 값은 null (호출부가 폴백으로 채움) */
export function validateFieldValue(name: string, value: unknown): unknown {
  const spec = FIELD_SPECS[name];
  if (!spec) return null;
  switch (spec.type) {
    case 'text':
      return toText(value);
    case 'text[]':
      return toTextArray(value);
    case 'number': {
      const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case 'object[]': {
      if (!Array.isArray(value)) return null;
      const items = value.map((item) => toSpecItem(item, spec)).filter((item) => item !== null);
      if (spec.min && items.length < spec.min) return null;
      return items.length > 0 ? items : null;
    }
    case 'object':
      return name === 'comparisonTable' ? validateComparisonTable(value) : toSpecItem(value, spec);
    case 'objectMap': {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim().length > 0) out[k] = String(v);
      }
      return Object.keys(out).length > 0 ? out : null;
    }
  }
}

/** FIELD_SPECS를 기반으로 요청 필드의 JSON 스키마 설명 라인 생성 */
function describeFieldSpec(name: string): string | null {
  const spec = FIELD_SPECS[name];
  if (!spec) return null;
  const count = spec.min && spec.max ? ` (${spec.min}~${spec.max}개)` : '';
  switch (spec.type) {
    case 'text':
      return `  "${name}": "문단 단위 한국어 텍스트"`;
    case 'text[]':
      return `  "${name}": ["항목 문자열", "..."]`;
    case 'number':
      return `  "${name}": 0`;
    case 'objectMap':
      return `  "${name}": {"스펙 항목명": "값"}${count}`;
    case 'object[]': {
      const item = (spec.fields || [])
        .map((f) =>
          f === 'price'
            ? '"price": 0'
            : f === 'pros' || f === 'cons'
              ? `"${f}": ["문자열"]`
              : `"${f}": "${f === 'affiliateUrl' ? '' : '값'}"`,
        )
        .join(', ');
      return `  "${name}": [{ ${item} }]${count}`;
    }
    case 'object':
      if (name === 'comparisonTable') {
        return `  "${name}": { "columns": ["제품A", "제품B"], "rows": [{ "label": "비교 항목", "values": ["제품A 값", "제품B 값"] }] }`;
      }
      return `  "${name}": { ${(spec.fields || [])
        .map((f) => (f === 'affiliateUrl' ? `"${f}": ""` : `"${f}": "값"`))
        .join(', ')} }`;
  }
}
export interface ContentGeneratorConfig {
  provider?: string;
  apiKey?: string;
  model?: string;
}

/**
 * Drives LLM-based, first-person ("내가 직접 써본 경험") Korean blog copy generation.
 *
 * The generator receives benchmark / top-ranking Naver blog posts (provided by the
 * caller) and instructs the LLM to use them ONLY as structural/angle inspiration —
 * never to copy — so the output avoids plagiarism and SEO penalties while matching
 * the tone of high-ranking posts.
 *
 * When no API key is configured the generator is a no-op (returns null), letting
 * the static template copy stand. This keeps the pipeline resilient offline.
 */
export class ContentGenerator {
  private readonly provider: string;
  private readonly apiKey?: string;
  private readonly model: string;

  constructor(config: ContentGeneratorConfig = {}) {
    this.provider = config.provider || 'gemini';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-1.5-pro';
  }

  /**
   * Build the (system, user) prompt pair for first-person experience copy.
   * This is the core prompt builder referenced by the fix plan §4 (Q3).
   */
  buildPrompt(
    product: Pick<AffiliateProduct, 'name' | 'categoryName' | 'brand' | 'price' | 'description'>,
    keyword: string,
    topPosts: TopPost[],
  ): { system: string; user: string } {
    const system = [
      '당신은 대한민국 블로그 마케팅 카피라이팅 전문가입니다.',
      '독자에게 신뢰를 주는 "내가 직접 써본 경험" 후기체로 작성하세요.',
      '반드시 1인칭 주체적 경험 화법을 사용하세요. 예: "제가 직접 ~를 써보니", "솔직히 말씀드리면", "직접 사용해 본 후기입니다", "저는 ~해서 골랐어요".',
      '문장은 길고 구체적이며 정직해야 합니다. 장점뿐 아니라 아쉬웠던 점도 균형 있게 언급하세요.',
      '제공된 상위 블로그 벤치마크(제목/요약)는 "구성 방식과 접근 각도"의 영감으로만 참고하세요. 절대 그대로 베끼거나 표절하지 마세요(SEO 패널티 위험).',
      '모든 금칙/법적 고지는 작성하지 않아도 됩니다. 출력은 반드시 순수 JSON 형식으로만 주세요.',
    ].join('\n');

    const bench = this.benchmarkSection(topPosts);

    const user = [
      '상품 정보:',
      `- 상품명: ${product.name || ''}`,
      `- 카테고리: ${product.categoryName || ''}`,
      `- 브랜드: ${product.brand || ''}`,
      `- 가격: ${product.price != null ? `${product.price}원` : ''}`,
      `- 설명: ${product.description || ''}`,
      '',
      `키워드: ${keyword || product.name || ''}`,
      '',
      '상위 블로그 벤치마크 (참고용, 표절 금지):',
      bench,
      '',
      '위 정보를 바탕으로 다음 6개 필드를 한국어 1인칭 경험체로 작성해 주세요.',
      '문자열 필드는 문단 단위 텍스트, 배열 필드는 항목 문자열 배열입니다.',
      '출력 JSON 스키마:',
      '{',
      '  "experienceIntro": "독자에게 던지는 공감형 도입부. 왜 이 상품에 관심을 가졌는지 본인 경험 중심. 4~6문장.",',
      '  "realUsageStory": "실제로 사용하면서 겪은 구체적 사용기. 사용 환경, 소요 시간, 구체적 수치, 놀랐던 순간, 아쉬운 점을 포함해 8~12문장.",',
      '  "whyIChoseIt": "다른 대안 중 이 제품을 고른 이유와 비교 포인트. 비교 대안을 명시하고 5~8문장.",',
      '  "conclusion": "총평 및 이런 분께 추천하는지. 정직한 마무리로 4~6문장.",',
      '  "usageTips": "실전 활용 팁 배열. 5~7개 항목, 각 항목 1~2문장.",',
      '  "buyingChecklist": "구매 전 확인 항목 배열. 5~8개 항목, 각 항목 1문장."',
      '}',
    ].join('\n');

    return { system, user };
  }
  /** 상위 블로그 벤치마크 블록 — buildPrompt와 buildTemplateDataPrompt 공용 */
  private benchmarkSection(topPosts: TopPost[]): string {
    return topPosts.length
      ? topPosts
          .map(
            (p, i) =>
              `${i + 1}. 제목: ${p.title}\n   요약: ${p.snippet}\n   블로거: ${p.bloggername}`,
          )
          .join('\n')
      : '(벤치마크 데이터 없음 — 본인의 경험을 바탕으로 자유롭게 작성하세요)';
  }

  /**
   * Generate first-person experience copy via the configured LLM.
   * Returns null when no API key is configured or generation fails, so callers
   * can gracefully fall back to static template copy.
   */
  async generateExperience(
    product: Pick<AffiliateProduct, 'name' | 'categoryName' | 'brand' | 'price' | 'description'>,
    keyword: string,
    topPosts: TopPost[] = [],
  ): Promise<GeneratedExperience | null> {
    if (!this.apiKey) {
      logger.debug('No LLM API key configured; skipping experience generation');
      return null;
    }

    try {
      const { system, user } = this.buildPrompt(product, keyword, topPosts);

      const text = await this.complete(system, user);
      return this.parseExperience(text);
    } catch (error) {
      logger.warn(
        { error: String(error) },
        'LLM experience generation failed; falling back to template copy',
      );
      return null;
    }
  }

  /**
   * 템플릿 필드 데이터를 LLM으로 생성한다. 요청된 필드 중 FIELD_SPECS 셰이프에
   * 맞는 값만 반환하고, 누락 필드는 호출부가 폴백으로 채운다.
   * apiKey가 없거나 생성/파싱에 실패하면 null을 반환한다.
   */
  async generateTemplateData(req: TemplateDataRequest): Promise<Record<string, unknown> | null> {
    if (!this.apiKey) {
      logger.debug('No LLM API key configured; skipping template data generation');
      return null;
    }

    try {
      const { system, user } = this.buildTemplateDataPrompt(req);
      const text = await this.complete(system, user);
      return this.parseTemplateData(text, req.fields);
    } catch (error) {
      logger.warn({ error: String(error) }, 'LLM template data generation failed');
      return null;
    }
  }

  /**
   * 설정된 프로바이더/모델/키로 최소 completion 한 번을 수행해 연결 가능 여부를
   * 확인한다. 네트워크/인증 오류는 ok=false와 에러 메시지로 반환한다(throw 없음).
   */
  async validateConnection(): Promise<{ ok: boolean; model?: string; error?: string }> {
    if (!this.apiKey) {
      return { ok: false, error: 'API 키가 설정되지 않았습니다' };
    }
    try {
      await this.complete('JSON만 출력', '다음 JSON을 그대로 출력하세요: {"ok":true}');
      return { ok: true, model: this.model };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * buildPrompt와 동일한 시스템 규칙(1인칭 경험체, 벤치마크 표절 금지)에
   * 템플릿 데이터 생성용 규칙을 더해 (system, user) 프롬프트를 만든다.
   */
  buildTemplateDataPrompt(req: TemplateDataRequest): { system: string; user: string } {
    const system = [
      '당신은 대한민국 블로그 마케팅 카피라이팅 전문가입니다.',
      '독자에게 신뢰를 주는 "내가 직접 써본 경험" 후기체로 작성하세요.',
      '반드시 1인칭 주체적 경험 화법을 사용하세요. 예: "제가 직접 ~를 써보니", "솔직히 말씀드리면", "직접 사용해 본 후기입니다", "저는 ~해서 골랐어요".',
      '문장은 길고 구체적이며 정직해야 합니다. 장점뿐 아니라 아쉬웠던 점도 균형 있게 언급하세요.',
      '제공된 상위 블로그 벤치마크(제목/요약)는 "구성 방식과 접근 각도"의 영감으로만 참고하세요. 절대 그대로 베끼거나 표절하지 마세요(SEO 패널티 위험).',
      'AI/기계적 문장과 과장 표현을 쓰지 마세요. 구어체 경어체(~해요, ~더라고요)로 자연스럽게 작성하세요.',
      '가격은 참고 시세이며, 실제 가격은 쿠팡에서 확인해야 한다는 안내가 본문에 자연스럽게 포함되도록 작성하세요.',
      '절대 고지문/법적 문구(제휴 고지, 책임 한정 등)를 작성하지 마세요.',
      '요청된 필드만 아래 JSON 스키마 그대로 순수 JSON으로만 출력하세요.',
    ].join('\n');

    const bench = this.benchmarkSection(req.topPosts);
    const fieldLines = req.fields
      .map((name) => describeFieldSpec(name))
      .filter((line) => line !== null);

    const user = [
      `키워드: ${req.keyword}`,
      '',
      '상위 블로그 벤치마크 (참고용, 표절 금지):',
      bench,
      '',
      '위 정보를 바탕으로 아래 필드를 한국어 1인칭 경험체로 작성해 주세요.',
      '문자열 필드는 문단 단위 텍스트, 배열 필드는 항목 배열입니다.',
      'affiliateUrl 필드는 항상 빈 문자열("")로 출력하세요. 링크는 시스템이 채웁니다.',
      '출력 JSON 스키마:',
      '{',
      ...fieldLines,
      '}',
    ].join('\n');

    return { system, user };
  }

  /** (system, user) 프롬프트를 설정된 프로바이더로 실행해 원문 텍스트를 반환한다. */
  private async complete(system: string, user: string): Promise<string> {
    if (this.provider === 'openai') {
      const client = new OpenAI({ apiKey: this.apiKey });
      const completion = await client.chat.completions.create({
        model: this.model || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      });
      return completion.choices[0]?.message?.content || '';
    }

    const genAI = new GoogleGenerativeAI(this.apiKey!);
    const model = genAI.getGenerativeModel({ model: this.model, systemInstruction: system });
    const result = await model.generateContent(user);
    return result.response.text();
  }

  private parseTemplateData(text: string, fields: string[]): Record<string, unknown> | null {
    let parsed: Record<string, unknown>;
    try {
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
      const value: unknown = JSON.parse(cleaned);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      parsed = value as Record<string, unknown>;
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to parse LLM template data JSON');
      return null;
    }

    const out: Record<string, unknown> = {};
    for (const name of fields) {
      if (!(name in parsed)) continue;
      const validated = validateFieldValue(name, parsed[name]);
      if (validated !== null) out[name] = validated;
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  private parseExperience(text: string): GeneratedExperience | null {
    try {
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```$/, '')
        .trim();
      const parsed = JSON.parse(cleaned) as Partial<GeneratedExperience>;
      if (
        !parsed.experienceIntro &&
        !parsed.realUsageStory &&
        !parsed.whyIChoseIt &&
        !parsed.conclusion
      ) {
        return null;
      }
      return {
        experienceIntro: String(parsed.experienceIntro || ''),
        realUsageStory: String(parsed.realUsageStory || ''),
        whyIChoseIt: String(parsed.whyIChoseIt || ''),
        conclusion: String(parsed.conclusion || ''),
        usageTips: Array.isArray(parsed.usageTips) ? parsed.usageTips.map(String) : [],
        buyingChecklist: Array.isArray(parsed.buyingChecklist)
          ? parsed.buyingChecklist.map(String)
          : [],
      };
    } catch (error) {
      logger.warn({ error: String(error) }, 'Failed to parse LLM experience JSON');
      return null;
    }
  }
}

/**
 * Resolve an LLM config from the application config. Uses a dedicated `llm`
 * section when present, otherwise reuses the Gemini image-provider key
 * (same Gemini API key, used here for text generation).
 */
export function createContentGeneratorFromConfig(): ContentGenerator {
  let cfg: ContentGeneratorConfig = {};
  try {
    const cm = getConfigManager();
    const llm = (cm.get('llm') as Record<string, unknown>) || {};
    const gemini = (cm.get('imageProviders.gemini') as Record<string, unknown>) || {};
    const source = Object.keys(llm).length ? llm : gemini;
    cfg = {
      provider:
        (source.provider as string) ||
        (llm.provider as string) ||
        (gemini.provider as string) ||
        'gemini',
      apiKey: (source.apiKey as string) || '',
      model: (source.model as string) || 'gemini-1.5-pro',
    };
  } catch {
    cfg = {};
  }
  return new ContentGenerator(cfg);
}
