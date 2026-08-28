import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/Tabs';
import { Label } from './ui/Label';
import {
  Save,
  Shield,
  Bell,
  Database,
  Key,
  Globe,
  RefreshCw,
  Loader2,
  Upload,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { toast } from './ui/use-toast';
import { api } from '../services/api';
import { LLM_PROVIDER_OPTIONS } from '@shared/llmProviders';

interface SettingsData {
  general: {
    siteName: string;
    timezone: string;
    language: string;
  };
  affiliates: {
    coupang: { apiKey: string; apiSecret: string; trackingId: string };
  };
  platforms: {
    tistory: { blogName: string; username: string; apiKey: string };
    wordpress: { url: string; username: string; appPassword: string };
    youtube: { clientId: string; clientSecret: string };
    naver: {
      blogId: string;
      username: string;
      password: string;
      clientId: string;
      clientSecret: string;
    };
  };
  imageProviders: {
    dalle: { apiKey: string; model: string };
    stableDiffusion: { apiKey: string; apiUrl: string };
    gemini: { apiKey: string; model: string };
  };
  llm: { provider: string; apiKey: string; model: string; baseUrl: string };
  notifications: {
    email: string;
    slackWebhook: string;
    discordWebhook: string;
  };
}

const defaultSettings: SettingsData = {
  general: { siteName: 'Blog Auto Poster', timezone: 'Asia/Seoul', language: 'ko' },
  affiliates: { coupang: { apiKey: '', apiSecret: '', trackingId: '' } },
  platforms: {
    tistory: { blogName: '', username: '', apiKey: '' },
    wordpress: { url: '', username: '', appPassword: '' },
    youtube: { clientId: '', clientSecret: '' },
    naver: { blogId: '', username: '', password: '', clientId: '', clientSecret: '' },
  },
  imageProviders: {
    dalle: { apiKey: '', model: 'dall-e-3' },
    stableDiffusion: { apiKey: '', apiUrl: 'https://api.stability.ai' },
    gemini: { apiKey: '', model: 'gemini-1.5-pro' },
  },
  llm: { provider: 'gemini', apiKey: '', model: 'gemini-1.5-pro', baseUrl: '' },
  notifications: { email: '', slackWebhook: '', discordWebhook: '' },
};

function getNested(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    // Plain settings-object traversal: each level is keyed by the next path segment.
    const level = cur as Record<string, unknown> | null | undefined;
    if (level == null || typeof level !== 'object') return undefined;
    cur = level[p];
  }
  return cur;
}

// Map a client settings section to a server config payload (server key names differ, e.g. youtube -> youtube-shorts).
function toServerPayload(section: string, settings: SettingsData): Record<string, unknown> {
  switch (section) {
    case 'general':
      return { app: { name: settings.general.siteName, timezone: settings.general.timezone } };
    case 'affiliates':
      return { affiliates: { coupang: settings.affiliates.coupang } };
    case 'platforms':
      return {
        platforms: {
          tistory: settings.platforms.tistory,
          wordpress: settings.platforms.wordpress,
          'youtube-shorts': settings.platforms.youtube,
          naver: settings.platforms.naver,
        },
      };
    case 'imageProviders':
      return {
        imageProviders: {
          dalle: settings.imageProviders.dalle,
          'stable-diffusion': settings.imageProviders.stableDiffusion,
          gemini: settings.imageProviders.gemini,
        },
      };
    case 'llm':
      return { llm: settings.llm };
    case 'notifications':
      return { notifications: settings.notifications };
    default:
      return {};
  }
}

// Shape of GET /api/config response fields consumed for hydration.
interface ServerConfig {
  app?: { name?: string; timezone?: string };
  affiliates?: { coupang?: { apiKey?: string; apiSecret?: string; trackingId?: string } };
  platforms?: {
    tistory?: { blogName?: string; username?: string; apiKey?: string };
    wordpress?: { url?: string; username?: string; appPassword?: string };
    'youtube-shorts'?: { clientId?: string; clientSecret?: string };
    naver?: {
      blogId?: string;
      username?: string;
      password?: string;
      clientId?: string;
      clientSecret?: string;
    };
  };
  llm?: { provider?: string; apiKey?: string; model?: string; baseUrl?: string };
  imageProviders?: {
    dalle?: { apiKey?: string; model?: string };
    'stable-diffusion'?: { apiKey?: string; apiUrl?: string };
    gemini?: { apiKey?: string; model?: string };
  };
}

