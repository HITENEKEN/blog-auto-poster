import { getLogger } from '@core/logger';
import {
  TopicRecommendation,
  TopicSelector,
  TopicSelectionConfig,
  KeywordData,
  CompetitorPost,
  AffiliateProduct,
} from '@core/interfaces';

const logger = getLogger('topic-selector');

export class TopicSelectorImpl implements TopicSelector {
  async select(candidates: TopicRecommendation[], config: TopicSelectionConfig): Promise<TopicRecommendation[]> {
    const {
      minScore = 0.3,
      maxResults = 10,
      weights = {
        searchVolume: 0.3,
        commissionRate: 0.25,
        contentGap: 0.25,
        trendVelocity: 0.2,
      },
      filters = {},
    } = config;

    logger.info({ candidateCount: candidates.length, config }, 'Selecting topics');

    // Score each candidate
    const scored = candidates.map(candidate => ({
      ...candidate,
      finalScore: this.calculateFinalScore(candidate, weights),
    }));

    // Filter by minimum score
    const filtered = scored.filter(c => c.finalScore >= minScore);

    // Apply additional filters
    const filtered2 = filtered.filter(c => {
      if (filters.minVolume && c.keywordData.volume < filters.minVolume) return false;
      if (filters.maxCompetition && c.keywordData.competition > filters.maxCompetition) return false;
      if (filters.trends && !filters.trends.includes(c.keywordData.trend)) return false;
      if (filters.minCommission && c.affiliateData && c.affiliateData.commissionRate < filters.minCommission) return false;
      return true;
    });

    // Sort by final score descending
    filtered2.sort((a, b) => b.finalScore - a.finalScore);

    // Return top results
    const results = filtered2.slice(0, maxResults);

    logger.info({ selectedCount: results.length }, 'Topic selection completed');
    return results;
  }

  private calculateFinalScore(candidate: TopicRecommendation, weights: TopicSelectionConfig['weights']): number {
    const { searchVolume = 0.3, commissionRate = 0.25, contentGap = 0.25, trendVelocity = 0.2 } = weights;

    // Normalize search volume (0-1)
    const volumeScore = Math.min(candidate.keywordData.volume / 100000, 1);

    // Commission rate (0-1)
    const commissionScore = candidate.affiliateData?.commissionRate || 0;

    // Content gap (0-1) - inverse of competitor count
    const competitorCount = candidate.competitorPosts?.length || 0;
    const gapScore = Math.max(1 - competitorCount / 20, 0);

    // Trend velocity
    const trendScores = { rising: 1, stable: 0.5, falling: 0 };
    const trendScore = trendScores[candidate.keywordData.trend] || 0.5;

    return (
      volumeScore * searchVolume +
      commissionScore * commissionRate +
      gapScore * contentGap +
      trendScore * trendVelocity
    );
  }
}

export interface TopicCandidateInput {
  keywordData: KeywordData;
  affiliateData?: AffiliateProduct;
  competitorPosts?: CompetitorPost[];
}

export class TopicCandidateBuilder {
  static build(input: TopicCandidateInput): TopicRecommendation {
    const { keywordData, affiliateData, competitorPosts } = input;

    // Analyze competitor content gaps
    const contentGap = this.analyzeContentGap(competitorPosts || []);
    const suggestedAngles = this.generateAngles(keywordData, competitorPosts || []);
    const recommendedTemplate = this.recommendTemplate(keywordData, affiliateData);

    return {
      keyword: keywordData.keyword,
      keywordData,
      affiliateData,
      competitorPosts,
      contentGap,
      suggestedAngles,
      recommendedTemplate,
      priority: 'medium',
      estimatedEffort: this.estimateEffort(competitorPosts?.length || 0),
    };
  }

