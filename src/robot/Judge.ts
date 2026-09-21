import { getLogger } from '@core/logger';
import type { ContentGenerator } from '@content/ContentGenerator';
import { RobotAbort } from './errors';
import { PRODUCT_CRITERIA_COUNT } from './policies';

const logger = getLogger('robot');

/**
 * LLM 판단(설계 §5-3). `ContentGenerator.completeJson` 하나만 쓰고, 결과는
 * 손으로 쓴 검증기로 좁힌다(새 의존성 없음).
 *
 * 호출마다 타임아웃(기본 120초), 실행당 호출 상한(기본 10회). 상한을 넘으면
 * `aborted-llm-budget`으로 실행을 끝낸다.
 */

export interface LlmJsonCompleter {
  completeJson(system: string, user: string): Promise<unknown>;
}

export interface JudgeOptions {
  maxCallsPerRun?: number;
  timeoutSeconds?: number;
}

export interface JudgedTopic {
  keyword: string;
  writable: boolean;
  seasonal: boolean;
  angle?: string;
  reason?: string;
  productCriteria: string[];
}

export interface JudgedDraft {
  title: string;
  html: string;
  tags: string[];
}

export interface JudgedImage {
  file: string;
  fits: boolean;
  reason?: string;
}

export const DEFAULT_LLM_MAX_CALLS = 10;
export const DEFAULT_LLM_TIMEOUT_SECONDS = 120;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const { promise: timeout, resolve } = Promise.withResolvers<T>();
  const timer = setTimeout(() => {
    resolve(undefined as T);
    logger.warn({ label, ms }, 'LLM 호출 타임아웃');
  }, ms);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => asString(v))
    .filter((v) => v.length > 0)
    .slice(0, max);
}

export class Judge {
  private calls = 0;
  private readonly maxCalls: number;
  private readonly timeoutMs: number;

  constructor(
    private readonly completer: LlmJsonCompleter,
    options: JudgeOptions = {},
  ) {
    this.maxCalls = options.maxCallsPerRun ?? DEFAULT_LLM_MAX_CALLS;
    this.timeoutMs = (options.timeoutSeconds ?? DEFAULT_LLM_TIMEOUT_SECONDS) * 1000;
  }

  get callCount(): number {
    return this.calls;
  }

  private async ask(label: string, system: string, user: string): Promise<unknown> {
    if (this.calls >= this.maxCalls) {
      throw new RobotAbort('llm-budget', `LLM 호출 상한(${this.maxCalls}회)을 넘었습니다`);
    }
    this.calls += 1;
    logger.debug({ label, call: this.calls }, 'LLM 호출');
    return withTimeout(this.completer.completeJson(system, user), this.timeoutMs, label);
  }

