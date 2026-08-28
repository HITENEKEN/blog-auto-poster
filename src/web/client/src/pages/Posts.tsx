import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../services/api';
import { PostSummary } from '@shared/types';
import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Badge } from './ui/Badge';
import { FileText, RefreshCw, ExternalLink } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';

const statusColors = {
  published: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  publishing: 'bg-yellow-100 text-yellow-700',
  ready: 'bg-blue-100 text-blue-700',
  draft: 'bg-gray-100 text-gray-700',
  generating: 'bg-purple-100 text-purple-700',
};

export default function Posts() {
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({
    status: '',
    platform: '',
    template: '',
    limit: 20,
  });

  const fetchPosts = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: String(filters.limit),
        offset: String((page - 1) * filters.limit),
        ...(filters.status && { status: filters.status }),
        ...(filters.platform && { platform: filters.platform }),
        ...(filters.template && { template: filters.template }),
      });
      const response = await api.get(`/api/posts?${params}`);
      setPosts(response.data.posts);
      setTotal(response.data.total);
    } catch (error) {
      console.error('Failed to fetch posts:', error);
    } finally {
      setLoading(false);
    }
  }, [page, filters]);
  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  const handlePublish = async (post: PostSummary) => {
    try {
      await api.post(`/api/posts/${post.id}/publish`, { platform: post.platform });
      fetchPosts();
    } catch (error) {
      console.error('Publish failed:', error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">포스트 관리</h1>
          <p className="text-muted-foreground">생성된 포스트를 확인하고 발행하세요</p>
        </div>
        <Button variant="outline" onClick={fetchPosts} disabled={loading}>
          <RefreshCw className={clsx('h-4 w-4 mr-2', loading && 'animate-spin')} />
          새로고침
        </Button>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-4">
            <Select
              value={filters.status}
              onValueChange={(v) => setFilters({ ...filters, status: v })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="상태" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">전체</SelectItem>
                <SelectItem value="published">발행됨</SelectItem>
                <SelectItem value="failed">실패</SelectItem>
                <SelectItem value="ready">준비됨</SelectItem>
                <SelectItem value="draft">초안</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.platform}
              onValueChange={(v) => setFilters({ ...filters, platform: v })}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="플랫폼" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">전체</SelectItem>
                <SelectItem value="tistory">티스토리</SelectItem>
                <SelectItem value="wordpress">워드프레스</SelectItem>
                <SelectItem value="youtube-shorts">유튜브 쇼츠</SelectItem>
              </SelectContent>
            </Select>
            <Input
              placeholder="템플릿 검색"
              value={filters.template}
              onChange={(e) => setFilters({ ...filters, template: e.target.value })}
              className="w-[200px]"
            />
          </div>
        </CardContent>
      </Card>

      {/* Posts table */}
      <Card>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
            </div>
          ) : posts.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>포스트가 없습니다.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="pb-3 font-medium">제목</th>
                      <th className="pb-3 font-medium">플랫폼</th>
                      <th className="pb-3 font-medium">템플릿</th>
                      <th className="pb-3 font-medium">상태</th>
                      <th className="pb-3 font-medium">발행일</th>
                      <th className="pb-3 font-medium">액션</th>
                    </tr>
                  </thead>
                  <tbody>
                    {posts.map((post) => (
                      <tr key={post.id} className="border-b hover:bg-muted/50">
                        <td className="py-3">
                          <div>
                            <p className="font-medium truncate max-w-xs">{post.title}</p>
                            <p className="text-xs text-muted-foreground">{post.productId}</p>
                          </div>
                        </td>
                        <td className="py-3">
                          <Badge variant="outline" className="capitalize">
                            {post.platform}
                          </Badge>
                        </td>
                        <td className="py-3 text-sm text-muted-foreground">{post.template}</td>
                        <td className="py-3">
                          <Badge
                            className={clsx(
                              statusColors[post.status as keyof typeof statusColors] ||
                                statusColors.draft,
                            )}
                          >
                            {post.status === 'published'
                              ? '발행됨'
                              : post.status === 'failed'
                                ? '실패'
                                : post.status}
                          </Badge>
                        </td>
                        <td className="py-3 text-sm text-muted-foreground">
                          {formatDistanceToNow(new Date(post.publishedAt), { addSuffix: true })}
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            {post.url && (
                              <Button variant="ghost" size="icon" asChild>
                                <a
                                  href={post.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  title="보기"
                                >
                                  <ExternalLink className="h-4 w-4" />
                                </a>
                              </Button>
                            )}
                            {post.status !== 'published' && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handlePublish(post)}
                              >
                                발행
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {total > filters.limit && (
                <div className="flex items-center justify-between border-t pt-4">
                  <p className="text-sm text-muted-foreground">
                    총 {total}개 중 {(page - 1) * filters.limit + 1}~
                    {Math.min(page * filters.limit, total)}개
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                    >
                      이전
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setPage((p) => p + 1)}
                      disabled={page * filters.limit >= total}
                    >
                      다음
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
