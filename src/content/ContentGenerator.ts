import { getLogger } from '@core/logger';
import { getConfigManager } from '@core/config';
import type { AffiliateProduct } from '@core/interfaces';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';

const logger = getLogger('content-generator');

/**
 * 지원 LLM 프로바이더 메타데이터. gemini를 제외한 모든 프로바이더는
 * OpenAI 호환 API를 사용하며, 여기의 baseUrl이 기본 엔드포인트가 된다.
 * 클라이언트용 쌍둥이: src/web/shared/llmProviders.ts (수동 동기화 유지).
 */
export const LLM_PROVIDERS: Record<string, { baseUrl: string; defaultModel: string }> = {
  gemini: { baseUrl: '', defaultModel: 'gemini-1.5-pro' },
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-3-5-sonnet-latest' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', defaultModel: 'mistral-large-latest' },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-2-latest' },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.1' },
};

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
  /**
   * 템플릿 이름 — fun/emoji/meme 계열 템플릿이면 이모지·밈 톤 지시가 추가된다.
   */
  templateName?: string;
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

/**
 * 발행 시점 AI 다듬기 결과 검증(이슈 #12) — 순수 함수, 유닛 테스트 대상.
 * LLM이 HTML 구조를 훼손했는지 확인한다:
 *  - 위젯 마커(data-coupang-widget) 개수 보존
 *  - <img> 개수 보존
 *  - 원본의 모든 href가 결과에 보존
 *  - 본문 텍스트 길이가 크게 변하지 않음(50%~150%)
 * 검증 탈락 시 호출부가 원본 HTML로 발행한다(AI 실패가 발행을 막지 않게 한다).
 */