  private static analyzeContentGap(posts: CompetitorPost[]): string[] {
    const gaps: string[] = [];

    if (posts.length === 0) {
      gaps.push('경쟁 포스트 없음 - 선점 기회');
      return gaps;
    }

    // Check for missing elements
    const hasAffiliateLinks = posts.some(p => p.affiliateLinks && p.affiliateLinks.length > 0);
    const hasDetailedSpecs = posts.some(p => p.structure.some(s => s.text.includes('스펙') || s.text.includes('사양')));
    const hasComparison = posts.some(p => p.structure.some(s => s.text.includes('비교') || s.text.includes('vs')));
    const hasProsCons = posts.some(p => p.structure.some(s => s.text.includes('장점') || s.text.includes('단점')));
    const hasVideo = posts.some(p => p.metadata?.hasVideo);
    const avgImageCount = posts.reduce((sum, p) => sum + (p.metadata?.imageCount || 0), 0) / posts.length;

    if (!hasAffiliateLinks) gaps.push('제휴 링크 부재 - 수익화 기회');
    if (!hasDetailedSpecs) gaps.push('상세 스펙 분석 부족');
    if (!hasComparison) gaps.push('경쟁 제품 비교 없음');
    if (!hasProsCons) gaps.push('장단점 정리 누락');
    if (!hasVideo) gaps.push('영상/쇼츠 콘텐츠 부재');
    if (avgImageCount < 5) gaps.push('이미지 수 부족 - 시각적 콘텐츠 보강 필요');

    return gaps.length > 0 ? gaps : ['경쟁 포스트와 차별화 필요'];
  }

  private static generateAngles(keywordData: KeywordData, posts: CompetitorPost[]): string[] {
    const angles: string[] = [];

    // Trend-based angles
    if (keywordData.trend === 'rising') {
      angles.push('트렌드 선점: 급상승 키워드 조기 공략');
    }

    // Related keywords angles
    if (keywordData.related.length > 0) {
      angles.push(`연관 키워드 확장: ${keywordData.related.slice(0, 3).join(', ')} 등`);
    }

    // Competitor gap angles
    const hasReview = posts.some(p => /리뷰|후기|사용기/.test(p.title));
    const hasComparison = posts.some(p => /비교|vs|대결/.test(p.title));
    const hasGuide = posts.some(p => /가이드|추천|선택|고르는/.test(p.title));

    if (!hasReview) angles.push('실사용 리뷰 앵글');
    if (!hasComparison) angles.push('경쟁 제품 비교 앵글');
    if (!hasGuide) angles.push('구매 가이드/추천 앵글');

    // Seasonal angles
    const month = new Date().getMonth();
    if (month >= 2 && month <= 4) angles.push('봄 시즌 맞춤 콘텐츠');
    if (month >= 5 && month <= 7) angles.push('여름 시즌 맞춤 콘텐츠');
    if (month >= 8 && month <= 10) angles.push('가을 시즌 맞춤 콘텐츠');
    if (month === 11 || month <= 1) angles.push('겨울/연말 시즌 맞춤 콘텐츠');

    return angles.slice(0, 5);
  }

  private static recommendTemplate(keywordData: KeywordData, affiliateData?: AffiliateProduct): string {
    if (affiliateData) {
      return 'coupang-product-review';
    }

    // Based on keyword type
    if (/\b(비교|vs|대결|순위|추천)\b/.test(keywordData.keyword)) {
      return 'product-comparison';
    }
    if (/\b(가이드|선택|고르는|구매)\b/.test(keywordData.keyword)) {
      return 'buying-guide';
    }
    if (/\b(후기|리뷰|사용기|장단점)\b/.test(keywordData.keyword)) {
      return 'product-review';
    }

    return 'coupang-product-review'; // default
  }

  private static estimateEffort(competitorCount: number): 'low' | 'medium' | 'high' {
    if (competitorCount < 3) return 'low';
    if (competitorCount < 10) return 'medium';
    return 'high';
  }
}

export function createTopicSelector(): TopicSelectorImpl {
  return new TopicSelectorImpl();
}