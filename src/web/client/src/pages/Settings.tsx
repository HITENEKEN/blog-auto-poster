import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/Tabs';
import { Label } from './ui/Label';
import { Save, Shield, Bell, Database, Key, Globe, RefreshCw, Upload, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';
import { toast } from './ui/use-toast';
import { api } from '../services/api';

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
        <TabsList className="grid w-full grid-cols-6">
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
