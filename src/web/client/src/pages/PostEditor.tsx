import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Select } from './ui/Select';
import { useToast } from './ui/use-toast';
import RichEditor from '../components/Editor/RichEditor';
import { ArrowLeft, Check, Loader2, Rocket, Save, Sparkles, X } from 'lucide-react';

interface PostPayload {
  post: {
    id: string;
    meta: { title?: string; template?: string; [key: string]: unknown };
    content: string;
  };
}

interface BlogInfo {
  name: string;
  platform: string;
  connected: boolean;
}

export default function PostEditor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [platform, setPlatform] = useState('');
  /** 발행 시점 AI 최종 다듬기(이슈 #12) — 기본 ON, 체크박스로 끌 수 있다. */
  const [aiPolish, setAiPolish] = useState(true);
  const [blogs, setBlogs] = useState<BlogInfo[]>([]);
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiHistory, setAiHistory] = useState<
    Array<{ prompt: string; status: 'success' | 'error'; message?: string }>
  >([]);

  const fetchPost = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const response = await api.get<PostPayload>(`/api/posts/${id}`);
      setTitle(response.data.post.meta?.title ?? '');
      setContent(response.data.post.content ?? '');
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) setNotFound(true);
      else
        toast({
          title: '포스트를 불러오지 못했습니다',
          variant: 'destructive',
        });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchPost();
  }, [fetchPost]);

  useEffect(() => {
    api
      .get<{ blogs: BlogInfo[] }>('/api/blogs')
      .then((res) => setBlogs(res.data.blogs || []))
      .catch(() => setBlogs([]));
  }, []);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await api.put(`/api/posts/${id}`, { content, title });
      toast({ title: '저장되었습니다' });
    } catch (error) {
      toast({
        title: '저장 실패',
        description: (isAxiosError(error) && error.response?.data?.error) || undefined,
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!id || !platform) return;
    setPublishing(true);
    try {
      // 발행 전 자동 저장 — 에디터에서 수정한 내용이 반드시 발행물에 반영되도록 한다.
      await api.put(`/api/posts/${id}`, { content, title });
      await api.post(`/api/posts/${id}/publish`, { platform, aiPolish });
      toast({ title: '발행되었습니다' });
      navigate('/posts');
    } catch (error) {
      toast({
        title: '발행 실패',
        description: (isAxiosError(error) && error.response?.data?.error) || undefined,
        variant: 'destructive',
      });
      setPublishing(false);
    }
  };

  const handleAiEdit = async () => {
    const prompt = aiPrompt.trim();
    if (!id || !prompt || aiLoading) return;
    setAiLoading(true);
    try {
      // LLM 응답에 30-90초 걸리므로 5분 타임아웃으로 오버라이드
      const response = await api.post<{ content: string }>(
        `/api/posts/${id}/ai-edit`,
        { prompt },
        { timeout: 300000 },
      );
      // 에디터 본문을 응답 HTML로 교체(RichEditor가 외부 content 변경을 동기화)
      setAiHistory((prev) => [{ prompt, status: 'success' } as const, ...prev].slice(0, 2));
      setContent(response.data.content);
      setAiPrompt('');
      toast({ title: 'AI가 글을 수정했습니다. 저장을 눌러 확정하세요.' });
    } catch (error) {
      const message =
        (isAxiosError(error) && (error.response?.data?.error || error.message)) ||
        '요청 처리 중 오류가 발생했습니다';
      setAiHistory((prev) => [{ prompt, status: 'error', message } as const, ...prev].slice(0, 2));
      toast({ title: 'AI 수정 실패', description: message, variant: 'destructive' });
    } finally {
      setAiLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-muted-foreground">포스트를 찾을 수 없습니다.</p>
        <Button variant="outline" onClick={() => navigate('/posts')}>
          <ArrowLeft className="mr-2 h-4 w-4" />
          포스트 관리로 돌아가기
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate('/posts')} title="뒤로">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold">포스트 편집</h1>
            <p className="text-sm text-muted-foreground">{id}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            저장
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-medium">AI 편집</span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <textarea
              className="min-h-[80px] flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              rows={2}
              placeholder="예: 도입부를 더 간결하게 다듬어 줘"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleAiEdit();
                }
              }}
              disabled={aiLoading}
            />
            <Button onClick={handleAiEdit} disabled={aiLoading || !aiPrompt.trim()}>
              {aiLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Sparkles className="mr-2 h-4 w-4" />
              )}
              AI 수정
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Enter로 전송, Shift+Enter로 줄바꿈 · 서버에 저장된 본문을 기준으로 수정하며 저장되지
            않은 변경 사항은 반영되지 않습니다.
          </p>
          {aiHistory.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {aiHistory.map((h, i) => (
                <li key={i} className="flex items-start gap-1.5">
                  {h.status === 'success' ? (
                    <Check className="mt-0.5 h-3 w-3 text-green-600" />
                  ) : (
                    <X className="mt-0.5 h-3 w-3 text-destructive" />
                  )}
                  <span className="truncate">
                    {h.prompt}
                    {h.status === 'error' ? ` — 실패: ${h.message}` : ' — 완료'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div>
            <label className="mb-1 block text-sm font-medium">제목</label>
            <Input
              placeholder="포스트 제목"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">본문</label>
            <RichEditor mode="post" content={content} onUpdate={setContent} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium">발행 플랫폼</label>
            {blogs.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                연동된 블로그가 없습니다. 블로그 관리에서 플랫폼을 먼저 연동해 주세요.
              </p>
            ) : (
              <Select value={platform} onChange={(e) => setPlatform(e.target.value)}>
                <option value="">플랫폼 선택</option>
                {blogs.map((blog) => (
                  <option key={blog.name} value={blog.platform || blog.name}>
                    {blog.name}
                    {blog.connected ? '' : ' (미연동)'}
                  </option>
                ))}
              </Select>
            )}
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-primary"
                checked={aiPolish}
                onChange={(e) => setAiPolish(e.target.checked)}
              />
              AI 최종 다듬기 후 발행
              <span className="text-xs text-muted-foreground">
                (발행 시점에 문장을 다듬고 쿠팡 링크를 미리보기 카드로 만듭니다)
              </span>
            </label>
          </div>
          <Button onClick={handlePublish} disabled={!platform || publishing}>
            {publishing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Rocket className="mr-2 h-4 w-4" />
            )}
            발행
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
