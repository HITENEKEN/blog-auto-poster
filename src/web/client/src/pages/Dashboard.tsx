import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { DashboardStats, RecentPost } from '@shared/types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import {
  FileText,
  TrendingUp,
  TrendingDown,
  Globe,
  ShoppingBag,
  Clock,
  CheckCircle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ title, value, change, icon, color }: StatCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold mt-1">{value}</p>
            {change !== undefined && (
              <p
                className={clsx(
                  'text-sm mt-1 flex items-center gap-1',
                  change >= 0 ? 'text-green-600' : 'text-red-600',
                )}
              >
                {change >= 0 ? (
                  <TrendingUp className="h-4 w-4" />
                ) : (
                  <TrendingDown className="h-4 w-4" />
                )}
                {Math.abs(change)}% vs 지난주
              </p>
            )}
          </div>
          <div className={clsx('p-3 rounded-full', color)}>{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const response = await api.get('/api/dashboard/stats');
        setStats(response.data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '데이터를 불러오는데 실패했습니다.');
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="border-destructive">
        <CardContent className="p-6 text-center text-destructive">
          {error}
          <Button variant="outline" className="mt-4" onClick={() => window.location.reload()}>
            다시 시도
          </Button>
        </CardContent>
      </Card>
    );
  }

  const successRate = stats?.successRate ? Math.round(stats.successRate * 100) : 0;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">대시보드</h1>
          <p className="text-muted-foreground">블로그 자동 포스팅 현황을 한눈에 확인하세요</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline">리포트 다운로드</Button>
          <Button>새 포스트 생성</Button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="총 포스트"
          value={stats?.totalPosts || 0}
          icon={<FileText className="h-6 w-6 text-primary" />}
          color="bg-primary/10"
        />
        <StatCard
          title="오늘 발행"
          value={stats?.todayPosts || 0}
          change={12}
          icon={<Clock className="h-6 w-6 text-green-600" />}
          color="bg-green-100"
        />
        <StatCard
          title="발행 성공"
          value={stats?.publishedPosts || 0}
          icon={<CheckCircle className="h-6 w-6 text-green-600" />}
          color="bg-green-100"
        />
        <StatCard
          title="성공률"
          value={`${successRate}%`}
          icon={<TrendingUp className="h-6 w-6 text-blue-600" />}
          color="bg-blue-100"
        />
      </div>

      {/* Charts and recent activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Platform distribution */}
        <Card>
          <CardHeader>
            <CardTitle>플랫폼별 발행 현황</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(stats?.platforms || {}).map(([platform, connected]) => (
                <div key={platform} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={clsx(
                        'h-3 w-3 rounded-full',
                        connected ? 'bg-green-500' : 'bg-red-500',
                      )}
                    />
                    <span className="capitalize">{platform}</span>
                  </div>
                  <span className="text-sm text-muted-foreground">
                    {connected ? '연결됨' : '연결 안됨'}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Affiliate status */}
        <Card>
          <CardHeader>
            <CardTitle>제휴 네트워크 상태</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {Object.entries(stats?.affiliates || {}).map(([affiliate, connected]) => (
                <div key={affiliate} className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <ShoppingBag className="h-5 w-5 text-muted-foreground" />
                    <span className="capitalize">{affiliate}</span>
                  </div>
                  <span
                    className={clsx(
                      'text-sm font-medium',
                      connected ? 'text-green-600' : 'text-red-600',
                    )}
                  >
                    {connected ? '연결됨' : '연결 안됨'}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Recent posts */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>최근 발행 포스트</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <a href="/posts">전체 보기</a>
            </Button>
          </CardHeader>
          <CardContent>
            {stats?.recentPosts?.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">발행된 포스트가 없습니다.</p>
            ) : (
              <div className="space-y-3">
                {stats.recentPosts.map((post: RecentPost) => (
                  <div
                    key={post.id}
                    className="flex items-center justify-between p-3 rounded-lg border hover:bg-accent/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={clsx(
                          'h-2 w-2 rounded-full',
                          post.status === 'published' ? 'bg-green-500' : 'bg-red-500',
                        )}
                      />
                      <div>
                        <p className="font-medium truncate max-w-xs">{post.title}</p>
                        <p className="text-sm text-muted-foreground">
                          {post.platform} •{' '}
                          {formatDistanceToNow(new Date(post.publishedAt), { addSuffix: true })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={clsx(
                          'px-2 py-1 rounded-full text-xs',
                          post.status === 'published'
                            ? 'bg-green-100 text-green-700'
                            : 'bg-red-100 text-red-700',
                        )}
                      >
                        {post.status === 'published' ? '발행됨' : '실패'}
                      </span>
                      <Button variant="ghost" size="icon" asChild>
                        <a href={post.url} target="_blank" rel="noopener noreferrer">
                          <Globe className="h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Job queue status */}
        <Card>
          <CardHeader>
            <CardTitle>작업 큐 현황</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold">{stats?.jobQueue?.pending || 0}</p>
                <p className="text-xs text-muted-foreground">대기중</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.jobQueue?.running || 0}</p>
                <p className="text-xs text-muted-foreground">실행중</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.jobQueue?.completed || 0}</p>
                <p className="text-xs text-muted-foreground">완료</p>
              </div>
              <div>
                <p className="text-2xl font-bold">{stats?.jobQueue?.failed || 0}</p>
                <p className="text-xs text-muted-foreground">실패</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { clsx } from 'clsx';