  /**
   * 후보 검증: 경험 없이 기준형으로 정직하게 쓸 수 있는지(`writable`),
   * 계절 키워드인지(`seasonal`), 각도·근거·소재 기준.
   */
  async judgeTopics(
    candidates: Array<{ keyword: string; series: Array<{ period: string; ratio: number }> }>,
    existingTitles: string[],
  ): Promise<JudgedTopic[]> {
    if (!candidates.length) return [];

    const system = [
      '당신은 대한민국 네이버 블로그 발행 심사자입니다.',
      '규칙: 1인칭 체험담(제가/저는/써봤/입어봤/내돈내산)은 금지이므로, 경험 없이도 기준형(구매 가이드)으로',
      '정직하게 쓸 수 있는 주제만 통과시킵니다. 검증 불가한 가격·수치 단정도 금지입니다.',
      '계절 키워드(예: 제습기·예초기)는 시즌 종료 시 수요가 붕괴하므로 seasonal=true로 표시합니다.',
      'JSON만 출력하세요.',
    ].join('\n');

    const rows = candidates.map((c) => ({
      keyword: c.keyword,
      series: c.series.map((p) => [p.period, p.ratio]),
    }));

    const user = [
      '아래 후보별 주간 상대지수(0–100, 절대 검색량 아님)와 기존 발행 제목 목록을 보고 판단하세요.',
      `기존 제목: ${JSON.stringify(existingTitles.slice(0, 100))}`,
      `후보: ${JSON.stringify(rows)}`,
      '출력 JSON 스키마:',
      '{"candidates":[{"keyword":"...","writable":true,"seasonal":false,"angle":"...","reason":"...","productCriteria":["기준1","기준2","기준3"]}]}',
      `productCriteria는 소재를 고를 기준 ${PRODUCT_CRITERIA_COUNT}개입니다.`,
    ].join('\n');

    const raw = (await this.ask('judgeTopics', system, user)) as {
      candidates?: unknown[];
    };
    if (!raw || !Array.isArray(raw.candidates)) return [];

    const byKeyword = new Map(candidates.map((c) => [c.keyword, c]));
    const out: JudgedTopic[] = [];
    for (const entry of raw.candidates) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const keyword = asString(record.keyword);
      if (!keyword || !byKeyword.has(keyword)) continue;
      const criteria = asStringArray(record.productCriteria, PRODUCT_CRITERIA_COUNT);
      out.push({
        keyword,
        writable: record.writable !== false,
        seasonal: record.seasonal === true,
        angle: asString(record.angle) || undefined,
        reason: asString(record.reason) || undefined,
        productCriteria: criteria,
      });
    }
    return out;
  }

  /**
   * 초안 편집: 제목·본문·태그. 위반 목록을 되먹여 재시도하므로 호출부가 같은 입력으로
   * 여러 번 부를 수 있다(§5-1 EDIT 단계).
   */
  async editDraft(input: {
    html: string;
    keyword: string;
    decisionSummary: string;
    violations: string[];
  }): Promise<JudgedDraft> {
    const system = [
      '당신은 대한민국 네이버 블로그 편집자입니다.',
      '제공된 HTML의 구조(h2 개수·이미지·링크·쿠팡 위젯 마커)를 유지한 채 문장만 고칩니다.',
      '금지: 1인칭 체험(제가/저는/써봤/입어봤/내돈내산/직접 써·사용·입어), 스텁 문구(향후 구현/구현 예정/coming soon),',
      '자리표시자(⟦IMGn⟧/TODO/FIXME), 근거 없는 가격 단정, iframe·script.',
      '가격·수치는 근거가 없으면 쓰지 않습니다. 상대 지수는 지수임을 명시합니다.',
      'JSON만 출력하세요.',
    ].join('\n');

    const user = [
      `키워드: ${input.keyword}`,
      `선정 근거: ${input.decisionSummary}`,
      input.violations.length ? `직전 시도의 위반 목록: ${input.violations.join('; ')}` : '',
      '아래 HTML을 위 규칙에 맞게 편집하세요.',
      input.html,
      '출력 JSON 스키마: {"title":"...","html":"...","tags":["..."]} (tags는 최대 5개)',
    ]
      .filter(Boolean)
      .join('\n');

    const raw = (await this.ask('editDraft', system, user)) as Record<string, unknown>;
    const title = asString(raw?.title);
    const html = asString(raw?.html);
    if (!title || !html) {
      throw new RobotAbort('llm', '편집 응답에 제목 또는 본문이 없습니다');
    }
    return { title, html, tags: asStringArray(raw?.tags, 5) };
  }

  /** 이미지 적합성 판정(비전 지원 시에만 쓰인다 — `images.review='vision'`). */
  async judgeImages(input: {
    sectionTitles: string[];
    images: Array<{ file: string; dataUrl?: string }>;
  }): Promise<JudgedImage[]> {
    if (!input.images.length) return [];
    const system = [
      '당신은 블로그 삽화 심사자입니다.',
      '특정 제품·브랜드를 식별시키는 이미지, 주제와 무관한 이미지는 fits=false입니다.',
      'JSON만 출력하세요.',
    ].join('\n');
    const user = [
      `섹션 제목: ${JSON.stringify(input.sectionTitles)}`,
      `이미지: ${JSON.stringify(input.images.map((i) => ({ file: i.file, dataUrl: i.dataUrl ? 'inline' : null })))}`,
      '출력 JSON 스키마: {"images":[{"file":"...","fits":true,"reason":"..."}]}',
    ].join('\n');

    const raw = (await this.ask('judgeImages', system, user)) as { images?: unknown[] };
    if (!raw || !Array.isArray(raw.images)) return [];
    const images: JudgedImage[] = [];
    for (const entry of raw.images) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const file = asString(record.file);
      if (!file) continue;
      images.push({
        file,
        fits: record.fits !== false,
        reason: asString(record.reason) || undefined,
      });
    }
    return images;
  }
}

/** 프로덕션 팩토리 — ContentGenerator를 `LlmJsonCompleter`로 좁혀 넣는다. */
export function createJudge(
  generator: Pick<ContentGenerator, 'completeJson'>,
  options: JudgeOptions = {},
): Judge {
  return new Judge({ completeJson: (s, u) => generator.completeJson(s, u) }, options);
}
