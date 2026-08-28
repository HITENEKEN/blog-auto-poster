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

    const bench = topPosts.length
      ? topPosts
          .map(
            (p, i) =>
              `${i + 1}. 제목: ${p.title}\n   요약: ${p.snippet}\n   블로거: ${p.bloggername}`,
          )
          .join('\n')
      : '(벤치마크 데이터 없음 — 본인의 경험을 바탕으로 자유롭게 작성하세요)';

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

      if (this.provider === 'openai') {
        return await this.generateWithOpenAI(system, user);
      }
      return await this.generateWithGemini(system, user);
    } catch (error) {
      logger.warn(
        { error: String(error) },
        'LLM experience generation failed; falling back to template copy',
      );
      return null;
    }
  }

  private async generateWithGemini(
    system: string,
    user: string,
  ): Promise<GeneratedExperience | null> {
    const genAI = new GoogleGenerativeAI(this.apiKey!);
    const model = genAI.getGenerativeModel({ model: this.model, systemInstruction: system });
    const result = await model.generateContent(user);
    const text = result.response.text();
    return this.parseExperience(text);
  }

  private async generateWithOpenAI(
    system: string,
    user: string,
  ): Promise<GeneratedExperience | null> {
    const client = new OpenAI({ apiKey: this.apiKey });
    const completion = await client.chat.completions.create({
      model: this.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_object' },
    });
    const text = completion.choices[0]?.message?.content || '';
    return this.parseExperience(text);
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
