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
import { ArrowLeft, Loader2, Rocket, Save } from 'lucide-react';

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
  const [blogs, setBlogs] = useState<BlogInfo[]>([]);

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
      await api.post(`/api/posts/${id}/publish`, { platform });
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
