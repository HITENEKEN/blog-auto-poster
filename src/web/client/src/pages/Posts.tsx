import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { PostSummary } from '@shared/types';
import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { Badge } from './ui/Badge';
import { FileText, RefreshCw, ExternalLink, Pencil, Loader2, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { clsx } from 'clsx';
import { isAxiosError } from 'axios';
import { Dialog } from './ui/dialog';
import { useToast } from './ui/use-toast';
/** GET /api/posts/drafts 항목 — 백엔드가 키워드 생성 진행 상황을 generationStatus로 함께 내려준다. */
interface DraftSummary {
  id: string;
  title: string;
  status: string;
  template: string;
  createdAt: string;
  generationStatus?: 'generating' | 'done' | 'failed';
  generationError?: string;
}

const statusColors = {
  published: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
  publishing: 'bg-yellow-100 text-yellow-700',
  ready: 'bg-blue-100 text-blue-700',
  draft: 'bg-gray-100 text-gray-700',
  generating: 'bg-purple-100 text-purple-700',
};

export default function Posts() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [posts, setPosts] = useState<PostSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
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

  const [deleteTarget, setDeleteTarget] = useState<DraftSummary | null>(null);
  const [deleting, setDeleting] = useState(false);

  const fetchDrafts = useCallback(async () => {
    try {
      const response = await api.get<{ drafts: DraftSummary[] }>('/api/posts/drafts');
      setDrafts(response.data.drafts || []);
    } catch {
      setDrafts([]);
    }
  }, []);

  useEffect(() => {
    fetchDrafts();
  }, [fetchDrafts]);

  // 키워드 기반 생성이 백그라운드에서 진행 중이면 5초 간격으로 목록 재조회.
  // 전부 완료/실패가 되면 재조회를 중단한다.
  const hasGenerating = drafts.some((d) => d.generationStatus === 'generating');
  useEffect(() => {
    if (!hasGenerating) return;
    const timer = setInterval(fetchDrafts, 5000);
    return () => clearInterval(timer);
  }, [hasGenerating, fetchDrafts]);

  const handleDeleteDraft = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.delete(`/api/posts/${deleteTarget.id}`);
      const deleted = deleteTarget;
      setDrafts((prev) => prev.filter((d) => d.id !== deleted.id));
      toast({ title: '삭제되었습니다', description: deleted.title || deleted.id });
      setDeleteTarget(null);
    } catch (error) {
      toast({
        title: '삭제 실패',
        description:
          (isAxiosError(error) && error.response?.data?.error) || '드래프트 삭제에 실패했습니다.',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  /** 편집화면 재진입/재발행에 사용할 드래프트 디렉터리 id (이슈 #10).
   *  과거 레코드는 draftId가 없으므로 실패 건(post_id === 드래프트 id)만 폴백한다. */
  const resolveDraftId = (post: PostSummary): string | null =>
    post.draftId ?? (post.status === 'failed' ? post.postId : null);

  const handlePublish = async (post: PostSummary) => {
    const draftId = resolveDraftId(post);
    if (!draftId) {
      toast({
        title: '재발행 불가',
        description: '원본 드래프트를 찾을 수 없습니다.',
        variant: 'destructive',
      });
      return;
    }
    try {
      await api.post(`/api/posts/${draftId}/publish`, { platform: post.platform });
      toast({ title: '발행 요청이 완료되었습니다' });
      fetchPosts();
    } catch (error) {
      console.error('Publish failed:', error);
      toast({
        title: '발행 실패',
        description: (isAxiosError(error) && error.response?.data?.error) || '발행에 실패했습니다.',
        variant: 'destructive',
      });
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

      {/* 임시저장 드래프트 */}
      {drafts.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <h2 className="mb-3 text-sm font-semibold">임시저장 드래프트</h2>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-muted-foreground">
                    <th className="pb-3 font-medium">제목</th>
                    <th className="pb-3 font-medium">템플릿</th>
                    <th className="pb-3 font-medium">생성일</th>
                    <th className="pb-3 font-medium">상태</th>
                    <th className="pb-3 font-medium">액션</th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((draft) => (
                    <tr key={draft.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 font-medium">{draft.title || draft.id}</td>
                      <td className="py-3 text-sm text-muted-foreground">{draft.template}</td>
                      <td className="py-3 text-sm text-muted-foreground">
                        {draft.createdAt
                          ? formatDistanceToNow(new Date(draft.createdAt), { addSuffix: true })
                          : '-'}
                      </td>
                      <td className="py-3">
                        {draft.generationStatus === 'generating' ? (
                          <Badge className="bg-yellow-100 text-yellow-700">
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                            작업중
                          </Badge>
                        ) : draft.generationStatus === 'failed' ? (
                          <Badge
                            className="bg-red-100 text-red-700"
                            title={draft.generationError || '생성에 실패했습니다.'}
                          >
                            실패
                          </Badge>
                        ) : null}
                        {draft.generationStatus === 'failed' && draft.generationError && (
                          <p
                            className="mt-1 max-w-[220px] truncate text-xs text-red-600"
                            title={draft.generationError}
                          >
                            {draft.generationError}
                          </p>
                        )}
                      </td>
                      <td className="py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => navigate(`/posts/${draft.id}/edit`)}
                          >
                            <Pencil className="mr-2 h-3 w-3" />
                            편집
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="삭제"
                            onClick={() => setDeleteTarget(draft)}
                          >
                            <Trash2 className="h-4 w-4 text-red-500" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

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
                            {resolveDraftId(post) && (
                              <Button
                                variant="outline"
                                size="sm"
                                title="편집화면에서 수정 후 재발행할 수 있습니다"
                                onClick={() => navigate(`/posts/${resolveDraftId(post)}/edit`)}
                              >
                                <Pencil className="mr-2 h-3 w-3" />
                                편집
                              </Button>
                            )}
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
                                disabled={!resolveDraftId(post)}
                                title={
                                  resolveDraftId(post)
                                    ? '재발행'
                                    : '원본 드래프트가 없어 재발행할 수 없습니다'
                                }
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

      {/* 드래프트 삭제 확인 */}
      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!deleting) setDeleteTarget(null);
        }}
        title="드래프트 삭제"
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={deleting}>
              취소
            </Button>
            <Button variant="destructive" onClick={handleDeleteDraft} disabled={deleting}>
              {deleting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              삭제
            </Button>
          </>
        }
      >
        <p className="text-sm">
          삭제하시겠습니까?{' '}
          <span className="font-medium">{deleteTarget?.title || deleteTarget?.id}</span>
        </p>
        {deleteTarget?.generationStatus === 'generating' && (
          <p className="mt-2 text-xs text-muted-foreground">
            이 드래프트는 현재 생성 중입니다. 삭제하면 생성 작업도 중단됩니다.
          </p>
        )}
      </Dialog>
    </div>
  );
}
