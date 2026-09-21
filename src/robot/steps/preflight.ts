import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '@core/logger';
import { HttpError } from '../errors';
import { RobotAbort } from '../errors';
import { kstDateString } from '../kst';
import { isWeeklyCapReached, SESSION_MIN_DAYS, WEEKLY_HARD_CAP } from '../policies';
import { collectRssLogNos, parseNaverRss } from '../../platforms/naver/NaverRss';
import type { StepContext, StepHandler, StepResult } from './types';

const logger = getLogger('robot');

/** 이미지 일일 상한 원장(스킬 §2 S0 (3)). 파일은 "마지막 생성일"의 기록이다. */
export const IMAGE_USAGE_FILE = 'images/.image-usage.json';

interface ImageUsageLedger {
  date?: string;
  count?: number;
}

/**
 * 이미지 예산: 원장의 date가 오늘이 아니면 오늘 사용량은 0으로 시작한다
 * (`src/content/ImageGenerator.ts`의 loadLedger와 같은 규칙).
 */
export function readImageUsage(
  outputDir: string,
  now: Date,
): { date: string; count: number } | null {
  const file = path.join(outputDir, IMAGE_USAGE_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as ImageUsageLedger;
    const today = kstDateString(now);
    if (raw.date !== today) return { date: raw.date ?? '', count: 0 };
    return { date: raw.date, count: Number(raw.count) || 0 };
  } catch (error) {
    logger.warn({ error: String(error) }, '이미지 사용 원장을 읽지 못했습니다');
    return null;
  }
}

/**
 * PREFLIGHT — 기획·발행 공통(설계 §5-1).
 * health(naver true·scheduler stopped·세션 잔여일) → 로그인 → paused 확인.
 * 발행 실행은 주간 상한(§5-4)과 이미지 예산까지 확인한다.
 */
export const preflight: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  ctx.evidence.ensure('live', 'robot');

  if (ctx.store.isPaused()) {
    return { type: 'wait', recheckAfterMs: 60_000, reason: 'paused' };
  }

  try {
    await ctx.api.ensureToken();
  } catch (error) {
    if (error instanceof HttpError) throw new RobotAbort('login', error.message);
    throw error;
  }

  const health = await ctx.api.health();
  const platforms = health.services?.platforms || {};
  if (platforms.naver !== true) {
    throw new RobotAbort('health', 'platforms.naver가 true가 아닙니다');
  }
  if (health.services?.scheduler && health.services.scheduler !== 'stopped') {
    throw new RobotAbort('health', `scheduler가 ${health.services.scheduler} 상태입니다`);
  }

  const session = health.services?.naverSession;
  if (session && typeof session.daysLeft === 'number' && session.daysLeft < SESSION_MIN_DAYS) {
    throw new RobotAbort(
      'session',
      `네이버 세션 잔여 ${session.daysLeft}일 (< ${SESSION_MIN_DAYS}일) — npm run naver:login 필요`,
    );
  }

  // 라이브 스냅샷(주간 상한 판정 + 중복 판정의 진실 원천)
  const rssXml = await ctx.http.getText(ctx.env.rssUrl);
  ctx.evidence.writeText('live/rss-preflight.xml', rssXml);
  const rssItems = parseNaverRss(rssXml);

  const report: Record<string, unknown> = {
    checkedAt: ctx.clock.now().toISOString(),
    naverSession: session ?? null,
    rssItems: rssItems.length,
    rssLogNos: collectRssLogNos(rssXml).length,
  };

  if (ctx.run.kind === 'publish') {
    const sevenDaysAgo = ctx.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000;
    const rssLast7 = rssItems.filter(
      (item) => item.pubDate && item.pubDate.getTime() >= sevenDaysAgo,
    ).length;
    const robotThisWeek = ctx.store.countPublishedThisWeek(ctx.clock.now());
    report.weekly = { rssLast7, robotThisWeek, cap: WEEKLY_HARD_CAP };
    if (isWeeklyCapReached(rssLast7, robotThisWeek)) {
      ctx.evidence.writeJson('robot/preflight.json', report);
      return { type: 'finish', outcome: 'skipped-weekly-cap' };
    }

    const ledger = readImageUsage(ctx.env.outputDir, ctx.clock.now());
    const dailyLimit = ctx.env.imageDailyLimit;
    report.images = { ledger, dailyLimit };
    if (dailyLimit > 0 && ledger && ledger.count >= dailyLimit) {
      ctx.evidence.writeJson('robot/preflight.json', report);
      throw new RobotAbort('image-budget', `이미지 일일 상한(${dailyLimit}장) 도달`);
    }
  }

  ctx.evidence.writeJson('robot/preflight.json', report);
  return ctx.run.kind === 'plan'
    ? { type: 'next', step: 'SNAPSHOT_LIVE' }
    : { type: 'next', step: 'RESOLVE_ADS' };
};
