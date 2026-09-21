import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../services/api';
import { CoupangStatus } from '@shared/types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Input } from './ui/Input';
import { Label } from './ui/Label';
import { Select } from './ui/Select';
import {
  CheckCircle,
  DollarSign,
  ExternalLink,
  MousePointer,
  RefreshCw,
  ShoppingBag,
  TrendingUp,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ko } from 'date-fns/locale';
import { isAxiosError } from 'axios';
import { clsx } from 'clsx';

/** 파트너스 링크 생성 페이지 — 링크 생성은 사람이 한다(설계 §3-1-1). 소재 요청 카드에서 새 탭으로 연다. */
const PARTNERS_LINK_PAGE = 'https://partners.coupang.com/#affiliate/ws/link';

/** 광고 소재 — GET /api/ads/inventory 응답 계약(설계 §2-1 ad_inventory). */
interface AdItem {
  id: string;
  source: 'manual' | 'api';
  kind: string;
  productName: string;
  url: string;
  imageUrl?: string;
  keywords: string[];
  categoryId?: string;
  requestId?: string;
  status: 'active' | 'dead' | 'expired' | 'removed';
  lastCheckedAt?: string;
  lastCheckResult?: { status: number; location?: string; ok: boolean; checkedAt: string };
  usedCount: number;
  lastUsedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 소재 요청 — GET /api/ads/requests 응답 계약(설계 §2-1 ad_requests). */
interface AdRequest {
  id: string;
  robotRunId?: string | null;
  keyword: string;
  categoryId?: string | null;
  needed: number;
  criteria: string[];
  dueAt: string;
  status: 'open' | 'fulfilled' | 'expired' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

/** 쇼핑 카테고리 트리 노드 — GET /api/keywords/shopping-categories 응답 계약. */
interface ShoppingCategoryNode {
  catId: string;
  name: string;
  children?: ShoppingCategoryNode[];
}

interface FlatCategory {
  catId: string;
  label: string;
}

/** 인라인 피드백 — alert()/window.confirm 대신 화면에 남긴다. */
interface RowFeedback {
  text: string;
  tone: 'ok' | 'warn' | 'error';
}

const FEEDBACK_CLASS: Record<RowFeedback['tone'], string> = {
  ok: 'text-green-600',
  warn: 'text-orange-600',
  error: 'text-destructive',
};

/** 상태 배지 — active/dead/expired/removed 를 서로 다른 variant 로 구분한다. */
const AD_STATUS_META: Record<
  AdItem['status'],
  {
    label: string;
    variant: 'default' | 'secondary' | 'destructive' | 'outline';
    className?: string;
  }
> = {
  active: { label: '활성', variant: 'default', className: 'bg-green-100 text-green-700' },
  dead: { label: '링크 이상', variant: 'destructive' },
  expired: { label: '만료', variant: 'secondary' },
  removed: { label: '삭제됨', variant: 'outline' },
};

const LINK_BUTTON_CLASS =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm font-medium hover:bg-accent hover:text-accent-foreground';

/** 트리 → <option> 평탄화(깊이만큼 전각 공백 들여쓰기). */
function flattenCategories(
  nodes: ShoppingCategoryNode[],
  depth = 0,
  out: FlatCategory[] = [],
): FlatCategory[] {
  for (const node of nodes) {
    out.push({ catId: node.catId, label: `${'　'.repeat(depth)}${node.name}` });
    if (node.children?.length) flattenCategories(node.children, depth + 1, out);
  }
  return out;
}

/** 붙여넣기/입력 문자열 → 키워드 배열(쉼표·공백 구분, 중복 제거). */
function parseKeywords(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,\n]+|\s+/)
        .map((keyword) => keyword.trim())
        .filter(Boolean),
    ),
  );
}

/** 오류 문구 — 한국어 안내를 앞세우고 서버가 준 상세(400 {error})를 괄호로 덧붙인다. */
function errorMessage(error: unknown, fallback: string): string {
  const detail = isAxiosError<{ error?: string }>(error) ? error.response?.data?.error : '';
  return detail ? `${fallback} (${detail})` : fallback;
}

