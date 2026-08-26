import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/Card';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/Tabs';
import { Label } from './ui/Label';
import { Save, Shield, Bell, Database, Key, Globe, RefreshCw, Upload, Trash2 } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/Select';

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
  },
  imageProviders: {
    dalle: { apiKey: '', model: 'dall-e-3' },
    stableDiffusion: { apiKey: '', apiUrl: 'https://api.stability.ai' },
    gemini: { apiKey: '', model: 'gemini-1.5-pro' },
  },
  notifications: { email: '', slackWebhook: '', discordWebhook: '' },
};

export default function Settings() {
  const [settings, setSettings] = useState<SettingsData>(defaultSettings);
  const [saving, setSaving] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('general');

  useEffect(() => {
    // Load settings from localStorage or API
    const saved = localStorage.getItem('blog-poster-settings');
    if (saved) {
      setSettings(JSON.parse(saved));
    }
  }, []);

  const handleSave = async (section: keyof SettingsData) => {
    setSaving(section);
    try {
      const newSettings = { ...settings };
      localStorage.setItem('blog-poster-settings', JSON.stringify(newSettings));
      toast({ title: '저장됨', description: `${section} 설정이 저장되었습니다.` });
    } catch (error) {
      toast({ title: '오류', description: '저장에 실패했습니다.', variant: 'destructive' });
    } finally {
      setSaving(null);
    }
  };

  const handleChange = (section: keyof SettingsData, field: string, value: string) => {
    setSettings(prev => ({
      ...prev,
      [section]: { ...prev[section], [field]: value },
    }));
  };

  const renderInput = (section: keyof SettingsData, field: string, label: string, type: string = 'text', placeholder = '') => (
    <div className="space-y-1">
      <Label htmlFor={field}>{label}</Label>
      <Input
        id={field}
        type={type}
        value={settings[section][field as keyof typeof settings[typeof section]]}
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
          <TabsTrigger value="general"><Globe className="h-4 w-4 mr-2" />일반</TabsTrigger>
          <TabsTrigger value="affiliates"><Key className="h-4 w-4 mr-2" />제휴 네트워크</TabsTrigger>
          <TabsTrigger value="platforms"><Globe className="h-4 w-4 mr-2" />블로그 플랫폼</TabsTrigger>
          <TabsTrigger value="images"><Shield className="h-4 w-4 mr-2" />이미지 생성</TabsTrigger>
          <TabsTrigger value="notifications"><Bell className="h-4 w-4 mr-2" />알림</TabsTrigger>
          <TabsTrigger value="database"><Database className="h-4 w-4 mr-2" />데이터베이스</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle>일반 설정</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('general', 'siteName', '사이트 이름', 'text', 'Blog Auto Poster')}
              <div className="space-y-1">
                <Label>시간대</Label>
                <Select value={settings.general.timezone} onValueChange={(v) => handleChange('general', 'timezone', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
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
                <Select value={settings.general.language} onValueChange={(v) => handleChange('general', 'language', v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ko">한국어</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('general')} disabled={saving === 'general'}>
            {saving === 'general' ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="affiliates" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle>쿠팡 파트너스</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('affiliates.coupang', 'apiKey', 'API Key', 'password', '••••••••')}
              {renderInput('affiliates.coupang', 'apiSecret', 'API Secret', 'password', '••••••••')}
              {renderInput('affiliates.coupang', 'trackingId', 'Tracking ID (subId)', 'text', 'your-tracking-id')}
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('affiliates')} disabled={saving === 'affiliates'}>
            {saving === 'affiliates' ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="platforms" className="mt-4 space-y-4">
          {['tistory', 'wordpress', 'youtube'].map((platform) => (
            <Card key={platform}>
              <CardHeader><CardTitle>{platform === 'tistory' ? '티스토리' : platform === 'wordpress' ? '워드프레스' : '유튜브 쇼츠'}</CardTitle></CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {Object.keys(settings.platforms[platform as keyof typeof settings.platforms]).map((field) => (
                  renderInput(`platforms.${platform}`, field, field, field.includes('Password') || field.includes('Secret') ? 'password' : 'text')
                ))}
              </CardContent>
            </Card>
          ))}
          <Button onClick={() => handleSave('platforms')} disabled={saving === 'platforms'}>
            {saving === 'platforms' ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="images" className="mt-4 space-y-4">
          {['dalle', 'stableDiffusion', 'gemini'].map((provider) => (
            <Card key={provider}>
              <CardHeader><CardTitle>{provider === 'dalle' ? 'DALL-E' : provider === 'stableDiffusion' ? 'Stable Diffusion' : 'Gemini'}</CardTitle></CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                {Object.keys(settings.imageProviders[provider as keyof typeof settings.imageProviders]).map((field) => (
                  renderInput(`imageProviders.${provider}`, field, field, field.includes('Key') ? 'password' : 'text')
                ))}
              </CardContent>
            </Card>
          ))}
          <Button onClick={() => handleSave('imageProviders')} disabled={saving === 'imageProviders'}>
            {saving === 'imageProviders' ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="notifications" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle>알림 설정</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              {renderInput('notifications', 'email', '이메일', 'email', 'admin@example.com')}
              {renderInput('notifications', 'slackWebhook', 'Slack Webhook URL', 'text', 'https://hooks.slack.com/services/...')}
              {renderInput('notifications', 'discordWebhook', 'Discord Webhook URL', 'text', 'https://discord.com/api/webhooks/...')}
            </CardContent>
          </Card>
          <Button onClick={() => handleSave('notifications')} disabled={saving === 'notifications'}>
            {saving === 'notifications' ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
            저장
          </Button>
        </TabsContent>

        <TabsContent value="database" className="mt-4 space-y-4">
          <Card>
            <CardHeader><CardTitle>데이터베이스 관리</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Button variant="outline"><Database className="h-4 w-4 mr-2" />백업 다운로드</Button>
                <Button variant="outline"><Upload className="h-4 w-4 mr-2" />백업 복원</Button>
                <Button variant="destructive"><Trash2 className="h-4 w-4 mr-2" />데이터 초기화</Button>
              </div>
              <p className="text-sm text-muted-foreground">SQLite 데이터베이스 파일: ./data/jobs.sqlite</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
