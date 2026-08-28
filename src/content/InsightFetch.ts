import { getLogger } from '@core/logger';
import { getConfigManager } from '@core/config';
import { NaverApiHubKeywordProvider } from '../intelligence/NaverApiHubProvider';
import type { TopPost } from './ContentGenerator';

const logger = getLogger('insight-fetch');

/** SCH_TRND trend → 사용자 노출 문구 */
const TREND_LABEL: Record<string, string> = {
  rising: '상승세',
  falling: '하락세',
  stable: '안정세',
};

function stripHtml(input: string): string {
  return input.replace(/<[^>]*>/g, '');
}

/**
 * 키워드로 네이버 상위 블로그 포스트를 조회해 TopPost[]로 매핑한다.
 * 자격 증명이 없거나 조회에 실패하면 빈 배열을 반환한다(호출부 계속 진행).
 */
export async function fetchTopPosts(keyword: string, limit: number = 10): Promise<TopPost[]> {
  if (!keyword) return [];
  try {
    const cm = getConfigManager();
    const hubConfig = cm.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) return [];
    const provider = new NaverApiHubKeywordProvider(hubConfig);
    const res = (await provider.searchBlog(keyword, limit)) as {
      items?: Array<Record<string, unknown>>;
    };
    const items = res?.items ?? [];
    return items.slice(0, limit).map((i) => ({
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

/**
 * 키워드 인사이트(SCH_TRND 트렌드 + SHPP_INST 쇼핑 클릭 + 블로그 검색 연관 키워드)를
 * 조회한다. 자격 증명이 없거나 조회에 실패하면 null을 반환한다.
 */
export async function fetchKeywordInsight(
  keyword: string,
): Promise<Record<string, unknown> | null> {
  if (!keyword) return null;
  try {
    const cm = getConfigManager();
    const hubConfig = cm.getKeywordProviderConfig('naver-api-hub');
    if (!hubConfig?.apiKey || !hubConfig?.apiSecret) return null;
    const provider = new NaverApiHubKeywordProvider(hubConfig);
    const [data] = await provider.research([keyword]);
    if (!data) return null;

    const meta = (data.metadata ?? {}) as Record<string, unknown>;
    return {
      keyword: data.keyword,
      trend: data.trend,
      trendLabel: TREND_LABEL[data.trend],
      trendSeries: meta.trendSeries ?? [],
      shoppingCategory: meta.shoppingCategory ?? null,
      shoppingRatio: meta.shoppingRatio ?? null,
      relatedKeywords: data.related ?? [],
    };
  } catch (error) {
    logger.warn(
      { keyword, error: String(error) },
      'Keyword insight fetch failed; continuing without keywordInsight',
    );
    return null;
  }
}
