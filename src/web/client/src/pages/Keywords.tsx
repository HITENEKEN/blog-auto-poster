import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAxiosError } from 'axios';
import { api } from '../services/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import ShoppingInsightPanel, { type KeywordClickContext } from './ShoppingInsightPanel';
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
  FilePlus2,
} from 'lucide-react';
import { Dialog } from './ui/dialog';
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from 'recharts';

interface KeywordResult {
  keyword: string;
  volume: number;
  competition: number;
  trend: 'rising' | 'falling' | 'stable';
  related: string[];
  source: string;
  /** 쇼핑인사이트 분야 소속 클릭 비중(0-100 상대값) — 분야 지정 조회 시에만 존재. */
  shoppingRatio?: number;
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

type GroupShares = Record<string, number>;

/** Naver 쇼핑 카테고리 트리 노드 — GET /api/keywords/shopping-categories 응답 계약(서버 정적 JSON 기반).
 *  2026-08 코드표부터 1~3분류 재귀 트리(대분류 → 2분류 → 3분류)다. */
interface ShoppingCategoryNode {
  catId: string;
  name: string;
  children?: ShoppingCategoryNode[];
}

/** "직접 입력…" 옵션 값 — 선택 시 자유입력 Input을 병존 노출(미등록 코드 폴백). */
const CUSTOM_CATEGORY = '__custom__';

const CHART_COLORS = ['#3b82f6', '#f97316', '#22c55e', '#eab308', '#a855f7', '#ec4899'];

/** 분야별 breakdown group 코드 라벨 (device/gender/ages). */
const GROUP_LABELS: Record<string, string> = {
  mo: '모바일',
  pc: 'PC',
  m: '남자',
  f: '여자',
  '10': '10대',
  '20': '20대',
  '30': '30대',
  '40': '40대',
  '50': '50대',
  '60': '60대 이상',
};

// ── 기간 select 헬퍼 ──
// TrendAnalysis.ts의 서버 헬퍼와 동일 계약의 로컬 복제(AGE_OPTIONS 선례) — 클라이언트에는 별칭 임포트 경로가 없다.

const currentYear = new Date().getFullYear();
const YEAR_OPTIONS = Array.from({ length: 5 }, (_, i) => currentYear - 4 + i);

function parseDateParts(s: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function toDateString(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

function validateDateRange(start: string, end: string): boolean {
  const a = parseDateParts(start);
  const b = parseDateParts(end);
  if (!a || !b) return false;
  return toDateString(a.y, a.m, a.d) <= toDateString(b.y, b.m, b.d);
}

/** 시리즈 그룹별 ratio 합산 → 전체 합 대비 %. 그룹 키는 포인트의 group 필드(단일 시리즈) 또는 시리즈 title(그룹별 복수 시리즈)로 판별. */
function computeGroupShares(series: TrendQueryResponse['series']): GroupShares {
  const sums: GroupShares = {};
  for (const s of series) {
    if (s.data.length === 0) continue;
    const titleKey = s.data.some((p) => p.group != null) ? null : s.title;
    for (const p of s.data) {
      const key = p.group ?? titleKey;
      if (!key) continue;
      sums[key] = (sums[key] ?? 0) + (p.ratio ?? 0);
    }
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  if (total <= 0) return {};
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, (v / total) * 100]));
}

/** 년/월/일 select 3개 — startDate/endDate 문자열(단일 진실원)의 파생 편집. 월/년 변경 시 말일 clamp(윤년 포함). */
function DateSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (date: string) => void;
}) {
  const p = parseDateParts(value) ?? { y: currentYear, m: 1, d: 1 };
  const maxDay = daysInMonth(p.y, p.m);
  const day = Math.min(p.d, maxDay);
  const apply = (y: number, m: number, d: number) => {
    onChange(toDateString(y, m, Math.min(d, daysInMonth(y, m))));
  };
  return (
    <span className="flex items-center gap-1">
      <select
        aria-label={`${label} 연도`}
        className="h-10 w-16 rounded-md border border-input bg-background px-1 text-sm"
        value={p.y}
        onChange={(e) => apply(Number(e.target.value), p.m, day)}
      >
        {YEAR_OPTIONS.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} 월`}
        className="h-10 w-14 rounded-md border border-input bg-background px-1 text-sm"
        value={p.m}
        onChange={(e) => apply(p.y, Number(e.target.value), day)}
      >
        {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
          <option key={m} value={m}>
            {m}월
          </option>
        ))}
      </select>
      <select
        aria-label={`${label} 일`}
        className="h-10 w-14 rounded-md border border-input bg-background px-1 text-sm"
        value={day}
        onChange={(e) => apply(p.y, p.m, Number(e.target.value))}
      >
        {Array.from({ length: maxDay }, (_, i) => i + 1).map((d) => (
          <option key={d} value={d}>
            {d}일
          </option>
        ))}
      </select>
    </span>
  );
}

/** 분야 비중 도넛 (recharts PieChart). shares: group 코드 → 전체 대비 %. */
function GroupDonut({ title, shares }: { title: string; shares: GroupShares }) {
  const entries = Object.entries(shares)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="min-w-0">
      <p className="mb-2 text-sm font-medium">{title}</p>
      {entries.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">데이터 없음</p>
      ) : (
        <div className="w-full" style={{ height: 190 }}>
          <ResponsiveContainer>
            <PieChart>
              <Pie
                data={entries.map(([group, value]) => ({
                  name: GROUP_LABELS[group] ?? group,
                  value: Math.round(value * 10) / 10,
                }))}
                dataKey="value"
                nameKey="name"
                innerRadius="52%"
                outerRadius="82%"
                paddingAngle={2}
              >
                {entries.map((entry, i) => (
                  <Cell key={entry[0]} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip formatter={(value) => `${value}%`} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

type ShoppingCriteria =
  | 'category'
  | 'keyword'
  | 'device'
  | 'gender'
  | 'ages'
  | 'keywords'
  | 'keywords-keyword'
  | 'keywords-device'
  | 'keywords-gender'
  | 'keywords-ages';

interface TrendQueryPoint {
  period: string;
  ratio: number;
  group?: string;
}

/** POST /api/keywords/trend response (or `{ error }` on failure). */
interface TrendQueryResponse {
  source: 'search-trend' | 'shopping-insight';
  series: Array<{ title: string; trend?: string; data: TrendQueryPoint[] }>;
  request: {
    startDate: string;
    endDate: string;
    timeUnit: string;
    device?: string;
    gender?: string;
    ages?: string[];
    criteria?: string;
    category?: string;
  };
  searchedAt: string;
  error?: string;
  /** 분야 유효성 — 쇼핑인사이트 조회에서 분야에 데이터가 없으면 false(미판정 시 생략). */
  categoryValid?: boolean;
}

/** Naver DataLab age codes. */
const AGE_OPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '1', label: '0-12세' },
  { code: '2', label: '13-18세' },
  { code: '3', label: '19-24세' },
  { code: '4', label: '25-29세' },
  { code: '5', label: '30-34세' },
  { code: '6', label: '35-39세' },
  { code: '7', label: '40-44세' },
  { code: '8', label: '45-49세' },
  { code: '9', label: '50-54세' },
  { code: '10', label: '55-59세' },
  { code: '11', label: '60세이상' },
];

const CRITERIA_OPTIONS: ReadonlyArray<{ value: ShoppingCriteria; label: string }> = [
  { value: 'category', label: '분야별' },
  { value: 'device', label: '기기별' },
  { value: 'gender', label: '성별' },
  { value: 'ages', label: '연령별' },
  { value: 'keywords', label: '키워드별' },
  { value: 'keywords-device', label: '키워드 기기별' },
  { value: 'keywords-gender', label: '키워드 성별' },
  { value: 'keywords-ages', label: '키워드 연령별' },
];

/** query 필수 criteria — 서버 KEYWORD_LEVEL_CRITERIA(routes/index.ts:55-61)와 동기. 분야-level('category'|'gender'|'ages'|'device')은 query 불요. */
const KEYWORD_LEVEL_CRITERIA: ReadonlyArray<ShoppingCriteria> = [
  'keyword',
  'keywords',
  'keywords-keyword',
  'keywords-device',
  'keywords-gender',
  'keywords-ages',
];

const TIME_UNIT_LABELS: Record<string, string> = { date: '일간', week: '주간', month: '월간' };

function resolvePresetRange(
  preset: 'today' | 'yesterday' | 'last-7d' | 'last-30d',
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DAY_MS = 24 * 60 * 60 * 1000;
  switch (preset) {
    case 'today': {
      const today = fmt(now);
      return { startDate: today, endDate: today };
    }
    case 'yesterday': {
      const yesterday = fmt(new Date(now.getTime() - DAY_MS));
      return { startDate: yesterday, endDate: yesterday };
    }
    case 'last-7d':
      return { startDate: fmt(new Date(now.getTime() - 6 * DAY_MS)), endDate: fmt(now) };
    case 'last-30d':
      return { startDate: fmt(new Date(now.getTime() - 29 * DAY_MS)), endDate: fmt(now) };
  }
}

export default function Keywords() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<TrendingResponse | null>(null);
  const [error, setError] = useState('');

  // 조건 조회 (Naver DataLab) 상태
  const [source, setSource] = useState<'search-trend' | 'shopping-insight'>('shopping-insight');
  const [startDate, setStartDate] = useState(() => resolvePresetRange('last-30d').startDate);
  const [endDate, setEndDate] = useState(() => resolvePresetRange('last-30d').endDate);
  const [timeUnit, setTimeUnit] = useState<'date' | 'week' | 'month'>('week');
  const [device, setDevice] = useState<'' | 'pc' | 'mo'>('');
  const [gender, setGender] = useState<'' | 'm' | 'f'>('');
  const [ages, setAges] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<ShoppingCriteria>('keywords');
  const [categoryCode, setCategoryCode] = useState('');
  const [trendResult, setTrendResult] = useState<TrendQueryResponse | null>(null);
  const [trendLoading, setTrendLoading] = useState(false);
  const [categoryChoice, setCategoryChoice] = useState('');
  const [pieShares, setPieShares] = useState<{
    device: GroupShares;
    gender: GroupShares;
    ages: GroupShares;
  }>({ device: {}, gender: {}, ages: {} });
  const [pieLoading, setPieLoading] = useState(false);
  const [pieError, setPieError] = useState('');
  // 카테고리 코드표 — 마운트 시 서버 fetch(1~4분류 실측 트리, 0.6MB라 번들에
  // 포함하지 않고 API로만 제공). fetch 실패 시 빈 상태로 재시도 가능.
  const [categories, setCategories] = useState<ReadonlyArray<ShoppingCategoryNode>>([]);
  /** 소분류 select 값 — '' = 전체(대분류), cat_id = 2분류 직접 선택. */
  const [subCategoryChoice, setSubCategoryChoice] = useState('');
  /** 3분류 select 값 — '' = 전체(2분류), cat_id = 3분류 직접 선택. */
  const [sub2CategoryChoice, setSub2CategoryChoice] = useState('');
  /** 4분류 select 값 — '' = 전체(3분류), cat_id = 4분류 직접 선택. */
  const [sub3CategoryChoice, setSub3CategoryChoice] = useState('');

  const selectedParent = categories.find((c) => c.catId === categoryChoice) ?? null;
  const subOptions = selectedParent?.children ?? [];
  const selectedSub = subOptions.find((c) => c.catId === subCategoryChoice) ?? null;
  const sub2Options = selectedSub?.children ?? [];
  const selectedSub2 = sub2Options.find((c) => c.catId === sub2CategoryChoice) ?? null;
  const sub3Options = selectedSub2?.children ?? [];

  // 새 포스트 작성 다이얼로그 상태
  const [postDialogKeyword, setPostDialogKeyword] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ name: string; filename: string }[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');

  const openPostDialog = async (keyword: string) => {
    setPostDialogKeyword(keyword);
    setSelectedTemplate('');
    setGenerateError('');
    try {
      const response = await api.get('/api/templates');
      const list = (response.data.templates || []) as { name: string; filename: string }[];
      setTemplates(list);
      setSelectedTemplate(list[0]?.name ?? '');
    } catch {
      setTemplates([]);
    }
  };

  const handleGeneratePost = async () => {
    if (!postDialogKeyword || !selectedTemplate) return;
    setGenerating(true);
    setGenerateError('');
    try {
      // 즉시 응답(드래프트 생성 확인)만 소비 — 실제 생성은 백그라운드에서 진행되며 결과는 포스트 관리 화면에서 폴링으로 확인.
      await api.post<{ post: { id: string } }>('/api/posts/generate-from-keyword', {
        keyword: postDialogKeyword,
        template: selectedTemplate,
      });
      setPostDialogKeyword(null);
      navigate('/posts');
    } catch (err) {
      setGenerateError(
        (isAxiosError<{ error?: string }>(err) && err.response?.data?.error) ||
          '포스트 생성에 실패했습니다.',
      );
    } finally {
      setGenerating(false);
    }
  };

  // 서버 카테고리 코드표(대분류/소분류 트리) 로드 — 실패 시 폴백 코드표 유지
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.get<{ categories?: ShoppingCategoryNode[] }>(
          '/api/keywords/shopping-categories',
        );
        const cats = response.data?.categories;
        if (!cancelled && Array.isArray(cats) && cats.length > 0) setCategories(cats);
      } catch {
        // 폴백(정적 3개 대분류) 유지
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 마운트 시점에 분야가 이미 지정된 경우에만 비중 조회(실제 트리거는 조건 조회)
  useEffect(() => {
    if (categoryCode) void fetchPieData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const handleTrendSearch = async () => {
    const needsQuery = source === 'search-trend' || KEYWORD_LEVEL_CRITERIA.includes(criteria);
    if (needsQuery && !query.trim()) {
      setError('검색어를 입력하세요.');
      return;
    }
    if (source === 'shopping-insight' && !categoryCode.trim()) {
      setError('분야를 선택하세요.');
      return;
    }
    setTrendLoading(true);
    setError('');
    if (source === 'shopping-insight') void fetchPieData();
    try {
      const body: Record<string, unknown> = {
        source,
        query: query.trim(),
        startDate,
        endDate,
        timeUnit,
        device: device || undefined,
        gender: gender || undefined,
        ages,
      };
      if (source === 'shopping-insight') {
        body.criteria = criteria;
        body.category = categoryCode.trim();
      }
      const response = await api.post<TrendQueryResponse>('/api/keywords/trend', body);
      if (response.data.error) {
        setError(response.data.error);
      } else {
        setTrendResult(response.data);
      }
    } catch (err) {
      setError(
        (isAxiosError<{ error?: string }>(err) && err.response?.data?.error) ||
          '조건 조회에 실패했습니다.',
      );
    } finally {
      setTrendLoading(false);
    }
  };

  /** 분야 비중(기기/성별/연령) 3회 병렬 조회 — query 불필요(분야-level). 실패해도 조건 조회 결과 카드는 유지. */
  const fetchPieData = async () => {
    const category = categoryCode.trim();
    if (!category) return;
    setPieLoading(true);
    setPieError('');
    const fetchOne = async (
      criteria: 'device' | 'gender' | 'ages',
    ): Promise<GroupShares | null> => {
      try {
        const response = await api.post<TrendQueryResponse>('/api/keywords/trend', {
          source: 'shopping-insight',
          criteria,
          category,
          startDate,
          endDate,
          timeUnit,
        });
        if (response.data.error) return null;
        return computeGroupShares(response.data.series ?? []);
      } catch {
        return null;
      }
    };
    const [d, g, a] = await Promise.all([fetchOne('device'), fetchOne('gender'), fetchOne('ages')]);
    setPieShares({ device: d ?? {}, gender: g ?? {}, ages: a ?? {} });
    if (d === null && g === null && a === null) {
      setPieError('분야 비중 데이터를 불러오지 못했습니다.');
    }
    setPieLoading(false);
  };

  /** 우측 인기검색어 클릭 → 검색어 트렌드(SCH_TRND) 조건 조회(이슈 #14).
   *  클릭한 검색어와 패널의 분야·기간·필터 선택값을 그대로 사용해 하단 📈 조건
   *  조회 결과 카드로 표시한다. 조건 조회 필터 폼도 실행값으로 동기화한다. */
  const handlePanelKeywordClick = async (term: string, ctx: KeywordClickContext) => {
    if (!term.trim()) return;
    setError('');
    setSource('search-trend');
    setQuery(term);
    setStartDate(ctx.startDate);
    setEndDate(ctx.endDate);
    setTimeUnit(ctx.timeUnit);
    setDevice((ctx.device || '') as '' | 'pc' | 'mo');
    setGender((ctx.gender || '') as '' | 'm' | 'f');
    setAges(ctx.ages);
    setTrendLoading(true);
    try {
      const response = await api.post<TrendQueryResponse>('/api/keywords/trend', {
        source: 'search-trend',
        query: term,
        startDate: ctx.startDate,
        endDate: ctx.endDate,
        timeUnit: ctx.timeUnit,
        device: ctx.device || undefined,
        gender: ctx.gender || undefined,
        ages: ctx.ages,
      });
      if (response.data.error) {
        setError(response.data.error);
      } else {
        setTrendResult(response.data);
        // 인기검색어 목록은 페이지 상단이라 하단 결과가 안 보인다 — 결과 카드로 스크롤.
        requestAnimationFrame(() => {
          document
            .getElementById('keyword-trend-result')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    } catch (err) {
      setError(
        (isAxiosError<{ error?: string }>(err) && err.response?.data?.error) ||
          '검색어 트렌드 조회에 실패했습니다.',
      );
    } finally {
      setTrendLoading(false);
    }
  };

  const dateValid = validateDateRange(startDate, endDate);
  // 조건 조회 버튼 활성 조건 — query는 keyword-level criteria에서만 필수(분야-level은 query 없이 조회 가능)
  const trendNeedsQuery = source === 'search-trend' || KEYWORD_LEVEL_CRITERIA.includes(criteria);

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
            <th className="pb-3 pr-4 font-medium">연관 키워드</th>
            <th className="pb-3 font-medium">액션</th>
          </tr>
        </thead>
        <tbody>
          {keywords.map((kw, i) => (
            <tr key={kw.keyword + i} className="border-b hover:bg-muted/50 transition-colors">
              <td className="py-3 pr-4 font-mono text-sm text-muted-foreground">{i + 1}</td>
              <td className="py-3 pr-4 font-medium">
                <span className="flex items-center gap-2">
                  {kw.keyword}
                  {kw.shoppingRatio != null && (
                    <Badge
                      variant="outline"
                      className="shrink-0 border-blue-200 text-[10px] text-blue-700"
                    >
                      쇼핑 {Math.round(kw.shoppingRatio)}%
                    </Badge>
                  )}
                </span>
              </td>
              <td className="py-3 pr-4">
                {kw.volume > 0 ? `~${kw.volume.toLocaleString()}` : '-'}
              </td>
              <td className="py-3 pr-4">
                <CompetitionBar value={kw.competition} />
              </td>
              <td className="py-3 pr-4">
                <TrendBadge trend={kw.trend} />
              </td>
              <td className="py-3 pr-4 text-sm text-muted-foreground max-w-xs truncate">
                {(kw.related || []).slice(0, 5).join(', ') || '-'}
              </td>
              <td className="py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openPostDialog(kw.keyword)}
                  title={`${kw.keyword} 키워드로 새 포스트 작성`}
                >
                  <FilePlus2 className="mr-2 h-3 w-3" />새 포스트 작성
                </Button>
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

      {/* 쇼핑인사이트 패널 — 데이터랩 레이아웃(이슈 #13). 인기검색어 클릭 → 검색어 트렌드 조회(이슈 #14) */}
      <ShoppingInsightPanel onKeywordClick={handlePanelKeywordClick} />

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

          {/* 조건 조회 필터 (Naver DataLab) */}
          <div className="mt-4 pt-4 border-t space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground w-20 shrink-0">소스</span>
              <Button
                type="button"
                size="sm"
                variant={source === 'search-trend' ? 'default' : 'outline'}
                onClick={() => setSource('search-trend')}
              >
                검색어 트렌드
              </Button>
              <Button
                type="button"
                size="sm"
                variant={source === 'shopping-insight' ? 'default' : 'outline'}
                onClick={() => setSource('shopping-insight')}
              >
                쇼핑인사이트
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground w-20 shrink-0">기간</span>
              <DateSelect label="시작일" value={startDate} onChange={setStartDate} />
              <span className="text-sm text-muted-foreground">~</span>
              <DateSelect label="종료일" value={endDate} onChange={setEndDate} />
              {!dateValid && (
                <span className="text-xs text-destructive">종료일이 시작일보다 이릅니다</span>
              )}
              {(
                [
                  ['today', '오늘'],
                  ['yesterday', '어제'],
                  ['last-7d', '최근 일주일'],
                  ['last-30d', '최근 30일'],
                ] as const
              ).map(([preset, label]) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    const range = resolvePresetRange(preset);
                    setStartDate(range.startDate);
                    setEndDate(range.endDate);
                  }}
                >
                  {label}
                </Button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground w-20 shrink-0">집계주기</span>
              {(
                [
                  ['date', '일간'],
                  ['week', '주간'],
                  ['month', '월간'],
                ] as const
              ).map(([unit, label]) => (
                <Button
                  key={unit}
                  type="button"
                  size="sm"
                  variant={timeUnit === unit ? 'default' : 'outline'}
                  onClick={() => setTimeUnit(unit)}
                >
                  {label}
                </Button>
              ))}
            </div>

            {source === 'search-trend' && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">디바이스</span>
                  {(
                    [
                      ['', '전체'],
                      ['pc', 'PC'],
                      ['mo', '모바일'],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value || 'all'}
                      type="button"
                      size="sm"
                      variant={device === value ? 'default' : 'outline'}
                      onClick={() => setDevice(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">성별</span>
                  {(
                    [
                      ['', '전체'],
                      ['m', '남자'],
                      ['f', '여자'],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value || 'all'}
                      type="button"
                      size="sm"
                      variant={gender === value ? 'default' : 'outline'}
                      onClick={() => setGender(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">연령</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={ages.length === 0 ? 'default' : 'outline'}
                    onClick={() => setAges([])}
                  >
                    모든연령
                  </Button>
                  {AGE_OPTIONS.map(({ code, label }) => (
                    <Button
                      key={code}
                      type="button"
                      size="sm"
                      variant={ages.includes(code) ? 'default' : 'outline'}
                      onClick={() =>
                        setAges((prev) =>
                          prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code],
                        )
                      }
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </>
            )}

            {source === 'shopping-insight' && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">조회 기준</span>
                  {CRITERIA_OPTIONS.map(({ value, label }) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={criteria === value ? 'default' : 'outline'}
                      onClick={() => setCriteria(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground w-20 shrink-0">카테고리</span>
                  <select
                    aria-label="쇼핑 대분류 선택"
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                    value={categoryChoice}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCategoryChoice(v);
                      setSubCategoryChoice('');
                      setSub2CategoryChoice('');
                      if (v !== CUSTOM_CATEGORY) setCategoryCode(v);
                    }}
                  >
                    <option value="">대분류 선택…</option>
                    {categories.map((c) => (
                      <option key={c.catId} value={c.catId}>
                        {c.name}
                      </option>
                    ))}
                    <option value={CUSTOM_CATEGORY}>직접 입력…</option>
                  </select>
                  {subOptions.length > 0 && (
                    <select
                      aria-label="쇼핑 2분류 선택"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={subCategoryChoice}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSubCategoryChoice(v);
                        setSub2CategoryChoice('');
                        // '' = 전체(대분류) → 대분류 cat_id로 조회
                        setCategoryCode(v || selectedParent?.catId || '');
                      }}
                    >
                      <option value="">전체({selectedParent?.name})</option>
                      {subOptions.map((c) => (
                        <option key={c.catId} value={c.catId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {sub2Options.length > 0 && (
                    <select
                      aria-label="쇼핑 3분류 선택"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={sub2CategoryChoice}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSub2CategoryChoice(v);
                        setSub3CategoryChoice('');
                        // '' = 전체(2분류) → 2분류 cat_id로 조회
                        setCategoryCode(v || subCategoryChoice || selectedParent?.catId || '');
                      }}
                    >
                      <option value="">전체({selectedSub?.name})</option>
                      {sub2Options.map((c) => (
                        <option key={c.catId} value={c.catId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {sub3Options.length > 0 && (
                    <select
                      aria-label="쇼핑 4분류 선택"
                      className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                      value={sub3CategoryChoice}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSub3CategoryChoice(v);
                        // '' = 전체(3분류) → 3분류 cat_id로 조회
                        setCategoryCode(
                          v ||
                            sub2CategoryChoice ||
                            subCategoryChoice ||
                            selectedParent?.catId ||
                            '',
                        );
                      }}
                    >
                      <option value="">전체({selectedSub2?.name})</option>
                      {sub3Options.map((c) => (
                        <option key={c.catId} value={c.catId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                  {categoryChoice === CUSTOM_CATEGORY && (
                    <Input
                      placeholder="카테고리 코드 (예: 50000009)"
                      value={categoryCode}
                      onChange={(e) => setCategoryCode(e.target.value)}
                      className="w-56"
                    />
                  )}
                </div>
              </>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                onClick={handleTrendSearch}
                disabled={trendLoading || (trendNeedsQuery && !query.trim()) || !dateValid}
              >
                {trendLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <BarChart3 className="h-4 w-4 mr-2" />
                )}
                조건 조회
              </Button>
            </div>
          </div>
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

      {/* 조건 조회 결과 — 패널 인기검색어 클릭 시에도 여기로 표시(이슈 #14) */}
      {!trendLoading && trendResult && (
        <Card id="keyword-trend-result">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">📈 조건 조회 결과</CardTitle>
            <Badge variant="outline" className="text-xs">
              {trendResult.source === 'shopping-insight' ? '쇼핑인사이트' : '검색어 트렌드'}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-5">
            {trendResult.categoryValid === false && (
              <p className="text-sm text-amber-600 dark:text-amber-400">
                ⚠️ 이 분야는 쇼핑인사이트 데이터가 없습니다
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {trendResult.request.startDate} ~ {trendResult.request.endDate} · 집계주기{' '}
              {TIME_UNIT_LABELS[trendResult.request.timeUnit] ?? trendResult.request.timeUnit} ·
              디바이스{' '}
              {trendResult.request.device === 'pc'
                ? 'PC'
                : trendResult.request.device === 'mo'
                  ? '모바일'
                  : '전체'}{' '}
              · 성별{' '}
              {trendResult.request.gender === 'm'
                ? '남자'
                : trendResult.request.gender === 'f'
                  ? '여자'
                  : '전체'}{' '}
              · 연령{' '}
              {(trendResult.request.ages ?? []).length > 0
                ? (trendResult.request.ages ?? [])
                    .map((code) => AGE_OPTIONS.find((o) => o.code === code)?.label ?? code)
                    .join(', ')
                : '모든연령'}
              {trendResult.request.criteria &&
                ` · 조회기준 ${CRITERIA_OPTIONS.find((o) => o.value === trendResult.request.criteria)?.label ?? trendResult.request.criteria}`}
            </p>
            {trendResult.series.map((group, gi) => (
              <div key={gi} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{group.title}</span>
                  <TrendBadge trend={group.trend ?? ''} />
                </div>
                <div className="space-y-1">
                  {group.data.map((point, pi) => (
                    <div key={pi} className="flex items-center gap-2">
                      <span className="w-24 shrink-0 text-xs font-mono text-muted-foreground">
                        {point.period}
                      </span>
                      <div className="flex-1 h-4 rounded bg-muted overflow-hidden">
                        <div
                          className="h-full rounded bg-primary/70"
                          style={{
                            width: `${Math.max(0, Math.min(100, point.ratio))}%`,
                          }}
                        />
                      </div>
                      <span className="w-14 shrink-0 text-right text-xs font-mono">
                        {point.ratio.toFixed(2)}
                      </span>
                    </div>
                  ))}
                  {group.data.length === 0 && (
                    <p className="text-xs text-muted-foreground">데이터가 없습니다</p>
                  )}
                </div>
              </div>
            ))}
            {trendResult.series.length === 0 && (
              <p className="text-sm text-muted-foreground">조회 결과가 없습니다</p>
            )}
            {trendResult.source === 'shopping-insight' && (
              <div className="pt-4 border-t">
                {pieLoading && (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    분야 비중을 불러오는 중...
                  </p>
                )}
                {!pieLoading && pieError && <p className="text-xs text-destructive">{pieError}</p>}
                {!pieLoading && !pieError && (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <GroupDonut title="기기별 비중" shares={pieShares.device} />
                    <GroupDonut title="성별 비중" shares={pieShares.gender} />
                    <GroupDonut title="연령별 비중" shares={pieShares.ages} />
                  </div>
                )}
              </div>
            )}
          </CardContent>
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
          <CardContent>{renderKeywordTable(sortedKeywords)}</CardContent>
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

      {/* 새 포스트 작성 다이얼로그 */}
      <Dialog
        open={postDialogKeyword !== null}
        onClose={() => setPostDialogKeyword(null)}
        title={`새 포스트 작성: ${postDialogKeyword ?? ''}`}
        footer={
          <>
            <Button variant="outline" onClick={() => setPostDialogKeyword(null)}>
              취소
            </Button>
            <Button onClick={handleGeneratePost} disabled={generating || !selectedTemplate}>
              {generating ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FilePlus2 className="mr-2 h-4 w-4" />
              )}
              생성
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            템플릿을 선택하면 AI가 키워드 기반 포스트 초안을 생성합니다.
          </p>
          <select
            className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={selectedTemplate}
            onChange={(e) => setSelectedTemplate(e.target.value)}
            disabled={templates.length === 0}
          >
            {templates.length === 0 ? (
              <option value="">템플릿이 없습니다</option>
            ) : (
              templates.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))
            )}
          </select>
          {generateError && <p className="text-sm text-destructive">{generateError}</p>}
          {generating && (
            <p className="flex items-center text-sm text-muted-foreground">
              포스트 초안을 생성하는 중... 잠시 후 포스트 관리로 이동합니다.
            </p>
          )}
        </div>
      </Dialog>
    </div>
  );
}
