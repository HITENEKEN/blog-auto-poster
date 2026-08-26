import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { ScheduledJob, ScheduledJobConfig } from '@shared/types';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Clock, Play, Pause, RefreshCw, Loader2, Settings } from 'lucide-react';
import { clsx } from 'clsx';

const typeLabels: Record<string, string> = {
  RESEARCH: '키워드 리서치',
  GENERATE: '콘텐츠 생성',
  PUBLISH: '포스트 발행',
  SYNC_ANALYTICS: '분석 동기화',
};

export default function Scheduler() {
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [schedulerRunning, setSchedulerRunning] = useState(false);

  useEffect(() => {
    fetchJobs();
    fetchSchedulerStatus();
  }, []);

  const fetchJobs = async () => {
    try {
      const response = await api.get('/api/scheduler/jobs');
      setJobs(response.data.jobs);
    } catch (error) {
      console.error('Failed to fetch jobs:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchSchedulerStatus = async () => {
    try {
      const response = await api.get('/api/scheduler/config');
      setSchedulerRunning(response.data.enabled);
    } catch {}
  };

  const handleTrigger = async (jobName: string) => {
    try {
      await api.post(`/api/scheduler/jobs/${jobName}/trigger`);
      alert('작업이 트리거되었습니다.');
    } catch (error) {
      console.error('Trigger failed:', error);
    }
  };

  const handleToggle = async (job: ScheduledJob) => {
    try {
      await api.put('/api/scheduler/config', {
        jobs: jobs.map(j => j.name === job.name ? { ...j, enabled: !j.enabled } : j),
      });
      fetchJobs();
    } catch (error) {
      console.error('Toggle failed:', error);
    }
  };

  const handleToggleScheduler = async () => {
    try {
      await api.put('/api/scheduler/config', { enabled: !schedulerRunning });
      setSchedulerRunning(!schedulerRunning);
    } catch (error) {
      console.error('Scheduler toggle failed:', error);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">자동 포스팅 설정</h1>
          <p className="text-muted-foreground">스케줄러를 관리하고 자동 발행 작업을 설정하세요</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchJobs} disabled={loading}>
            <RefreshCw className={clsx('h-4 w-4 mr-2', loading && 'animate-spin')} />
            새로고침
          </Button>
          <Button
            variant={schedulerRunning ? 'default' : 'outline'}
            onClick={handleToggleScheduler}
            className="gap-2"
          >
            {schedulerRunning ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {schedulerRunning ? '스케줄러 중지' : '스케줄러 시작'}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>예약된 작업 ({jobs.length}개)</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
            </div>
          ) : jobs.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <Clock className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>예약된 작업이 없습니다.</p>
            </div>
          ) : (
            <div className="space-y-4">
              {jobs.map((job) => (
                <div key={job.name} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 p-4 rounded-lg border">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Clock className="h-5 w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="font-medium truncate">{job.name}</h4>
                        <Badge variant="outline">{typeLabels[job.type] || job.type}</Badge>
                        <Badge className={clsx(job.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-700')}>
                          {job.enabled ? '활성' : '비활성'}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-4 mt-1 text-sm text-muted-foreground">
                        <span className="font-mono">{job.cron}</span>
                        <span>우선순위: {job.priority}</span>
                        <span>최대 재시도: {job.config.maxAttempts || 3}회</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleToggle(job)}
                      className={clsx(job.enabled ? 'bg-green-50 hover:bg-green-100' : '')}
                    >
                      {job.enabled ? '비활성화' : '활성화'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleTrigger(job.name)}>
                      <Play className="h-4 w-4 mr-1" />
                      지금 실행
                    </Button>
                    <Button variant="ghost" size="icon" asChild>
                      <a href={`/settings?job=${job.name}`}>
                        <Settings className="h-4 w-4" />
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Cron expression helper */}
      <Card>
        <CardHeader>
          <CardTitle>Cron 표현식 가이드</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 text-sm">
            {[
              { expression: '0 6 * * *', description: '매일 06:00' },
              { expression: '0 7 * * *', description: '매일 07:00' },
              { expression: '0 8 * * *', description: '매일 08:00' },
              { expression: '0 * * * *', description: '매시간 정각' },
              { expression: '0 */6 * * *', description: '6시간마다' },
              { expression: '0 0 * * 0', description: '매주 일요일 00:00' },
            ].map((item) => (
              <div key={item.expression} className="p-3 rounded-lg bg-muted/50 flex items-center justify-between">
                <code className="font-mono text-primary">{item.expression}</code>
                <span className="text-muted-foreground">{item.description}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}