export function validatePolishedHtml(original: string, polished: string): boolean {
  if (!polished || polished.length < 100) return false;
  const markerCount = (s: string): number => (s.match(/data-coupang-widget=/g) ?? []).length;
  if (markerCount(original) !== markerCount(polished)) return false;
  const imgCount = (s: string): number => (s.match(/<img\b/gi) ?? []).length;
  if (imgCount(original) !== imgCount(polished)) return false;
  const hrefs = (s: string): Set<string> =>
    new Set([...s.matchAll(/href="([^"]+)"/g)].map((m) => m[1]));
  for (const href of hrefs(original)) {
    if (!hrefs(polished).has(href)) return false;
  }
  const textLen = (s: string): number => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
  const ratio = textLen(polished) / Math.max(1, textLen(original));
  return ratio >= 0.5 && ratio <= 1.5;
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
  baseUrl?: string;
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
  private readonly baseUrl?: string;

  constructor(config: ContentGeneratorConfig = {}) {
    this.provider = config.provider || 'gemini';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-1.5-pro';
    this.baseUrl = config.baseUrl || undefined;
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
    const isFunTone = /fun|emoji|meme/i.test(req.templateName ?? '');
    const system = [
      '당신은 대한민국 블로그 마케팅 카피라이팅 전문가입니다.',
      '독자에게 신뢰를 주는 "내가 직접 써본 경험" 후기체로 작성하세요.',
      '반드시 1인칭 주체적 경험 화법을 사용하세요. 예: "제가 직접 ~를 써보니", "솔직히 말씀드리면", "직접 사용해 본 후기입니다", "저는 ~해서 골랐어요".',
      '문장은 길고 구체적이며 정직해야 합니다. 장점뿐 아니라 아쉬웠던 점도 균형 있게 언급하세요.',
      '제공된 상위 블로그 벤치마크(제목/요약)는 "구성 방식과 접근 각도"의 영감으로만 참고하세요. 절대 그대로 베끼거나 표절하지 마세요(SEO 패널티 위험).',
      'AI/기계적 문장과 과장 표현을 쓰지 마세요. 구어체 경어체(~해요, ~더라고요)로 자연스럽게 작성하세요.',
      '풍부한 문장으로 작성하세요: 구체적 사용 상황·수치·감각 묘사(촉감/소리/냄새 등)를 넣고, 문단은 2~4문장 단위로 \n\n으로 나누어 리듬감을 주세요.',
      '텍스트 필드는 아래 최소 분량을 반드시 채우세요(미달 시 재작성한 것으로 간주합니다): experienceIntro 300자 이상, realUsageStory 700자 이상, whyIChoseIt 400자 이상, conclusion 400자 이상. 배열 항목은 각 1~2문장으로 구체적으로.',
      ...(isFunTone
        ? [
            '이 템플릿은 이모지·밈 활용형입니다: 문단 곳곳에 자연스러운 이모지(1~2개)를 사용하고, "실화?", "국룰" 같은 가벼운 유행어/밈을 절제해 녹이세요. 남발하면 어색해지므로 전체의 10% 이하로 유지하세요.',
          ]
        : []),
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
      req.templateName ? `템플릿: ${req.templateName}` : '',
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

  /**
   * (system, user) 프롬프트를 설정된 프로바이더로 실행해 원문 텍스트를 반환한다.
   * jsonMode가 true(기본)면 OpenAI 호환 엔드포인트에 JSON 응답 포맷을 강제한다.
   * HTML 등 자유 텍스트 출력은 false로 호출한다.
   */
  private async complete(system: string, user: string, jsonMode = true): Promise<string> {
    if (this.provider === 'gemini') {
      const genAI = new GoogleGenerativeAI(this.apiKey!);
      const model = genAI.getGenerativeModel({ model: this.model, systemInstruction: system });
      const result = await model.generateContent(user);
      return result.response.text();
    }

    // gemini 외 전부 OpenAI 호환 엔드포인트로 처리한다(openai/anthropic/openrouter/
    // deepseek/groq/mistral/xai/ollama 및 향후 추가되는 호환 프로바이더 포함).
    const client = new OpenAI({
      apiKey: this.apiKey,
      baseURL:
        normalizeLlmBaseUrl(this.baseUrl || '') ||
        LLM_PROVIDERS[this.provider]?.baseUrl ||
        undefined,
    });
    const completion = await client.chat.completions.create({
      model: this.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      ...(jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    });
    return completion.choices[0]?.message?.content || '';
  }

  /**
   * 현재 블로그 글 HTML과 사용자 요청을 받아 LLM으로 수정된 전체 HTML을 반환한다.
   * 편집 화면 AI 채팅(POST /api/posts/:id/ai-edit)용 — 파일 저장은 호출부가 담당한다.
   * API 키가 없거나 LLM 호출에 실패하면 throw한다(라우트가 500 반환).
   */
  async editPostHtml(currentHtml: string, userPrompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error('LLM API 키가 설정되지 않았습니다');
    }

    const system = [
      '당신은 대한민국 블로그 글 편집 어시스턴트입니다.',
      '제공된 HTML 글 전체를 사용자 요청에 맞게 수정합니다.',
      'HTML 구조(템플릿 스타일/섹션 구분/이미지 태그/쿠팡 위젯 마커 data-coupang-widget)는 반드시 보존하고, 내용(문장)만 수정하세요.',
      '응답은 설명이나 코드펜스 없이 수정된 전체 HTML만 출력하세요.',
    ].join('\n');

    const user = [
      '다음은 현재 블로그 글이다.',
      '',
      currentHtml,
      '',
      `사용자 요청: ${userPrompt}`,
      '글 전체를 요청에 맞게 수정해라.',
      'HTML 구조(템플릿 스타일/섹션/이미지 태그/쿠팡 위젯 마커 data-coupang-widget)는 보존하고 내용만 수정하라.',
      '응답은 수정된 전체 HTML만.',
    ].join('\n');

    const text = await this.complete(system, user, false);
    // 모델이 관례적으로 코드펜스를 붙이는 경우를 대비해 벗겨낸다.
    return text
      .trim()
      .replace(/^```(?:html)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
  }

  /**
   * 발행 시점 AI 최종 다듬기(이슈 #12). 문장만 다듬고 HTML 구조/링크/이미지는
   * 절대 변경하지 않도록 지시하며, 결과는 validatePolishedHtml로 검증한다.
   * API 키가 없거나 LLM 실패/검증 탈락 시 null을 반환해 호출부가 원본으로
   * 발행하도록 한다(AI 실패가 발행을 막지 않는다).
   */
  async polishForPublish(currentHtml: string): Promise<string | null> {
    if (!this.apiKey) return null;
    const system = [
      '당신은 대한민국 블로그 글 최종 교정 어시스턴트입니다.',
      '제공된 HTML 글을 발행 직전 최종본으로 다듬습니다.',
      '다듬기 범위: 어색한 문장 수정, 문단 리듬 정리, 도입부 훅 강화, 이모지 과다/부족 균형 맞추기, 중복 표현 제거.',
      '절대 규칙: HTML 태그 추가/삭제/변경 금지. href/src/class/style/data-* 속성 변경 금지. 링크·이미지·위젯 마커(data-coupang-widget)는 그대로 유지. 섹션 순서 변경 금지.',
      '텍스트 노드의 문장만 수정하세요. 응답은 설명이나 코드펜스 없이 수정된 전체 HTML만 출력하세요.',
    ].join('\n');
    const user = [
      '다음은 발행 직전 블로그 글 HTML이다.',
      '',
      currentHtml,
      '',
      '위 글을 발행용 최종본으로 다듬어라. HTML 구조·속성·링크·이미지·마커는 1글자도 바꾸지 마라.',
      '응답은 수정된 전체 HTML만.',
    ].join('\n');
    try {
      const text = await this.complete(system, user, false);
      const candidate = text
        .trim()
        .replace(/^```(?:html)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
      if (!candidate) return null;
      if (!validatePolishedHtml(currentHtml, candidate)) {
        logger.warn('Polished HTML failed validation; falling back to original');
        return null;
      }
      return candidate;
    } catch (error) {
      logger.warn({ error: String(error) }, 'Publish-time AI polish failed; using original');
      return null;
    }
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
export function resolveLlmConfigFromConfigManager(): ContentGeneratorConfig {
  const cm = getConfigManager();
  const llm = (cm.get('llm') as Record<string, unknown>) || {};
  const gemini = (cm.get('imageProviders.gemini') as Record<string, unknown>) || {};
  const source = Object.keys(llm).length ? llm : gemini;
  const provider =
    (source.provider as string) ||
    (llm.provider as string) ||
    (gemini.provider as string) ||
    'gemini';
  return {
    provider,
    // 복사-붙여넣기 키의 앞뒤 공백/개행이 Authorization 헤더를 깨뜨리므로 원천에서 trim한다.
    apiKey: ((source.apiKey as string) || '').trim(),
    // 설정된 모델이 없으면 프로바이더 기본 모델로 폴백한다.
    model: (source.model as string) || LLM_PROVIDERS[provider]?.defaultModel || 'gemini-1.5-pro',
    baseUrl: (llm.baseUrl as string) || '',
  };
}
/**
 * 사용자가 Base URL에 OpenAI SDK가 덧붙일 엔드포인트 경로까지 입력하는 실수를 방어한다.
 * trim → 뒤 슬래시 제거 → (남는 결과가 빈 값이 아니면) 대소문자 무시하고
 * '/chat/completions' 접미사 제거. 예:
 *   'https://api.deepseek.com/chat/completions' → 'https://api.deepseek.com'
 *   'https://api.deepseek.com/v1/' → 'https://api.deepseek.com/v1'
 *   'https://api.deepseek.com' → 그대로
 */
export function normalizeLlmBaseUrl(url: string): string {
  const trimmed = (url || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const stripped = trimmed.replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
  return stripped || trimmed;
}

/**
 * 저장된 설정 위에 연결 테스트 요청 본문(입력 중인 폼 값)을 덧씌운다.
 * apiKey는 '***' 마스킹 센티널이거나 없으면 저장된 키를, 그 외에는 본문 키를 사용하며
 * 모든 문자열 필드는 trim한다. 순수 함수라 단위 테스트 가능하다.
 */
export function resolveLlmValidateConfig(
  saved: ContentGeneratorConfig,
  override: Partial<ContentGeneratorConfig> | undefined,
): ContentGeneratorConfig {
  const ov = override || {};
  const trim = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

  const provider = trim(ov.provider) || trim(saved.provider);
  const apiKey =
    (trim(ov.apiKey) && trim(ov.apiKey) !== '***' ? trim(ov.apiKey) : '') || trim(saved.apiKey);
  const model = trim(ov.model) || trim(saved.model) || LLM_PROVIDERS[provider]?.defaultModel || '';
  const baseUrl = normalizeLlmBaseUrl(trim(ov.baseUrl) || trim(saved.baseUrl));

  return { provider, apiKey, model, baseUrl };
}

export function createContentGeneratorFromConfig(): ContentGenerator {
  let cfg: ContentGeneratorConfig = {};
  try {
    cfg = resolveLlmConfigFromConfigManager();
  } catch {
    cfg = {};
  }
  return new ContentGenerator(cfg);
}
