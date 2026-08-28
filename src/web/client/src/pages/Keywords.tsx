import React, { useState, useEffect } from 'react';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Badge } from './ui/Badge';
import {
  Search,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  ExternalLink,
  BarChart3,
  Users,
} from 'lucide-react';

interface KeywordResult {
  keyword: string;
  volume: number;
  competition: number;
  trend: 'rising' | 'falling' | 'stable';
  related: string[];
  source: string;
}

interface BlogCompetitor {
  title: string;
  link: string;
  bloggername: string;
  postdate: string;
  description: string;
}

interface TrendingResponse {
  trending: KeywordResult[];
  totalResults: number;
  blogs: BlogCompetitor[];
  searchedAt: string;
  source: string;
  error?: string;
}

interface TopKeywordsResponse {
  keywords?: KeywordResult[];
  error?: string;
}

function CompetitionBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const filled = Math.round(value * 10);
  const color = pct < 30 ? '#2b8a3e' : pct < 60 ? '#e67700' : '#c92a2a';
  return (
    <div className="flex items-center gap-1.5">
      <span style={{ color }} className="text-xs font-mono tracking-tighter">
        {'█'.repeat(filled)}
        {'░'.repeat(10 - filled)}
      </span>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}

function TrendBadge({ trend }: { trend: string }) {
  if (trend === 'rising')
    return (
      <Badge className="bg-green-100 text-green-700">
        <TrendingUp className="h-3 w-3 mr-1" />
        상승
      </Badge>
    );
  if (trend === 'falling')
    return (
      <Badge className="bg-red-100 text-red-700">
        <TrendingDown className="h-3 w-3 mr-1" />
        하락
      </Badge>
    );
  return (
    <Badge variant="outline">
      <Minus className="h-3 w-3 mr-1" />
      보합
    </Badge>
  );
}

