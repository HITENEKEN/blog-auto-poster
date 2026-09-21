import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../services/api';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { CheckCircle2, XCircle, RefreshCw, Pause, Play, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';

/**
 * 로봇 패널(설계 §7-3). `GET /api/robot/status`를 15초마다 폴링한다.
 * 로봇이 한 번도 돌지 않아 robot.sqlite가 없으면 `installed:false` — 빈 상태를 렌더링한다.
 * 상태 변경은 전부 `POST /api/robot/commands`(명령)로만 한다.
 */

export interface RobotRun {
  id: string;
  kind: 'plan' | 'publish';
  slot: string;
  trigger: string;
  mode: string;
  status: string;
  step: string;
  keyword?: string | null;
  category_id?: string | null;
  draft_id?: string | null;
  preview_sha256?: string | null;
  approval_requested_at?: string | null;
  log_no?: string | null;
  url?: string | null;
  outcome?: string | null;
  warnings?: string[];
  started_at: string;
  finished_at?: string | null;
}

export interface RobotNextSlot {
  kind: 'plan' | 'publish';
  at: string;
}

export interface RobotStatusResponse {
  installed: boolean;
  enabled: boolean;
  paused: boolean;
  mode: 'manual' | 'auto';
  lease: { pid: number; hostname: string; expiresAt: string } | null;
  nextSlots: RobotNextSlot[];
  current: RobotRun | null;
  awaitingApproval: RobotRun | null;
  recent: RobotRun[];
  consecutivePasses: number;
  autoPromoteAfterPasses: number;
  openAdRequests: number | null;
}

export interface RobotRunDetail {
  run: RobotRun;
  steps: Array<{ id: number; step: string; attempt: number; status: string; started_at: string }>;
  plan: { keyword: string; category_id?: string | null; decision?: Record<string, unknown> } | null;
  evidenceDir: string;
  /** 배치된 광고(로봇 증거 ads/placement.json). 승인 카드가 보여준다. */
  placement: { ads: Array<{ id: string; productName?: string }>; slots: unknown[] } | null;
}

export const POLL_MS = 15_000;

const KIND_LABEL: Record<string, string> = { plan: '기획', publish: '발행' };

const STATUS_LABEL: Record<string, string> = {
  running: '실행 중',
  waiting: '대기',
  done: '완료',
  skipped: '건너뜀',
  aborted: '중단',
};

function outcomeVariant(outcome?: string | null): 'default' | 'secondary' | 'destructive' {
  if (!outcome) return 'secondary';
  if (outcome.startsWith('aborted')) return 'destructive';
  if (outcome.startsWith('skipped')) return 'secondary';
  return 'default';
}

