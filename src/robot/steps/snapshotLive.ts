import { parseNaverRss } from '../../platforms/naver/NaverRss';
import { isDuplicate } from '../policies';
import type { StepContext, StepHandler, StepResult } from './types';

/**
 * SNAPSHOT_LIVE — 라이브 스냅샷(스킬 §1 S1). 중복 판정의 유일한 진실은 라이브 블로그다.
 * RSS와 PostList 원문을 증거로 남기고, 최근 365일 제목·logNo·pubDate 목록을 만든다.
 * 발행 실행에서는 기획 이후 발행분까지 반영해 중복을 **다시** 확인한다.
 */
export const snapshotLive: StepHandler = async (ctx: StepContext): Promise<StepResult> => {
  ctx.evidence.ensure('live');

  const rssXml = await ctx.http.getText(ctx.env.rssUrl);
  ctx.evidence.writeText('live/rss-before.xml', rssXml);

  const listUrl = `https://blog.naver.com/PostList.naver?blogId=${encodeURIComponent(
    ctx.env.blogId,
  )}&widgetTypeCall=true&noTrackingCode=true&directAccess=false`;
  const listHtml = await ctx.http.getText(listUrl);
  ctx.evidence.writeText('live/list-before.html', listHtml);

  const items = parseNaverRss(rssXml);
  const nowMs = ctx.clock.now().getTime();
  const recent365 = items.filter(
    (item) => item.pubDate && nowMs - item.pubDate.getTime() <= 365 * 24 * 60 * 60 * 1000,
  );
  ctx.evidence.writeJson(
    'live/live-items.json',
    items.map((item) => ({
      title: item.title,
      logNo: item.logNo,
      link: item.link,
      pubDate: item.pubDate ? item.pubDate.toISOString() : null,
    })),
  );
  ctx.evidence.writeText(
    'live/logNos-before.txt',
    `${items
      .map((i) => i.logNo)
      .filter((v): v is string => !!v)
      .sort()
      .join('\n')}\n`,
  );

  if (ctx.run.kind === 'publish' && ctx.run.keyword) {
    const duplicate = isDuplicate(
      ctx.run.keyword,
      recent365.map((i) => ({ title: i.title, pubDate: i.pubDate })),
      180,
      ctx.clock.now(),
    );
    if (duplicate) {
      ctx.evidence.writeJson('live/duplicate.json', { keyword: ctx.run.keyword });
      return { type: 'finish', outcome: 'skipped-duplicate' };
    }
  }

  return ctx.run.kind === 'plan'
    ? { type: 'next', step: 'RESEARCH' }
    : { type: 'next', step: 'GENERATE' };
};