/** ISO 문자열 → 한국어 상대 시각("3일 전"). 값이 없거나 잘못되면 '-'. */
function relativeTime(iso?: string | null): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return formatDistanceToNow(date, { addSuffix: true, locale: ko });
}

function absoluteTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function Coupang() {
  const [, setStatus] = useState<CoupangStatus | null>(null);
  const [loading, setLoading] = useState(true);

  // 광고 소재 관리
  const [ads, setAds] = useState<AdItem[]>([]);
  const [adsError, setAdsError] = useState('');
  const [categories, setCategories] = useState<FlatCategory[]>([]);
  const [paste, setPaste] = useState('');
  const [pasteKeywords, setPasteKeywords] = useState('');
  const [pasteCategory, setPasteCategory] = useState('');
  const [registering, setRegistering] = useState(false);
  const [registerFeedback, setRegisterFeedback] = useState<RowFeedback | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});
  const [rowFeedback, setRowFeedback] = useState<Record<string, RowFeedback>>({});
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [keywordDrafts, setKeywordDrafts] = useState<Record<string, string>>({});

  // 소재 요청
  const [requests, setRequests] = useState<AdRequest[]>([]);
  const [inventoryCounts, setInventoryCounts] = useState<Record<string, number>>({});
  const [requestsError, setRequestsError] = useState('');
  const [requestPastes, setRequestPastes] = useState<Record<string, string[]>>({});
  const [requestFieldErrors, setRequestFieldErrors] = useState<
    Record<string, Record<number, string>>
  >({});
  const [requestBusy, setRequestBusy] = useState<string | null>(null);
  const [requestFeedback, setRequestFeedback] = useState<Record<string, RowFeedback>>({});

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

  const fetchInventory = useCallback(async () => {
    try {
      const response = await api.get<{ items: AdItem[] }>('/api/ads/inventory');
      setAds(response.data.items ?? []);
      setAdsError('');
    } catch (error) {
      setAdsError(errorMessage(error, '광고 소재 목록을 불러오지 못했습니다.'));
    }
  }, []);

  const fetchRequests = useCallback(async () => {
    try {
      const response = await api.get<{
        requests: AdRequest[];
        inventoryCounts: Record<string, number>;
      }>('/api/ads/requests', { params: { status: 'open' } });
      setRequests(response.data.requests ?? []);
      setInventoryCounts(response.data.inventoryCounts ?? {});
      setRequestsError('');
    } catch (error) {
      setRequestsError(errorMessage(error, '소재 요청을 불러오지 못했습니다.'));
    }
  }, []);

  useEffect(() => {
    void fetchInventory();
    void fetchRequests();
  }, [fetchInventory, fetchRequests]);

  // 카테고리 코드표 로드 — 실패해도 "카테고리 없음"만 남기고 계속 동작한다.
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ categories?: ShoppingCategoryNode[] }>('/api/keywords/shopping-categories')
      .then((response) => {
        if (!cancelled) setCategories(flattenCategories(response.data?.categories ?? []));
      })
      .catch(() => {
        /* 코드표 없이도 등록·편집은 가능하므로 무시 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAll = () => {
    void fetchStatus();
    void fetchInventory();
    void fetchRequests();
  };

  const categoryNames = useMemo(
    () => new Map(categories.map((category) => [category.catId, category.label.trim()])),
    [categories],
  );
  const categoryCounts = useMemo(
    () => Object.entries(inventoryCounts).sort((a, b) => b[1] - a[1]),
    [inventoryCounts],
  );

  const handleRegister = async () => {
    if (!paste.trim()) {
      setRegisterFeedback({ text: '파트너스 링크 또는 상품 HTML을 붙여넣으세요.', tone: 'error' });
      return;
    }
    setRegistering(true);
    setRegisterFeedback(null);
    try {
      const response = await api.post<{ item: AdItem }>('/api/ads/inventory', {
        paste: paste.trim(),
        keywords: parseKeywords(pasteKeywords),
        categoryId: pasteCategory || undefined,
      });
      setPaste('');
      setPasteKeywords('');
      setPasteCategory('');
      setRegisterFeedback({ text: `등록했습니다: ${response.data.item.productName}`, tone: 'ok' });
      await Promise.all([fetchInventory(), fetchRequests()]);
    } catch (error) {
      setRegisterFeedback({
        text: errorMessage(error, '광고 소재 등록에 실패했습니다.'),
        tone: 'error',
      });
    } finally {
      setRegistering(false);
    }
  };

  const setRowFeedbackFor = (id: string, feedback: RowFeedback) => {
    setRowFeedback((prev) => ({ ...prev, [id]: feedback }));
  };

  const setBusy = (id: string, busy: boolean) => {
    setRowBusy((prev) => ({ ...prev, [id]: busy }));
  };

  const handleCheck = async (ad: AdItem) => {
    setBusy(ad.id, true);
    try {
      const response = await api.post<{
        ok: boolean;
        status: number | null;
        location: string | null;
        item: AdItem;
      }>(`/api/ads/inventory/${ad.id}/check`);
      const { ok, status, location, item } = response.data;
      setAds((prev) => prev.map((row) => (row.id === ad.id ? item : row)));
      setRowFeedbackFor(ad.id, {
        text: ok
          ? `링크 확인: 정상 (${status ?? '응답 없음'})`
          : `링크 확인: 이상 (${status ?? '응답 없음'})${location ? ` → ${location}` : ''}`,
        tone: ok ? 'ok' : 'error',
      });
      await fetchRequests();
    } catch (error) {
      setRowFeedbackFor(ad.id, {
        text: errorMessage(error, '링크 확인에 실패했습니다.'),
        tone: 'error',
      });
    } finally {
      setBusy(ad.id, false);
    }
  };

  const handleRemove = async (ad: AdItem) => {
    setBusy(ad.id, true);
    try {
      await api.delete(`/api/ads/inventory/${ad.id}`);
      setConfirmRemove(null);
      await Promise.all([fetchInventory(), fetchRequests()]);
    } catch (error) {
      setRowFeedbackFor(ad.id, {
        text: errorMessage(error, '삭제에 실패했습니다.'),
        tone: 'error',
      });
    } finally {
      setBusy(ad.id, false);
    }
  };

  const commitKeywords = async (ad: AdItem) => {
    const draft = keywordDrafts[ad.id];
    if (draft === undefined) return;
    setKeywordDrafts((prev) => {
      const rest = { ...prev };
      delete rest[ad.id];
      return rest;
    });
    const next = parseKeywords(draft);
    if (next.join(',') === ad.keywords.join(',')) return;
    setBusy(ad.id, true);
    try {
      const response = await api.patch<{ item: AdItem }>(`/api/ads/inventory/${ad.id}`, {
        keywords: next,
      });
      setAds((prev) => prev.map((row) => (row.id === ad.id ? response.data.item : row)));
      setRowFeedbackFor(ad.id, { text: '키워드를 저장했습니다.', tone: 'ok' });
      await fetchRequests();
    } catch (error) {
      setRowFeedbackFor(ad.id, {
        text: errorMessage(error, '키워드 저장에 실패했습니다.'),
        tone: 'error',
      });
    } finally {
      setBusy(ad.id, false);
    }
  };

  const handleCategoryChange = async (ad: AdItem, categoryId: string) => {
    setBusy(ad.id, true);
    try {
      const response = await api.patch<{ item: AdItem }>(`/api/ads/inventory/${ad.id}`, {
        categoryId,
      });
      setAds((prev) => prev.map((row) => (row.id === ad.id ? response.data.item : row)));
      setRowFeedbackFor(ad.id, { text: '카테고리를 저장했습니다.', tone: 'ok' });
      await fetchRequests();
    } catch (error) {
      setRowFeedbackFor(ad.id, {
        text: errorMessage(error, '카테고리 저장에 실패했습니다.'),
        tone: 'error',
      });
    } finally {
      setBusy(ad.id, false);
    }
  };

  const setRequestPaste = (request: AdRequest, index: number, value: string) => {
    setRequestPastes((prev) => {
      const current = prev[request.id] ?? Array.from({ length: request.needed }, () => '');
      const next = current.slice();
      next[index] = value;
      return { ...prev, [request.id]: next };
    });
  };

  const handleRequestRegister = async (request: AdRequest) => {
    const fields = requestPastes[request.id] ?? [];
    const filled = fields
      .map((value, index) => ({ index, value: value.trim() }))
      .filter((field) => field.value.length > 0);
    if (filled.length === 0) {
      setRequestFeedback((prev) => ({
        ...prev,
        [request.id]: { text: '붙여넣은 링크가 없습니다.', tone: 'error' },
      }));
      return;
    }
    setRequestBusy(request.id);
    const fieldErrors: Record<number, string> = {};
    let registered = 0;
    for (const field of filled) {
      try {
        await api.post('/api/ads/inventory', {
          paste: field.value,
          keywords: [request.keyword],
          categoryId: request.categoryId ?? undefined,
          requestId: request.id,
        });
        registered += 1;
      } catch (error) {
        fieldErrors[field.index] = errorMessage(error, '등록에 실패했습니다.');
      }
    }
    setRequestFieldErrors((prev) => ({ ...prev, [request.id]: fieldErrors }));
    setRequestFeedback((prev) => ({
      ...prev,
      [request.id]: {
        text:
          registered === filled.length
            ? `${registered}건을 등록했습니다.`
            : `${filled.length}건 중 ${registered}건을 등록했습니다.`,
        tone: registered === filled.length ? 'ok' : 'warn',
      },
    }));
    const succeeded = new Set(
      filled.filter((field) => !fieldErrors[field.index]).map((field) => field.index),
    );
    setRequestPastes((prev) => ({
      ...prev,
      [request.id]: (prev[request.id] ?? []).map((value, index) =>
        succeeded.has(index) ? '' : value,
      ),
    }));
    await Promise.all([fetchInventory(), fetchRequests()]);
    setRequestBusy(null);
  };

  const handleCancelRequest = async (request: AdRequest) => {
    setRequestBusy(request.id);
    try {
      await api.post(`/api/ads/requests/${request.id}/cancel`);
      await fetchRequests();
    } catch (error) {
      setRequestFeedback((prev) => ({
        ...prev,
        [request.id]: { text: errorMessage(error, '요청 취소에 실패했습니다.'), tone: 'error' },
      }));
    } finally {
      setRequestBusy(null);
    }
  };

  const statCards = [
    {
      title: '총 수익',
      value: '₩0',
      icon: <DollarSign className="h-6 w-6 text-green-600" />,
      color: 'bg-green-100',
    },
    {
      title: '클릭 수',
      value: '0',
      icon: <MousePointer className="h-6 w-6 text-blue-600" />,
      color: 'bg-blue-100',
    },
    {
      title: '전환 수',
      value: '0',
      icon: <TrendingUp className="h-6 w-6 text-purple-600" />,
      color: 'bg-purple-100',
    },
    {
      title: '승인율',
      value: '0%',
      icon: <CheckCircle className="h-6 w-6 text-orange-600" />,
      color: 'bg-orange-100',
    },
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
        <Button variant="outline" onClick={refreshAll} disabled={loading}>
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

      <Card>
        <CardHeader>
          <CardTitle>광고 소재 관리</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-lg border p-3">
            <div className="space-y-1">
              <Label htmlFor="ad-paste">파트너스 링크 또는 상품 HTML 붙여넣기</Label>
              <textarea
                id="ad-paste"
                rows={3}
                className="min-h-[80px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                placeholder='<a href="https://link.coupang.com/a/XXXX"><img src="…" alt="상품명"></a> 또는 https://link.coupang.com/a/XXXX'
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                상품명·이미지·링크는 붙여넣은 값에서 자동으로 추출합니다.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="ad-keywords">키워드</Label>
                <Input
                  id="ad-keywords"
                  placeholder="쉼표 또는 공백으로 구분"
                  value={pasteKeywords}
                  onChange={(event) => setPasteKeywords(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ad-category">카테고리</Label>
                <Select
                  id="ad-category"
                  value={pasteCategory}
                  onChange={(event) => setPasteCategory(event.target.value)}
                >
                  <option value="">카테고리 없음</option>
                  {categories.map((category) => (
                    <option key={category.catId} value={category.catId}>
                      {category.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void handleRegister()} disabled={registering}>
                {registering ? '등록 중…' : '등록'}
              </Button>
              {registerFeedback && (
                <span className={clsx('text-sm', FEEDBACK_CLASS[registerFeedback.tone])}>
                  {registerFeedback.text}
                </span>
              )}
            </div>
          </div>

          {adsError && <p className="text-sm text-destructive">{adsError}</p>}
          {!adsError && ads.length === 0 && (
            <p className="text-sm text-muted-foreground">
              등록된 광고 소재가 없습니다. 위 칸에 파트너스 링크를 붙여넣어 등록하세요.
            </p>
          )}
          {!adsError && ads.length > 0 && (
            <div className="space-y-2">
              {ads.map((ad) => {
                const meta = AD_STATUS_META[ad.status];
                const feedback = rowFeedback[ad.id];
                const busy = Boolean(rowBusy[ad.id]);
                return (
                  <div key={ad.id} className="space-y-2 rounded-lg border p-3">
                    <div className="flex items-start gap-3">
                      {ad.imageUrl && (
                        <img
                          src={ad.imageUrl}
                          alt=""
                          loading="lazy"
                          className="h-12 w-12 shrink-0 rounded object-cover"
                          onError={(event) => {
                            event.currentTarget.style.display = 'none';
                          }}
                        />
                      )}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium">{ad.productName}</span>
                          <Badge variant={meta.variant} className={meta.className}>
                            {meta.label}
                          </Badge>
                          {ad.keywords.map((keyword) => (
                            <Badge key={keyword} variant="outline">
                              {keyword}
                            </Badge>
                          ))}
                        </div>
                        <a
                          href={ad.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block truncate text-xs text-primary underline"
                        >
                          {ad.url}
                        </a>
                        <p className="text-xs text-muted-foreground">
                          {ad.categoryId
                            ? (categoryNames.get(ad.categoryId) ?? ad.categoryId)
                            : '카테고리 없음'}{' '}
                          • 사용 {ad.usedCount}회 • 확인 {relativeTime(ad.lastCheckedAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void handleCheck(ad)}
                          disabled={busy}
                        >
                          링크 확인
                        </Button>
                        {confirmRemove === ad.id ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => void handleRemove(ad)}
                              disabled={busy}
                            >
                              삭제 확인
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => setConfirmRemove(null)}
                              disabled={busy}
                            >
                              취소
                            </Button>
                          </>
                        ) : (
                          <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(ad.id)}>
                            삭제
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-2 md:grid-cols-2">
                      <div className="space-y-1">
                        <Label htmlFor={`ad-keywords-${ad.id}`}>키워드 편집</Label>
                        <Input
                          id={`ad-keywords-${ad.id}`}
                          value={keywordDrafts[ad.id] ?? ad.keywords.join(', ')}
                          onChange={(event) =>
                            setKeywordDrafts((prev) => ({ ...prev, [ad.id]: event.target.value }))
                          }
                          onBlur={() => void commitKeywords(ad)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              void commitKeywords(ad);
                            }
                          }}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`ad-category-${ad.id}`}>카테고리 편집</Label>
                        <Select
                          id={`ad-category-${ad.id}`}
                          value={ad.categoryId ?? ''}
                          onChange={(event) => void handleCategoryChange(ad, event.target.value)}
                          disabled={busy}
                        >
                          <option value="">카테고리 없음</option>
                          {categories.map((category) => (
                            <option key={category.catId} value={category.catId}>
                              {category.label}
                            </option>
                          ))}
                          {ad.categoryId && !categoryNames.has(ad.categoryId) && (
                            <option value={ad.categoryId}>{ad.categoryId}(코드표 없음)</option>
                          )}
                        </Select>
                      </div>
                    </div>
                    {feedback && (
                      <p className={clsx('text-xs', FEEDBACK_CLASS[feedback.tone])}>
                        {feedback.text}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>소재 요청</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {categoryCounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>카테고리별 소재</span>
              {categoryCounts.map(([catId, count]) => (
                <span key={catId || 'none'} className="rounded border px-2 py-0.5">
                  {catId ? (categoryNames.get(catId) ?? catId) : '카테고리 없음'} {count}개
                </span>
              ))}
            </div>
          )}
          {requestsError && <p className="text-sm text-destructive">{requestsError}</p>}
          {!requestsError && requests.length === 0 && (
            <p className="text-sm text-muted-foreground">처리할 소재 요청이 없습니다.</p>
          )}
          {!requestsError &&
            requests.map((request) => {
              const dueDate = new Date(request.dueAt);
              const overdue = !Number.isNaN(dueDate.getTime()) && dueDate.getTime() < Date.now();
              const categoryId = request.categoryId ?? '';
              const registered = inventoryCounts[categoryId] ?? 0;
              const shortage = registered < request.needed;
              const fields =
                requestPastes[request.id] ?? Array.from({ length: request.needed }, () => '');
              const fieldErrors = requestFieldErrors[request.id] ?? {};
              const feedback = requestFeedback[request.id];
              const busy = requestBusy === request.id;
              return (
                <div
                  key={request.id}
                  className={clsx(
                    'space-y-3 rounded-lg border p-3',
                    overdue && 'border-destructive',
                  )}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold">{request.keyword}</span>
                        <Badge variant="outline">
                          {categoryId
                            ? (categoryNames.get(categoryId) ?? categoryId)
                            : '카테고리 없음'}
                        </Badge>
                        <Badge variant="secondary">필요 {request.needed}개</Badge>
                        {shortage ? (
                          <Badge className="bg-red-100 text-red-700">
                            소재 부족 ({registered}개)
                          </Badge>
                        ) : (
                          <Badge className="bg-green-100 text-green-700">소재 {registered}개</Badge>
                        )}
                        {overdue && <Badge variant="destructive">기한 지남</Badge>}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        발행 예정 {absoluteTime(request.dueAt)} ({relativeTime(request.dueAt)})
                      </p>
                    </div>
                    <a
                      href={PARTNERS_LINK_PAGE}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={LINK_BUTTON_CLASS}
                    >
                      <ExternalLink className="h-4 w-4" />
                      파트너스 링크 생성 페이지
                    </a>
                  </div>

                  {request.criteria.length > 0 && (
                    <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
                      {request.criteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  )}

                  <div className="space-y-2">
                    <Label>링크 붙여넣기 ({request.needed}개)</Label>
                    {fields.map((value, index) => (
                      <div key={index} className="space-y-1">
                        <Input
                          aria-label={`${request.keyword} 소재 ${index + 1}`}
                          placeholder="파트너스 링크 또는 상품 HTML"
                          value={value}
                          onChange={(event) => setRequestPaste(request, index, event.target.value)}
                          disabled={busy}
                        />
                        {fieldErrors[index] && (
                          <p className="text-xs text-destructive">{fieldErrors[index]}</p>
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Button onClick={() => void handleRequestRegister(request)} disabled={busy}>
                      등록
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void handleCancelRequest(request)}
                      disabled={busy}
                    >
                      요청 취소
                    </Button>
                    {feedback && (
                      <span className={clsx('text-sm', FEEDBACK_CLASS[feedback.tone])}>
                        {feedback.text}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
        </CardContent>
      </Card>

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
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(Date.now() - (6 - i) * 86400000), {
                      addSuffix: true,
                    })}
                  </span>
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
                    <p className="text-xs text-muted-foreground">
                      카테고리 • ₩{Math.floor(Math.random() * 100000 + 10000).toLocaleString()}
                    </p>
                  </div>
                  <span className="text-sm font-medium text-primary">
                    ₩{Math.floor(Math.random() * 50000 + 1000).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
