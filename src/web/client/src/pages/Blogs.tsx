import React, { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { api } from '../services/api';
import { BlogInfo, Category } from '@shared/types';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Globe, RefreshCw, ExternalLink, Plus } from 'lucide-react';
import { toast } from './ui/use-toast';

export default function Blogs() {
  const [blogs, setBlogs] = useState<BlogInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);

  useEffect(() => {
    fetchBlogs();
  }, []);

  const fetchBlogs = async () => {
    try {
      const response = await api.get('/api/blogs');
      setBlogs(response.data.blogs);
    } catch {
      toast({
        title: '오류',
        description: '블로그 목록을 불러오는데 실패했습니다.',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSyncCategories = async (blogName: string) => {
    setSyncing(blogName);
    try {
      await api.post(`/api/blogs/${blogName}/sync-categories`);
      toast({ title: '성공', description: '카테고리가 동기화되었습니다.' });
      fetchBlogs();
    } catch {
      toast({
        title: '오류',
        description: '카테고리 동기화에 실패했습니다.',
        variant: 'destructive',
      });
    } finally {
      setSyncing(null);
    }
  };

  const handlePublish = async (blogName: string) => {
    // Navigate to posts page with platform filter
    window.location.href = `/posts?platform=${blogName}`;
  };

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
          <h1 className="text-3xl font-bold">블로그 관리</h1>
          <p className="text-muted-foreground">
            연동된 블로그 플랫폼을 관리하고 발행 현황을 확인하세요
          </p>
        </div>
        <Button asChild>
          <a href="/settings">
            <Plus className="h-4 w-4 mr-2" />
            연동 추가/관리
          </a>
        </Button>
      </div>

      {blogs.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Globe className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">연동된 블로그가 없습니다</h3>
            <p className="text-muted-foreground mb-6">설정에서 블로그 플랫폼을 연동해보세요.</p>
            <Button asChild>
              <a href="/settings">설정으로 이동</a>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {blogs.map((blog) => (
            <Card key={blog.name} className="overflow-hidden">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <div className="flex items-center gap-3">
                  <div
                    className={clsx(
                      'h-10 w-10 rounded-lg flex items-center justify-center',
                      blog.connected ? 'bg-green-100' : 'bg-red-100',
                    )}
                  >
                    <Globe
                      className={clsx(
                        'h-5 w-5',
                        blog.connected ? 'text-green-600' : 'text-red-600',
                      )}
                    />
                  </div>
                  <div>
                    <h3 className="font-semibold">{blog.name}</h3>
                    <p className="text-sm text-muted-foreground capitalize">{blog.platform}</p>
                  </div>
                </div>
                <Badge variant={blog.connected ? 'default' : 'destructive'}>
                  {blog.connected ? '연결됨' : '연결 안됨'}
                </Badge>
              </CardHeader>

              <CardContent className="space-y-4">
                {/* Last post */}
                {blog.lastPost && (
                  <div className="p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center justify-between mb-2">
                      <p className="text-sm font-medium">최근 발행 포스트</p>
                      <Button variant="ghost" size="icon" asChild>
                        <a href={blog.lastPost.url} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    </div>
                    <p className="text-sm truncate">{blog.lastPost.title}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {new Date(blog.lastPost.publishedAt).toLocaleDateString()} •{' '}
                      {blog.lastPost.status}
                    </p>
                  </div>
                )}

                {/* Categories */}
                {blog.categories && blog.categories.length > 0 && (
                  <div>
                    <p className="text-sm font-medium mb-2">카테고리 ({blog.categories.length})</p>
                    <div className="flex flex-wrap gap-1">
                      {blog.categories.slice(0, 5).map((cat: Category) => (
                        <Badge key={cat.id} variant="outline" className="text-xs">
                          {cat.name}
                        </Badge>
                      ))}
                      {blog.categories.length > 5 && (
                        <Badge variant="outline" className="text-xs">
                          +{blog.categories.length - 5}개 더
                        </Badge>
                      )}
                    </div>
                  </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => handleSyncCategories(blog.name)}
                    disabled={syncing === blog.name}
                  >
                    {syncing === blog.name ? (
                      <RefreshCw className="h-4 w-4 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-1" />
                    )}
                    카테고리 동기화
                  </Button>
                  <Button size="sm" className="flex-1" onClick={() => handlePublish(blog.name)}>
                    <Plus className="h-4 w-4 mr-1" />
                    포스트 발행
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
