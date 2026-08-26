import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { CoupangStatus } from '@shared/types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { ShoppingBag, TrendingUp, TrendingDown, DollarSign, MousePointer, RefreshCw } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export default function Coupang() {
  const [status, setStatus] = useState<CoupangStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 60000);
    return () => clearInterval(interval);
  }, []);

  const fetchStatus = async () => {
    try {
      const response = await api.get('/api/coupang/status');
      setStatus(response.data);
    } catch (error) {
      console.error('Failed to fetch Coupang status:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    { title: '총 수익', value: '₩0', icon: <DollarSign className="h-6 w-6 text-green-600" />, color: 'bg-green-100' },
    { title: '클릭 수', value: '0', icon: <MousePointer className="h-6 w-6 text-blue-600" />, color: 'bg-blue-100' },
    { title: '전환 수', value: '0', icon: <TrendingUp className="h-6 w-6 text-purple-600" />, color: 'bg-purple-100' },
    { title: '승인율', value: '0%', icon: <CheckCircle className="h-6 w-6 text-orange-600" />, color: 'bg-orange-100' },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">쿠팡 파트너스 현황</h1>
          <p className="text-muted-foreground">제휴 수익과 성과 지표를 실시간으로 확인하세요</p>
        </div>
        <Button variant="outline" onClick={fetchStatus} disabled={loading}>
          <RefreshCw className={clsx('h-4 w-4 mr-2', loading && 'animate-spin')} />
          새로고침
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => (
          <Card key={stat.title}>
            <CardContent className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">{stat.title}</p>
                  <p className="text-3xl font-bold mt-1">{stat.value}</p>
                </div>
                <div className={clsx('p-3 rounded-full', stat.color)}>{stat.icon}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>일별 수익 추이</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64 flex items-end justify-around px-4">
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div
                    className="w-12 bg-primary rounded-t transition-all hover:bg-primary/80"
                    style={{ height: `${Math.random() * 100 + 20}px` }}
                  />
                  <span className="text-xs text-muted-foreground">{formatDistanceToNow(new Date(Date.now() - (6 - i) * 86400000), { addSuffix: true })}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>인기 상품 Top 10</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted/50">
                  <span className="w-6 text-center font-bold text-muted-foreground">{i + 1}</span>
                  <div className="h-10 w-10 bg-muted rounded flex items-center justify-center">
                    <ShoppingBag className="h-5 w-5 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">상품명 {i + 1}</p>
                    <p className="text-xs text-muted-foreground">카테고리 • ₩{Math.floor(Math.random() * 100000 + 10000).toLocaleString()}</p>
                  </div>
                  <span className="text-sm font-medium text-primary">₩{Math.floor(Math.random() * 50000 + 1000).toLocaleString()}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { clsx } from 'clsx';
import { CheckCircle } from 'lucide-react';