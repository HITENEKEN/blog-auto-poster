import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Download, Loader2, Search } from 'lucide-react';
import { api } from '../services/api';
import { Card, CardContent } from './ui/Card';
import { Button } from './ui/Button';

/**
 * 쇼핑인사이트 패널(이슈 #13) — 네이버 데이터랩 쇼핑인사이트 화면 재현.
 * 분야 4단계 연쇄 선택 + 기간/구간단위/기기/성별/연령 조건 + [조회하기] 버튼으로
 * GET /api/keywords/category-overview를 호출해 클릭량 추이·인기검색어 TOP 20·
 * 기기별/성별/연령별 비중을 표시한다. 모든 코드/기간은 UI 선택값 그대로 전달된다.
 * 인기검색어는 데이터랩 랭킹 직조회 결과(화면 표시와 동일)이며, 항목 클릭 시
 * onKeywordClick(term, 패널 선택값)으로 하단 검색어 트렌드 조회를 트리거한다(이슈 #14).
 */

interface CatNode {
  catId: string;
  name: string;
  children?: CatNode[];
}
interface SeriesPoint {
  period: string;
  ratio: number;
  group?: string;
}
interface TrendSeries {
  title: string;
  data: SeriesPoint[];
}
interface Overview {
  category: string;
  categoryName?: string;
  categoryValid?: boolean;
  clickTrend: TrendSeries[];
  shares: { device: TrendSeries[]; gender: TrendSeries[]; ages: TrendSeries[] };
  keywords: Array<{ keyword: string; volume: number; metadata?: Record<string, unknown> }>;
  /** 응답 데이터 소스 — 'naver-datalab'(랭킹 직조회) 외 값이면 서버가 구버전 코드다. */
  keywordsSource?: string;
}

/** 인기검색어 클릭 시 하단 검색어 트렌드 조회에 사용할 패널 선택값(이슈 #14). */
export interface KeywordClickContext {
  category: string;
  categoryName: string;
  startDate: string;
  endDate: string;
  timeUnit: 'date' | 'week' | 'month';
  device: string;
  gender: string;
  ages: string[];
}

export type OnKeywordClick = (term: string, ctx: KeywordClickContext) => void;

interface Props {
  /** 인기검색어 클릭 → 하단 검색어 트렌드 조건 조회(부모 Keywords 페이지가 수행). */
  onKeywordClick?: OnKeywordClick;
}

const CHART_COLORS = ['#12b886', '#fd7e14', '#339af0', '#e64980', '#845ef7', '#f59f00'];
const GROUP_LABELS: Record<string, string> = {
  pc: 'PC',
  mo: '모바일',
  m: '남성',
  f: '여성',
  '10': '10대',
  '20': '20대',
  '30': '30대',
  '40': '40대',
  '50': '50대',
  '60': '60대 이상',
};
const AGE_CODES = ['10', '20', '30', '40', '50', '60'];

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function addDays(base: Date, days: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
}
/** 프리셋 기간 — endDate는 어제(데이터 확정 분)까지. 스펙 하한 2017-08-01 클램프. */
function computeRange(preset: string): { startDate: string; endDate: string } {
  const now = new Date();
  const end = fmtDate(addDays(now, -1));
  const min = '2017-08-01';
  const map: Record<string, number> = { daily: 0, '1m': -30, '3m': -90, '1y': -365 };
  const span = map[preset] ?? -30;
  const start = fmtDate(span === 0 ? addDays(now, -1) : addDays(now, span));
  return { startDate: start < min ? min : start, endDate: end };
}
function shortPeriod(p: string): string {
  const [, m, d] = p.split('-');
  return `${Number(m)}일\n${Number(d)}일`;
}

/** 시리즈 → 그룹 코드별 기간합 비율 %(기간합계 도넛용). */
function groupShares(series: TrendSeries[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const s of series) {
    for (const p of s.data) {
      const key = p.group ?? s.title;
      if (!key) continue;
      sums[key] = (sums[key] ?? 0) + (p.ratio ?? 0);
    }
  }
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  if (total <= 0) return {};
  return Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, (v / total) * 100]));
}