export default function Keywords() {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrendingResponse | null>(null);
  const [error, setError] = useState('');

  const [topKeywords, setTopKeywords] = useState<KeywordResult[]>([]);
  const [topLoading, setTopLoading] = useState(true);
  const [topError, setTopError] = useState('');

  useEffect(() => {
    (async () => {
      setTopLoading(true);
      try {
        const response = await api.get('/api/keywords/top?limit=20');
        const data = response.data as TopKeywordsResponse;
        if (data?.keywords && Array.isArray(data.keywords)) {
          setTopKeywords(data.keywords);
        }
        if (data?.error) setTopError(data.error);
      } catch (err) {
        setTopError(
          (isAxiosError<{ error?: string }>(err) && err.response?.data?.error) ||
            'TOP 키워드를 불러오는데 실패했습니다.',
        );
      } finally {
        setTopLoading(false);
      }
    })();
  }, []);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const response = await api.get(
        `/api/keywords/trending?q=${encodeURIComponent(query)}&limit=${limit}`,
      );
      setResult(response.data);
      if (response.data.error) setError(response.data.error);
    } catch (err) {
      setError(
        (isAxiosError<{ error?: string }>(err) && err.response?.data?.error) ||
          '검색에 실패했습니다.',
      );
    } finally {
      setLoading(false);
    }
  };

  const sortedKeywords =
    result?.trending?.sort(
      (a, b) => b.volume * (1 - b.competition) - a.volume * (1 - a.competition),
    ) || [];

  const renderKeywordTable = (keywords: KeywordResult[]) => (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b text-left text-sm text-muted-foreground">
            <th className="pb-3 pr-4 font-medium">#</th>
            <th className="pb-3 pr-4 font-medium">키워드</th>
            <th className="pb-3 pr-4 font-medium">추정 검색량</th>
            <th className="pb-3 pr-4 font-medium">경쟁도</th>
            <th className="pb-3 pr-4 font-medium">트렌드</th>
            <th className="pb-3 font-medium">연관 키워드</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr key={kw.keyword + i} className="border-b hover:bg-muted/50 transition-colors">
              <td className="py-3 pr-4 font-mono text-sm text-muted-foreground">{i + 1}</td>
              <td className="py-3 pr-4 font-medium">{kw.keyword}</td>
              <td className="py-3 pr-4">
                {kw.volume > 0 ? `~${kw.volume.toLocaleString()}` : '-'}
              </td>
              <td className="py-3 pr-4">
                <CompetitionBar value={kw.competition} />
              </td>
              <td className="py-3 pr-4">
                <TrendBadge trend={kw.trend} />
              </td>
              <td className="py-3 text-sm text-muted-foreground max-w-xs truncate">
                {(kw.related || []).slice(0, 5).join(', ') || '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold">키워드 리서치</h1>
        <p className="text-muted-foreground">
          네이버 API Hub로 인기 키워드를 찾고 경쟁 블로그를 분석하세요
        </p>
      </div>

      {/* Search Form */}
      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch();
            }}
            className="flex flex-col sm:flex-row gap-3"
          >
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
              <Input
                placeholder="키워드 입력 (예: 무선청소기 추천)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-10"
                disabled={loading}
              />
            </div>
            <select
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value))}
              className="h-10 px-3 rounded-md border border-input bg-background text-sm"
              disabled={loading}
            >
              {[10, 20, 50].map((n) => (
                <option key={n} value={n}>
                  {n}개
                </option>
              ))}
            </select>
            <Button type="submit" disabled={loading || !query.trim()}>
              {loading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <BarChart3 className="h-4 w-4 mr-2" />
              )}
              분석
            </Button>
          </form>
        </CardContent>
      </Card>

      {loading && (
        <Card>
          <CardContent className="p-12 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-muted-foreground">
              네이버 API Hub에서 데이터를 가져오는 중...
            </span>
          </CardContent>
        </Card>
      )}

      {error && !loading && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-destructive text-sm">{error}</CardContent>
        </Card>
      )}

      {/* Keyword Results */}
      {!loading && sortedKeywords.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">📊 키워드 분석 결과</CardTitle>
            {result && (
              <Badge variant="outline" className="text-xs">
                총 {result.totalResults.toLocaleString()}개 검색결과
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 pr-4 font-medium">#</th>
                    <th className="pb-3 pr-4 font-medium">키워드</th>
                    <th className="pb-3 pr-4 font-medium">추정 검색량</th>
                    <th className="pb-3 pr-4 font-medium">경쟁도</th>
                    <th className="pb-3 pr-4 font-medium">트렌드</th>
                    <th className="pb-3 font-medium">연관 키워드</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedKeywords.map((kw, i) => (
                    <tr
                      key={kw.keyword + i}
                      className="border-b hover:bg-muted/50 transition-colors"
                    >
                      <td className="py-3 pr-4 font-mono text-sm text-muted-foreground">{i + 1}</td>
                      <td className="py-3 pr-4 font-medium">{kw.keyword}</td>
                      <td className="py-3 pr-4">
                        {kw.volume > 0 ? `~${kw.volume.toLocaleString()}` : '-'}
                      </td>
                      <td className="py-3 pr-4">
                        <CompetitionBar value={kw.competition} />
                      </td>
                      <td className="py-3 pr-4">
                        <TrendBadge trend={kw.trend} />
                      </td>
                      <td className="py-3 text-sm text-muted-foreground max-w-xs truncate">
                        {kw.related.slice(0, 5).join(', ') || '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top 20 keywords (query-less feed) */}
      {topLoading && topKeywords.length === 0 && (
        <Card>
          <CardContent className="p-12 flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <span className="ml-3 text-muted-foreground">TOP 20 키워드를 불러오는 중...</span>
          </CardContent>
        </Card>
      )}

      {topError && !topLoading && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-destructive text-sm">{topError}</CardContent>
        </Card>
      )}

      {!topLoading && topKeywords.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">📊 블로그 키워드 TOP 20</CardTitle>
            <Badge variant="outline" className="text-xs">
              네이버 API Hub
            </Badge>
          </CardHeader>
          <CardContent>
            {renderKeywordTable(topKeywords)}
            <small className="block mt-3 text-xs text-muted-foreground">
              검색량·경쟁도는 네이버 블로그 검색 결과 기반 추정치입니다
            </small>
          </CardContent>
        </Card>
      )}

      {/* Blog Competitors */}
      {!loading && result?.blogs && result.blogs.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">📝 경쟁 블로그 TOP {result.blogs.length}</CardTitle>
            <Users className="h-5 w-5 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {result.blogs.map((blog, i) => (
                <a
                  key={i}
                  href={blog.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block p-3 rounded-lg border hover:bg-accent/50 transition-colors group"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-sm truncate group-hover:text-primary transition-colors">
                        {i + 1}. {blog.title}
                      </p>
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {blog.description}
                      </p>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                        <span>{blog.bloggername}</span>
                        {blog.postdate && /^\d{8}$/.test(blog.postdate) && (
                          <span>{`${blog.postdate.slice(0, 4)}-${blog.postdate.slice(4, 6)}-${blog.postdate.slice(6, 8)}`}</span>
                        )}
                      </div>
                    </div>
                    <ExternalLink className="h-4 w-4 shrink-0 mt-1 text-muted-foreground group-hover:text-primary" />
                  </div>
                </a>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Empty State */}
      {!loading && !result && (
        <Card>
          <CardContent className="p-12 text-center text-muted-foreground">
            <Search className="h-12 w-12 mx-auto mb-4 opacity-30" />
            <p>키워드를 입력하고 [분석] 버튼을 누르세요</p>
            <p className="text-sm mt-2">네이버 API Hub에서 검색량, 경쟁도, 트렌드를 분석합니다</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