interface ConfigPayload extends ServerConfig {
  config?: ServerConfig;
}

// Hydrate client settings from the server's GET /api/config response (masked secrets become '').
function hydrateFromConfig(cfg: ServerConfig | undefined, base: SettingsData): SettingsData {
  const next: SettingsData = JSON.parse(JSON.stringify(base));
  if (cfg?.app) {
    if (typeof cfg.app.name === 'string') next.general.siteName = cfg.app.name;
    if (typeof cfg.app.timezone === 'string') next.general.timezone = cfg.app.timezone;
  }
  const coupang = cfg?.affiliates?.coupang;
  if (coupang)
    next.affiliates.coupang = {
      apiKey: coupang.apiKey ?? '',
      apiSecret: coupang.apiSecret ?? '',
      trackingId: coupang.trackingId ?? '',
    };
  const p = cfg?.platforms || {};
  if (p.tistory)
    next.platforms.tistory = {
      blogName: p.tistory.blogName ?? '',
      username: p.tistory.username ?? '',
      apiKey: p.tistory.apiKey ?? '',
    };
  if (p.wordpress)
    next.platforms.wordpress = {
      url: p.wordpress.url ?? '',
      username: p.wordpress.username ?? '',
      appPassword: p.wordpress.appPassword ?? '',
    };
  if (p['youtube-shorts'])
    next.platforms.youtube = {
      clientId: p['youtube-shorts'].clientId ?? '',
      clientSecret: p['youtube-shorts'].clientSecret ?? '',
    };
  if (p.naver)
    next.platforms.naver = {
      blogId: p.naver.blogId ?? '',
      username: p.naver.username ?? '',
      password: p.naver.password ?? '',
      clientId: p.naver.clientId ?? '',
      clientSecret: p.naver.clientSecret ?? '',
    };
  const ip = cfg?.imageProviders || {};
  if (ip.dalle)
    next.imageProviders.dalle = {
      apiKey: ip.dalle.apiKey ?? '',
      model: ip.dalle.model ?? 'dall-e-3',
    };
  if (ip['stable-diffusion'])
    next.imageProviders.stableDiffusion = {
      apiKey: ip['stable-diffusion'].apiKey ?? '',
      apiUrl: ip['stable-diffusion'].apiUrl ?? 'https://api.stability.ai',
    };
  const llm = cfg?.llm;
  if (llm)
    next.llm = {
      provider: llm.provider ?? 'gemini',
      // '***' 센티널 왕복: GET /api/config는 설정된 키를 '***'로 마스킹해 내려온다.
      // 마스킹 값을 그대로 상태에 두어 저장 시 PUT llm.apiKey='***'가 되고,
      // mergeConfig는 '***'를 스킵하므로 저장된 키가 보존된다.
      // (''로 치환하면 무수정 저장이 실제 키를 지우게 되므로 금지.)
      apiKey: llm.apiKey && llm.apiKey !== '' ? '***' : '',
      model: llm.model ?? 'gemini-1.5-pro',
      baseUrl: llm.baseUrl ?? '',
    };
  if (ip.gemini)
    next.imageProviders.gemini = {
      apiKey: ip.gemini.apiKey ?? '',
      model: ip.gemini.model ?? 'gemini-1.5-pro',
    };
  return next;
}

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData>(defaultSettings);
  const [saving, setSaving] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('general');
  const [validatingLlm, setValidatingLlm] = useState(false);
  const selectedLlmOption = LLM_PROVIDER_OPTIONS.find((o) => o.value === settings.llm.provider);
  const [llmModels, setLlmModels] = useState<string[]>([]);
  const [llmModelsError, setLlmModelsError] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);

  // 프로바이더가 실제 제공하는 모델 목록 조회. 키 미저장/조회 실패 시 서버의
  // error 힌트를 그대로 표시하고, 목록이 비면 기존 자유 입력 Input으로 폴백한다.
  const loadLlmModels = async (provider: string) => {
    if (!provider) return;
    setLoadingModels(true);
    try {
      const res = await api.get('/api/llm/models', { params: { provider } });
      const data = res.data as { models?: string[]; error?: string };
      setLlmModels(Array.isArray(data.models) ? data.models : []);
      setLlmModelsError(data.error || '');
    } catch {
      setLlmModels([]);
      setLlmModelsError('모델 목록을 조회할 수 없습니다.');
    } finally {
      setLoadingModels(false);
    }
  };

  // 마운트 시 1회(저장된 키가 있으면 목록 로드, 없으면 서버의 힌트 error가 내려옴) +
  // 프로바이더 변경 시마다 재조회.
  useEffect(() => {
    void loadLlmModels(settings.llm.provider);
  }, [settings.llm.provider]);

  useEffect(() => {
    // Source of truth is the server; fall back to localStorage/defaults if unreachable.
    (async () => {
      try {
        const res = await api.get('/api/config');
        const raw = res.data as ConfigPayload | null;
        const cfg = raw?.config || raw;
        if (cfg) {
          setSettings(hydrateFromConfig(cfg, defaultSettings));
          return;
        }
      } catch {
        // ignore, fall back below
      }
      const saved = localStorage.getItem('blog-poster-settings');
      if (saved) {
        try {
          setSettings({ ...defaultSettings, ...JSON.parse(saved) });
        } catch {
          // ignore malformed cache
        }
      }
    })();
  }, []);

  const handleSave = async (section: keyof SettingsData) => {
    setSaving(section);
    try {
      const payload = toServerPayload(section, settings);
      await api.put('/api/config', payload);
      localStorage.setItem('blog-poster-settings', JSON.stringify(settings));
      toast({ title: '저장됨', description: `${section} 설정이 저장되었습니다.` });
    } catch {
      toast({ title: '오류', description: '저장에 실패했습니다.', variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const handleChange = (section: string, field: string, value: string) => {
    setSettings((prev) => {
      const next: SettingsData = JSON.parse(JSON.stringify(prev));
      const parts = String(section).split('.');
      let cursor: Record<string, unknown> = next as unknown as Record<string, unknown>;

      for (let i = 0; i < parts.length - 1; i++) {
        cursor[parts[i]] = cursor[parts[i]] ? { ...cursor[parts[i]] } : {};
        cursor = cursor[parts[i]] as Record<string, unknown>;
      }
      const last = parts[parts.length - 1];
      cursor[last] = { ...(cursor[last] || {}), [field]: value };
      return next;
    });
  };

  // 프로바이더 변경: provider 교체 + (필요하면) 모델/baseUrl을 새 프로바이더 기본 값으로 정리.
  const handleProviderChange = (v: string) => {
    handleChange('llm', 'provider', v);
    const nextOpt = LLM_PROVIDER_OPTIONS.find((o) => o.value === v);
    const prevOpt = LLM_PROVIDER_OPTIONS.find((o) => o.value === settings.llm.provider);
    // 모델이 비었거나 이전 프로바이더의 기본 모델이면 새 기본 모델로 교체.
    if (nextOpt && (!settings.llm.model || settings.llm.model === prevOpt?.defaultModel)) {
      handleChange('llm', 'model', nextOpt.defaultModel);
    }
    // baseUrl이 다른 프로바이더의 기본 URL이면 리셋('' = 프로바이더 기본 사용).
    if (nextOpt && settings.llm.baseUrl) {
      const stale = LLM_PROVIDER_OPTIONS.some(
        (o) => o.value !== v && o.defaultBaseUrl === settings.llm.baseUrl,
      );
      if (stale) handleChange('llm', 'baseUrl', '');
    }
  };

  const handleValidateLlm = async () => {
    setValidatingLlm(true);
    try {
      const res = await api.post('/api/llm/validate', {
        // 폼에 입력 중인 값으로 검증한다(저장 전 테스트). '***'는 마스킹 센티널이므로
        // 생략해 서버가 저장된 키를 사용하도록 한다.
        provider: settings.llm.provider,
        apiKey: settings.llm.apiKey === '***' ? undefined : settings.llm.apiKey.trim(),
        model: settings.llm.model,
        baseUrl: settings.llm.baseUrl,
      });
      const result = res.data as { ok: boolean; model?: string; error?: string };
      if (result.ok) {
        toast({
          title: '연결 성공',
          description: result.model ? `모델: ${result.model}` : 'LLM 연결이 정상입니다.',
        });
      } else {
        toast({
          title: '연결 실패',
          description: result.error || '알 수 없는 오류',
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: '연결 실패',
        description: '서버에 연결할 수 없습니다.',
        variant: 'destructive',
      });
    } finally {
      setValidatingLlm(false);
    }
  };

  const renderInput = (
    section: string,
    field: string,
    label: string,
    type: string = 'text',
    placeholder = '',
  ) => (
    <div className="space-y-1">
      <Label htmlFor={field}>{label}</Label>
      <Input
        id={field}
        type={type}
        value={String(getNested(settings, String(section).split('.').concat(field)) ?? '')}
        onChange={(e) => handleChange(section, field, e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">설정</h1>
          <p className="text-muted-foreground">시스템 설정을 관리하세요</p>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="general">
            <Globe className="h-4 w-4 mr-2" />
            일반
          </TabsTrigger>
          <TabsTrigger value="affiliates">
            <Key className="h-4 w-4 mr-2" />
            제휴 네트워크
          </TabsTrigger>
          <TabsTrigger value="platforms">
            <Globe className="h-4 w-4 mr-2" />
            블로그 플랫폼
          </TabsTrigger>
          <TabsTrigger value="images">
            <Shield className="h-4 w-4 mr-2" />
            이미지 생성
          </TabsTrigger>
          <TabsTrigger value="llm">
            <Sparkles className="h-4 w-4 mr-2" />
            AI 글쓰기 (LLM)
          </TabsTrigger>
          <TabsTrigger value="notifications">
            <Bell className="h-4 w-4 mr-2" />
            알림
          </TabsTrigger>
          <TabsTrigger value="database">
            <Database className="h-4 w-4 mr-2" />
            데이터베이스
          </TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>일반 설정</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('general', 'siteName', '사이트 이름', 'text', 'Blog Auto Poster')}
              <div className="space-y-1">
                <Label>시간대</Label>
                <Select
                  value={settings.general.timezone}
                  onValueChange={(v) => handleChange('general', 'timezone', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Asia/Seoul">Asia/Seoul (한국)</SelectItem>
                    <SelectItem value="UTC">UTC</SelectItem>
                    <SelectItem value="America/New_York">America/New_York</SelectItem>
                    <SelectItem value="Europe/London">Europe/London</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>언어</Label>
                <Select
                  value={settings.general.language}
                  onValueChange={(v) => handleChange('general', 'language', v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ko">한국어</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('general')} disabled={saving === 'general'}>
            {saving === 'general' ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="affiliates" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>쿠팡 파트너스</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('affiliates.coupang', 'apiKey', 'API Key', 'password', '••••••••')}
              {renderInput('affiliates.coupang', 'apiSecret', 'API Secret', 'password', '••••••••')}
              {renderInput(
                'affiliates.coupang',
                'trackingId',
                'Tracking ID (subId)',
                'text',
                'your-tracking-id',
              )}
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('affiliates')} disabled={saving === 'affiliates'}>
            {saving === 'affiliates' ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="platforms" className="mt-4 space-y-4">
          {['tistory', 'wordpress', 'youtube'].map((platform) => (
            <Card key={platform}>
              <CardHeader>
                <CardTitle>
                  {platform === 'tistory'
                    ? '티스토리'
                    : platform === 'wordpress'
                      ? '워드프레스'
                      : '유튜브 쇼츠'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {Object.keys(settings.platforms[platform as keyof typeof settings.platforms]).map(
                  (field) =>
                    renderInput(
                      `platforms.${platform}`,
                      field,
                      field,
                      field.includes('Password') || field.includes('Secret') ? 'password' : 'text',
                    ),
                )}
              </CardContent>
            </Card>
          ))}

          <Card>
            <CardHeader>
              <CardTitle>네이버 블로그</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput(
                'platforms.naver',
                'blogId',
                '네이버 블로그 ID',
                'text',
                'your-naver-blog',
              )}
              {renderInput('platforms.naver', 'username', '아이디', 'text')}
              {renderInput('platforms.naver', 'password', '비밀번호', 'password')}
              {renderInput('platforms.naver', 'clientId', 'Client ID', 'text')}
              {renderInput('platforms.naver', 'clientSecret', 'Client Secret', 'password')}
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('platforms')} disabled={saving === 'platforms'}>
            {saving === 'platforms' ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="images" className="mt-4 space-y-4">
          {['dalle', 'stableDiffusion', 'gemini'].map((provider) => (
            <Card key={provider}>
              <CardHeader>
                <CardTitle>
                  {provider === 'dalle'
                    ? 'DALL-E'
                    : provider === 'stableDiffusion'
                      ? 'Stable Diffusion'
                      : 'Gemini'}
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {Object.keys(
                  settings.imageProviders[provider as keyof typeof settings.imageProviders],
                ).map((field) =>
                  renderInput(
                    `imageProviders.${provider}`,
                    field,
                    field,
                    field.includes('Key') ? 'password' : 'text',
                  ),
                )}
              </CardContent>
            </Card>
          ))}
          <Button
            onClick={() => handleSave('imageProviders')}
            disabled={saving === 'imageProviders'}
          >
            {saving === 'imageProviders' ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="llm" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>AI 글쓰기 (LLM)</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1">
                <Label>프로바이더</Label>
                <Select
                  id="provider"
                  value={settings.llm.provider}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  {!settings.llm.provider && (
                    <option value="" disabled>
                      프로바이더 선택
                    </option>
                  )}
                  {LLM_PROVIDER_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <Label htmlFor="model">모델</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={() => loadLlmModels(settings.llm.provider)}
                    disabled={loadingModels}
                  >
                    {loadingModels ? (
                      <Loader2 className="h-3 w-3 animate-spin mr-1" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1" />
                    )}
                    새로고침
                  </Button>
                </div>
                {llmModels.length > 0 ? (
                  <Select
                    id="model"
                    value={settings.llm.model}
                    disabled={loadingModels}
                    onChange={(e) => handleChange('llm', 'model', e.target.value)}
                  >
                    {/* 저장된 값이 목록에 없어도 셀렉트에 렌더되도록 보존한다. */}
                    {settings.llm.model && !llmModels.includes(settings.llm.model) && (
                      <option value={settings.llm.model}>{settings.llm.model}</option>
                    )}
                    {llmModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    id="model"
                    type="text"
                    disabled={loadingModels}
                    value={String(settings.llm.model ?? '')}
                    onChange={(e) => handleChange('llm', 'model', e.target.value)}
                    placeholder={
                      LLM_PROVIDER_OPTIONS.find((o) => o.value === settings.llm.provider)
                        ?.defaultModel ?? 'gemini-1.5-pro'
                    }
                  />
                )}
                {llmModelsError && (
                  <p className="text-xs text-muted-foreground">{llmModelsError}</p>
                )}
              </div>
              <div>
                {renderInput('llm', 'apiKey', 'API Key', 'password', '••••••••')}
                {/* '***'는 서버가 마스킹한 저장된 키. 변경할 때만 새 키를 입력하면 된다. */}
                {settings.llm.apiKey === '***' && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    저장된 키가 있습니다(변경 시에만 새 키 입력)
                  </p>
                )}
              </div>
              <div>
                {renderInput(
                  'llm',
                  'baseUrl',
                  'Base URL',
                  'text',
                  selectedLlmOption?.defaultBaseUrl || '기본 URL 사용',
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  OpenRouter/Anthropic 등 OpenAI 호환 엔드포인트. 비워두면 프로바이더 기본 값을
                  사용합니다.
                </p>
              </div>
              {settings.llm.provider === 'openrouter' && (
                <p className="md:col-span-2 text-xs text-muted-foreground">
                  OpenRouter 모델은 vendor-prefixed 슬러그(예: openai/gpt-4o-mini,
                  anthropic/claude-3.5-sonnet)로 입력하세요.
                </p>
              )}
            </CardContent>
          </Card>
          <div className="flex gap-2">
            <Button onClick={() => handleSave('llm')} disabled={saving === 'llm'}>
              {saving === 'llm' ? (
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              저장
            </Button>
            <Button variant="outline" onClick={handleValidateLlm} disabled={validatingLlm}>
              {validatingLlm ? (
                <RefreshCw className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Sparkles className="h-4 w-4 mr-2" />
              )}
              연결 테스트
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>알림 설정</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('notifications', 'email', '이메일', 'email', 'admin@example.com')}
              {renderInput(
                'notifications',
                'slackWebhook',
                'Slack Webhook URL',
                'text',
                'https://hooks.slack.com/services/...',
              )}
              {renderInput(
                'notifications',
                'discordWebhook',
                'Discord Webhook URL',
                'text',
                'https://discord.com/api/webhooks/...',
              )}
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('notifications')} disabled={saving === 'notifications'}>
            {saving === 'notifications' ? (
              <RefreshCw className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="database" className="mt-4 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>데이터베이스 관리</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant="outline">
                  <Database className="h-4 w-4 mr-2" />
                  백업 다운로드
                </Button>
                <Button variant="outline">
                  <Upload className="h-4 w-4 mr-2" />
                  백업 복원
                </Button>
                <Button variant="destructive">
                  <Trash2 className="h-4 w-4 mr-2" />
                  데이터 초기화
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                SQLite 데이터베이스 파일: ./data/jobs.sqlite
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