function formatKst(iso?: string | null): string {
  if (!iso) return '-';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

/** 승인 카드에 필요한 정보 — 실행 상세(계획·증거)를 함께 불러온다. */
async function fetchRunDetail(runId: string): Promise<RobotRunDetail | null> {
  try {
    const response = await api.get<RobotRunDetail>(`/api/robot/runs/${runId}`);
    return response.data;
  } catch {
    return null;
  }
}

export default function Scheduler() {
  const [status, setStatus] = useState<RobotStatusResponse | null>(null);
  const [detail, setDetail] = useState<RobotRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.get<RobotStatusResponse>('/api/robot/status');
      setStatus(response.data);
      setError(null);
      const awaiting = response.data.awaitingApproval;
      if (awaiting) {
        setDetail(await fetchRunDetail(awaiting.id));
      } else {
        setDetail(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '상태를 불러오지 못했습니다');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = window.setInterval(() => {
      void load();
    }, POLL_MS);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [load]);

  const sendCommand = useCallback(
    async (type: string, runId?: string, payload?: Record<string, unknown>) => {
      setBusy(true);
      try {
        await api.post('/api/robot/commands', { type, runId, payload });
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : '명령을 보내지 못했습니다');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">자동 포스팅</h1>
        <Card>
          <CardContent className="p-6 text-muted-foreground">불러오는 중…</CardContent>
        </Card>
      </div>
    );
  }

  if (!status || !status.installed) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">자동 포스팅</h1>
        <Card>
          <CardHeader>
            <CardTitle>로봇이 아직 실행되지 않았습니다</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              <code>data/robot.sqlite</code>가 없습니다. PM2로 로봇을 한 번 띄우면 이 패널에
              상태·승인 카드·최근 실행이 나타납니다.
            </p>
            <pre className="rounded bg-muted p-3 text-xs">
              npm run build{'\n'}
              pm2 start ecosystem.config.cjs{'\n'}
              npm run robot -- status
            </pre>
          </CardContent>
        </Card>
      </div>
    );
  }

  const approval = status.awaitingApproval;
  const plan = detail?.plan ?? null;
  const decision = (plan?.decision ?? {}) as Record<string, unknown>;
  const placedAds = detail?.placement?.ads ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">자동 포스팅</h1>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="mr-2 h-4 w-4" /> 새로고침
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void sendCommand(status.paused ? 'resume' : 'pause')}
          >
            {status.paused ? (
              <>
                <Play className="mr-2 h-4 w-4" /> 재개
              </>
            ) : (
              <>
                <Pause className="mr-2 h-4 w-4" /> 일시정지
              </>
            )}
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void sendCommand('run-now', undefined, { kind: 'plan' })}
          >
            기획 지금 실행
          </Button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">상태</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <div>
              활성화:{' '}
              <Badge variant={status.enabled ? 'default' : 'secondary'}>
                {status.enabled ? '켜짐' : '꺼짐'}
              </Badge>
            </div>
            <div>
              모드: <Badge variant="outline">{status.mode}</Badge>
            </div>
            <div>
              일시정지:{' '}
              <Badge variant={status.paused ? 'destructive' : 'secondary'}>
                {status.paused ? '예' : '아니오'}
              </Badge>
            </div>
            <div className="text-muted-foreground">
              연속 통과 {status.consecutivePasses}/{status.autoPromoteAfterPasses}
              {status.consecutivePasses >= status.autoPromoteAfterPasses && ' · 자동 전환 검토'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">다음 슬롯</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {status.nextSlots.length === 0 && (
              <div className="text-muted-foreground">예정 없음</div>
            )}
            {status.nextSlots.map((slot) => (
              <div key={`${slot.kind}-${slot.at}`}>
                {KIND_LABEL[slot.kind]} · {formatKst(slot.at)}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">현재 실행</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {status.current ? (
              <>
                <div>
                  {KIND_LABEL[status.current.kind] ?? status.current.kind} ·{' '}
                  <span className="font-mono">{status.current.step}</span>
                </div>
                <div className="text-muted-foreground">
                  {status.current.keyword ?? status.current.id}
                </div>
                <div className="text-muted-foreground">
                  {STATUS_LABEL[status.current.status] ?? status.current.status}
                </div>
              </>
            ) : (
              <div className="text-muted-foreground">진행 중 실행 없음</div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">소재 요청</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {status.openAdRequests === null ? (
              <span className="text-muted-foreground">광고 기능 미사용</span>
            ) : (
              <span>열린 요청 {status.openAdRequests}건</span>
            )}
            <div className="mt-2">
              <Link className="text-primary underline" to="/coupang">
                쿠팡 현황으로 이동
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {approval && (
        <Card className="border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <CheckCircle2 className="h-5 w-5" /> 승인 대기 — {approval.keyword ?? approval.id}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-2 md:grid-cols-2">
              <div>
                <div className="font-medium">미리보기</div>
                <div className="break-all text-muted-foreground">
                  {approval.preview_sha256
                    ? `sha256 ${approval.preview_sha256.slice(0, 16)}…`
                    : 'sha256 없음'}
                </div>
                {approval.draft_id && (
                  <Link
                    className="text-primary underline"
                    to={`/posts/${approval.draft_id}/edit`}
                    target="_blank"
                  >
                    초안 미리보기 열기
                  </Link>
                )}
              </div>
              <div>
                <div className="font-medium">선정 근거</div>
                <div className="text-muted-foreground">
                  {String(decision.reason ?? '(근거 없음)')}
                </div>
                {plan?.category_id && (
                  <div className="text-muted-foreground">카테고리 {plan.category_id}</div>
                )}
              </div>
            </div>

            <div>
              <div className="font-medium">광고 상품 ({placedAds.length}개)</div>
              {placedAds.length === 0 ? (
                <div className="text-muted-foreground">배치된 광고가 없습니다</div>
              ) : (
                <ul className="list-inside list-disc text-muted-foreground">
                  {placedAds.map((ad) => (
                    <li key={ad.id}>{ad.productName ? `${ad.productName} (${ad.id})` : ad.id}</li>
                  ))}
                </ul>
              )}
            </div>

            <div className="text-muted-foreground">
              요청 시각 {formatKst(approval.approval_requested_at)} · 120분이 지나면 자동 종료됩니다
            </div>

            <div className="flex gap-2">
              <Button
                disabled={busy}
                onClick={() =>
                  void sendCommand('approve', approval.id, {
                    previewSha256: approval.preview_sha256,
                  })
                }
              >
                승인하고 발행
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void sendCommand('reject', approval.id, { reason: '대시보드에서 거절' })
                }
              >
                <XCircle className="mr-2 h-4 w-4" /> 거절
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-xl">최근 실행 ({status.recent.length}건)</CardTitle>
        </CardHeader>
        <CardContent>
          {status.recent.length === 0 ? (
            <div className="text-sm text-muted-foreground">실행 이력이 없습니다.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="p-2">시작</th>
                    <th className="p-2">종류</th>
                    <th className="p-2">단계</th>
                    <th className="p-2">키워드</th>
                    <th className="p-2">결과</th>
                    <th className="p-2">URL</th>
                    <th className="p-2">경고</th>
                    <th className="p-2">명령</th>
                  </tr>
                </thead>
                <tbody>
                  {status.recent.map((run) => (
                    <tr key={run.id} className="border-b align-top">
                      <td className="p-2 whitespace-nowrap">{formatKst(run.started_at)}</td>
                      <td className="p-2">{KIND_LABEL[run.kind] ?? run.kind}</td>
                      <td className="p-2 font-mono text-xs">{run.step}</td>
                      <td className="p-2">{run.keyword ?? '-'}</td>
                      <td className="p-2">
                        <Badge variant={outcomeVariant(run.outcome)}>
                          {run.outcome ?? STATUS_LABEL[run.status] ?? run.status}
                        </Badge>
                      </td>
                      <td className="p-2">
                        {run.url ? (
                          <a
                            className="text-primary underline"
                            href={run.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {run.log_no ?? '열기'}
                          </a>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td
                        className={clsx(
                          'p-2',
                          (run.warnings?.length ?? 0) > 0 && 'text-destructive',
                        )}
                      >
                        {(run.warnings ?? []).join(', ') || '-'}
                      </td>
                      <td className="p-2">
                        {run.outcome === 'aborted-unconfirmed' ? (
                          <span className="text-muted-foreground">
                            `npm run robot -- adopt {run.id} &lt;logNo&gt;`
                          </span>
                        ) : run.status === 'running' || run.status === 'waiting' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy || run.step === 'PUBLISHING'}
                            onClick={() => void sendCommand('cancel', run.id)}
                          >
                            취소
                          </Button>
                        ) : (
                          '-'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