function Donut({ title, shares }: { title: string; shares: Record<string, number> }) {
  const entries = Object.entries(shares)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <div className="min-w-0">
      <p className="mb-1 text-sm font-medium">{title}</p>
      {entries.length === 0 ? (
        <p className="py-10 text-center text-xs text-muted-foreground">데이터 없음</p>
      ) : (
        <div className="w-full" style={{ height: 200 }}>
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
                outerRadius="80%"
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

/** 인기검색어 TOP 20 랭킹 목록 — 데이터랩 우측 패널 재현. 항목 클릭 → 검색어 트렌드 조회(이슈 #14). */
function TopKeywords({
  data,
  ctx,
  onKeywordClick,
}: {
  data: Overview;
  ctx: KeywordClickContext;
  onKeywordClick?: OnKeywordClick;
}) {
  return (
    <Card className="h-full">
      <CardContent className="pt-5">
        <h3 className="text-xl font-bold text-blue-600">
          {data.categoryName ?? data.category} 인기검색어
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          TOP {data.keywords.length} ·{' '}
          {data.keywordsSource && data.keywordsSource !== 'naver-datalab'
            ? `서버 응답 ${data.keywordsSource} — 서버 재시작 필요`
            : '데이터랩'}
        </p>
        {data.keywords.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">데이터가 없습니다</p>
        ) : (
          <ol className="mt-4 space-y-2">
            {data.keywords.map((kw, i) => (
              <li key={kw.keyword} className="flex items-baseline gap-3 text-sm">
                <span className="w-6 shrink-0 text-right font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                {onKeywordClick ? (
                  <button
                    type="button"
                    onClick={() => onKeywordClick(kw.keyword, ctx)}
                    className="min-w-0 truncate text-left hover:underline underline-offset-2"
                    title={`${kw.keyword} 검색어 트렌드 조회`}
                  >
                    {kw.keyword}
                  </button>
                ) : (
                  <span className="min-w-0 truncate">{kw.keyword}</span>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

export default function ShoppingInsightPanel({ onKeywordClick }: Props) {
  const [categories, setCategories] = useState<CatNode[]>([]);
  const [c1, setC1] = useState('');
  const [c2, setC2] = useState('');
  const [c3, setC3] = useState('');
  const [c4, setC4] = useState('');
  const [preset, setPreset] = useState<'daily' | '1m' | '3m' | '1y' | 'custom'>('1m');
  const [range, setRange] = useState(() => computeRange('1m'));
  const [timeUnit, setTimeUnit] = useState<'date' | 'week' | 'month'>('week');
  const [device, setDevice] = useState('');
  const [gender, setGender] = useState('');
  const [ages, setAges] = useState<string[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const cat1 = categories.find((c) => c.catId === c1) ?? null;
  const cat2 = cat1?.children?.find((c) => c.catId === c2) ?? null;
  const cat3 = cat2?.children?.find((c) => c.catId === c3) ?? null;
  const leaf = cat3?.children?.find((c) => c.catId === c4) ?? cat3 ?? cat2 ?? cat1;
  const catId = leaf?.catId ?? '';
  const catName = leaf?.name ?? '';

  // 코드표 로드 — 최초 진입 시 첫 분류 자동 선택(요구사항 1: 최초 진입 조회).
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ categories: CatNode[] }>('/api/keywords/shopping-categories')
      .then((res) => {
        if (cancelled) return;
        const tree = res.data.categories ?? [];
        setCategories(tree);
        const first = tree[0];
        if (first) {
          setC1(first.catId);
          const second = first.children?.[0];
          if (second) {
            setC2(second.catId);
            const third = second.children?.[0];
            if (third) {
              setC3(third.catId);
              setC4(third.children?.[0]?.catId ?? '');
            }
          }
        }
      })
      .catch(() => setCategories([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchOverview = useCallback(async () => {
    if (!catId) return;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      category: catId,
      categoryName: catName,
      startDate: range.startDate,
      endDate: range.endDate,
      timeUnit,
    });
    if (device) params.set('device', device);
    if (gender) params.set('gender', gender);
    if (ages.length) params.set('ages', ages.join(','));
    try {
      const response = await api.get<Overview>(`/api/keywords/category-overview?${params}`);
      setOverview(response.data);
    } catch (err) {
      setError(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
          '쇼핑인사이트 조회에 실패했습니다.',
      );
    } finally {
      setLoading(false);
    }
  }, [catId, catName, range.startDate, range.endDate, timeUnit, device, gender, ages.join(',')]);

  // 최초 진입 자동 조회 — 코드표 로드로 catId가 처음 확정된 시점에 1회 실행.
  const autoFetched = useRef('');
  useEffect(() => {
    if (!catId || loading) return;
    const key = `${catId}|${range.startDate}|${range.endDate}`;
    if (autoFetched.current === key) return;
    autoFetched.current = key;
    void fetchOverview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catId]);

  const applyPreset = (p: 'daily' | '1m' | '3m' | '1y' | 'custom') => {
    setPreset(p);
    if (p !== 'custom') {
      setRange(computeRange(p));
      setTimeUnit(p === 'daily' ? 'date' : p === '1m' ? 'week' : 'month');
    }
  };

  const downloadCsv = () => {
    if (!overview || overview.clickTrend.length === 0) return;
    const rows = ['period,ratio'];
    for (const p of overview.clickTrend[0]?.data ?? []) {
      rows.push(`${p.period},${p.ratio}`);
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `shopping-insight-${overview.category}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clickSeries = overview?.clickTrend ?? [];
  const clickPoints = clickSeries[0]?.data ?? [];
  const rangeLabel = `${range.startDate} ~ ${range.endDate}`;
  const donutShares = overview
    ? {
        device: groupShares(overview.shares.device),
        gender: groupShares(overview.shares.gender),
        ages: groupShares(overview.shares.ages),
      }
    : null;

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {/* 검색조건 바 — 데이터랩 상단바 재현(분야/기간/기기·성별·연령) */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-sm font-medium">분야</span>
            {[
              { value: c1, set: setC1, options: categories, placeholder: '대분류' },
              { value: c2, set: setC2, options: cat1?.children ?? [], placeholder: '2분류' },
              { value: c3, set: setC3, options: cat2?.children ?? [], placeholder: '3분류' },
              { value: c4, set: setC4, options: cat3?.children ?? [], placeholder: '4분류' },
            ].map((sel, i) => (
              <span key={i} className="flex items-center gap-2">
                {i > 0 && <span className="text-muted-foreground">›</span>}
                <select
                  aria-label={`분야 ${i + 1}분류`}
                  className="h-10 min-w-36 rounded-md border border-input bg-background px-2 text-sm"
                  value={sel.value}
                  onChange={(e) => sel.set(e.target.value)}
                >
                  <option value="">{sel.placeholder}</option>
                  {sel.options.map((c) => (
                    <option key={c.catId} value={c.catId}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-sm font-medium">기간</span>
            {(
              [
                ['daily', '일간'],
                ['1m', '1개월'],
                ['3m', '3개월'],
                ['1y', '1년'],
                ['custom', '직접입력'],
              ] as const
            ).map(([p, label]) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={preset === p ? 'default' : 'outline'}
                onClick={() => applyPreset(p)}
              >
                {label}
              </Button>
            ))}
            {preset === 'custom' ? (
              <>
                <input
                  type="date"
                  aria-label="시작일"
                  className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                  value={range.startDate}
                  min="2017-08-01"
                  onChange={(e) => setRange((r) => ({ ...r, startDate: e.target.value }))}
                />
                <span className="text-muted-foreground">~</span>
                <input
                  type="date"
                  aria-label="종료일"
                  className="h-10 rounded-md border border-input bg-background px-2 text-sm"
                  value={range.endDate}
                  min="2017-08-01"
                  onChange={(e) => setRange((r) => ({ ...r, endDate: e.target.value }))}
                />
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                {range.startDate} ~ {range.endDate}
              </span>
            )}
            <select
              aria-label="구간단위"
              className="h-10 rounded-md border border-input bg-background px-2 text-sm"
              value={timeUnit}
              onChange={(e) => setTimeUnit(e.target.value as 'date' | 'week' | 'month')}
            >
              <option value="date">일간</option>
              <option value="week">주간</option>
              <option value="month">월간</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-sm font-medium">기기</span>
            {[
              ['', '전체'],
              ['pc', 'PC'],
              ['mo', '모바일'],
            ].map(([code, label]) => (
              <Button
                key={code}
                type="button"
                size="sm"
                variant={device === code ? 'default' : 'outline'}
                onClick={() => setDevice(code)}
              >
                {label}
              </Button>
            ))}
            <span className="ml-4 w-10 shrink-0 text-sm font-medium">성별</span>
            {[
              ['', '전체'],
              ['f', '여성'],
              ['m', '남성'],
            ].map(([code, label]) => (
              <Button
                key={code}
                type="button"
                size="sm"
                variant={gender === code ? 'default' : 'outline'}
                onClick={() => setGender(code)}
              >
                {label}
              </Button>
            ))}
            <span className="ml-4 w-10 shrink-0 text-sm font-medium">연령</span>
            <Button
              type="button"
              size="sm"
              variant={ages.length === 0 ? 'default' : 'outline'}
              onClick={() => setAges([])}
            >
              전체
            </Button>
            {AGE_CODES.map((code) => (
              <Button
                key={code}
                type="button"
                size="sm"
                variant={ages.includes(code) ? 'default' : 'outline'}
                onClick={() =>
                  setAges((prev) =>
                    prev.includes(code) ? prev.filter((a) => a !== code) : [...prev, code],
                  )
                }
              >
                {GROUP_LABELS[code]}
              </Button>
            ))}
          </div>
        </div>
        <div className="flex justify-center border-t pt-4">
          <Button onClick={() => void fetchOverview()} disabled={loading || !catId}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-2 h-4 w-4" />
            )}
            조회하기
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {/* 결과 그리드 — 데이터랩 레이아웃 (좌: 추이+비중 / 우: 인기검색어) */}
        {overview && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <Card>
                <CardContent className="pt-5">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-xl font-bold">
                      <span className="text-blue-600">
                        {overview.categoryName ?? overview.category}
                      </span>{' '}
                      클릭량 추이
                    </h3>
                    <Button variant="ghost" size="sm" onClick={downloadCsv}>
                      <Download className="mr-1 h-3 w-3" />
                      조회결과 다운로드
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">{rangeLabel}</p>
                  {clickPoints.length === 0 ? (
                    <p className="py-16 text-center text-sm text-muted-foreground">
                      데이터가 없습니다
                    </p>
                  ) : (
                    <div className="mt-4 w-full" style={{ height: 300 }}>
                      <ResponsiveContainer>
                        <LineChart
                          data={clickPoints.map((p) => ({
                            period: p.period,
                            ratio: p.ratio,
                          }))}
                          margin={{ top: 10, right: 16, bottom: 10, left: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" vertical={false} />
                          <XAxis
                            dataKey="period"
                            tickFormatter={(v: string) => shortPeriod(v)}
                            tick={{ fontSize: 11 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                          <Tooltip
                            formatter={(value) => [`${value}`, '클릭량']}
                            labelFormatter={(v) => String(v)}
                          />
                          <Line
                            type="monotone"
                            dataKey="ratio"
                            stroke="#12b886"
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardContent className="pt-5">
                  <h3 className="text-lg font-bold">기기별 / 성별 / 연령별 비중 (기간합계)</h3>
                  <p className="text-xs text-muted-foreground">{rangeLabel}</p>
                  <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-3">
                    <Donut title="PC, 모바일" shares={donutShares?.device ?? {}} />
                    <Donut title="여성, 남성" shares={donutShares?.gender ?? {}} />
                    <Donut title="연령별" shares={donutShares?.ages ?? {}} />
                  </div>
                </CardContent>
              </Card>
            </div>
            <TopKeywords
              data={overview}
              ctx={{
                category: catId,
                categoryName: catName,
                startDate: range.startDate,
                endDate: range.endDate,
                timeUnit,
                device,
                gender,
                ages,
              }}
              onKeywordClick={onKeywordClick}
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
