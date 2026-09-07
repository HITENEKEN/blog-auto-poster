import { useCallback, useEffect, useState } from 'react';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { Card, CardContent, CardHeader, CardTitle } from '../pages/ui/Card';
import { Button } from '../pages/ui/Button';
import { Input } from '../pages/ui/Input';
import { Label } from '../pages/ui/Label';
import { Loader2, Plus, Trash2 } from 'lucide-react';

/** 쿠팡 위젯 종류(서버 COUPANG_WIDGET_KINDS와 동일 목록) */
const KINDS = [
  { value: 'product-link', label: '상품 링크' },
  { value: 'event-link', label: '이벤트/프로모션 링크' },
  { value: 'dynamic-banner', label: '다이나믹 배너 (스니펫)' },
  { value: 'search-widget', label: '검색 위젯 (스니펫)' },
  { value: 'category-banner', label: '카테고리 배너 (스니펫)' },
  { value: 'ad-banner', label: '광고 배너 (이미지+링크)' },
] as const;

const LINK_KINDS = ['product-link', 'event-link'];
const SNIPPET_KINDS = ['dynamic-banner', 'search-widget', 'category-banner'];

interface Preset {
  id: string;
  label: string;
  kind: string;
  props: { url?: string; text?: string; imageUrl?: string; snippet?: string };
  createdAt: string;
}

/**
 * 링크/배너 프리셋 관리(이슈 #18). 사용자가 직접 등록한 링크/배너만
 * 발행 시 본문에 자동 배치된다 — AI는 임의 링크를 생성하지 않는다.
 */
export default function LinkPresetsManager() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<string>('product-link');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [snippet, setSnippet] = useState('');

  const fetchPresets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ presets: Preset[] }>('/api/link-presets');
      setPresets(res.data.presets ?? []);
    } catch {
      setError('프리셋을 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPresets();
  }, [fetchPresets]);

  const handleAdd = async () => {
    setSaving(true);
    setError('');
    try {
      const props: Preset['props'] = {};
      if (LINK_KINDS.includes(kind) || kind === 'ad-banner') props.url = url.trim();
      if (LINK_KINDS.includes(kind)) props.text = text.trim();
      if (kind === 'ad-banner') props.imageUrl = imageUrl.trim();
      if (SNIPPET_KINDS.includes(kind)) props.snippet = snippet;
      await api.post('/api/link-presets', { label, kind, props });
      setLabel('');
      setUrl('');
      setText('');
      setImageUrl('');
      setSnippet('');
      await fetchPresets();
    } catch (e) {
      setError((isAxiosError(e) && e.response?.data?.error) || '프리셋 추가에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.delete(`/api/link-presets/${id}`);
      await fetchPresets();
    } catch {
      setError('프리셋 삭제에 실패했습니다.');
    }
  };

  const isLinkKind = LINK_KINDS.includes(kind);
  const isSnippetKind = SNIPPET_KINDS.includes(kind);

  return (
    <Card>
      <CardHeader>
        <CardTitle>링크/배너 프리셋</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          여기에 등록한 링크/배너는 발행 시 본문 위젯이 없을 때만 섹션 경계에 자동 배치됩니다. 편집
          화면에서 직접 삽입한 위젯이 우선하며, AI가 임의의 링크를 생성하지 않습니다.
        </p>

        <div className="space-y-3 rounded-md border p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1">
              <Label>관리용 이름</Label>
              <Input
                placeholder="예: 메인 상품 링크"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>종류</Label>
              <select
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm"
                value={kind}
                onChange={(e) => setKind(e.target.value)}
              >
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(isLinkKind || kind === 'ad-banner') && (
            <div className="space-y-1">
              <Label>링크 URL</Label>
              <Input
                placeholder="https://link.coupang.com/a/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
          )}
          {isLinkKind && (
            <div className="space-y-1">
              <Label>표시 텍스트 (비우면 기본 라벨 사용)</Label>
              <Input value={text} onChange={(e) => setText(e.target.value)} />
            </div>
          )}
          {kind === 'ad-banner' && (
            <div className="space-y-1">
              <Label>배너 이미지 URL</Label>
              <Input
                placeholder="https://image.example.com/banner.jpg"
                value={imageUrl}
                onChange={(e) => setImageUrl(e.target.value)}
              />
            </div>
          )}
          {isSnippetKind && (
            <div className="space-y-1">
              <Label>위젯 스니펫 (파트너스 제공 script/iframe HTML)</Label>
              <textarea
                className="min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={snippet}
                onChange={(e) => setSnippet(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button onClick={handleAdd} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Plus className="mr-2 h-4 w-4" />
            )}
            프리셋 추가
          </Button>
        </div>

        {loading ? (
          <div className="flex h-24 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : presets.length === 0 ? (
          <p className="text-sm text-muted-foreground">등록된 프리셋이 없습니다.</p>
        ) : (
          <ul className="space-y-2">
            {presets.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between rounded-md border p-3 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium">{p.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {KINDS.find((k) => k.value === p.kind)?.label ?? p.kind}
                    {p.props.url ? ` · ${p.props.url}` : ''}
                  </p>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleDelete(p.id)}>
                  <Trash2 className="h-4 w-4 text-destructive" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
