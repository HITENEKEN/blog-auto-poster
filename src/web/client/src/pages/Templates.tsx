import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Card, CardContent, CardHeader } from './ui/Card';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { Input } from './ui/Input';
import {
  FileCode,
  Eye,
  Edit3,
  Copy,
  Plus,
  Loader2,
  Save,
  Trash2,
  X,
  Monitor,
  Smartphone,
} from 'lucide-react';

interface TemplateInfo {
  filename: string;
  name: string;
  platforms: string[];
  requiredFields: string[];
  optionalFields?: string[];
  seoTitleTemplate?: string;
}

type ViewMode = 'list' | 'editor' | 'preview';

export default function Templates() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isNewTemplate, setIsNewTemplate] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [deviceView, setDeviceView] = useState<'desktop' | 'mobile'>('desktop');

  useEffect(() => {
    fetchTemplates();
  }, []);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const response = await api.get('/api/templates');
      setTemplates(response.data.templates || []);
    } catch (error) {
      console.error('Failed to fetch templates:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = async (name: string) => {
    try {
      const response = await api.get(`/api/templates/${name}`);
      setEditingName(name);
      setEditingContent(response.data.raw || '');
      setIsNewTemplate(false);
      setView('editor');
    } catch (error) {
      console.error('Failed to load template:', error);
    }
  };

  const handleNew = () => {
    setEditingName(null);
    setNewTemplateName('');
    setEditingContent(`---
name: "new-template"
platforms: ["tistory"]
requiredFields:
  - "productName"
seo:
  titleTemplate: "{{productName}} 추천"
---

<div>
<h1>{{productName}}</h1>
</div>`);
    setIsNewTemplate(true);
    setView('editor');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNewTemplate) {
        if (!newTemplateName.trim()) return;
        await api.post('/api/templates', { name: newTemplateName.trim(), content: editingContent });
      } else if (editingName) {
        await api.put(`/api/templates/${editingName}`, { content: editingContent });
      }
      setView('list');
      fetchTemplates();
    } catch (error) {
      console.error('Failed to save template:', error);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (name: string) => {
    if (!confirm(`"${name}" 템플릿을 삭제하시겠습니까?`)) return;
    try {
      await api.delete(`/api/templates/${name}`);
      fetchTemplates();
    } catch (error) {
      console.error('Failed to delete template:', error);
    }
  };

  const handleCopy = async (name: string) => {
    try {
      const response = await api.get(`/api/templates/${name}`);
      await api.post('/api/templates', {
        name: `${name}-copy`,
        content: response.data.raw,
      });
      fetchTemplates();
    } catch (error) {
      console.error('Failed to copy template:', error);
    }
  };

  const handlePreview = async (name: string) => {
    setEditingName(name);
    setPreviewLoading(true);
    setView('preview');
    try {
      const response = await api.post(`/api/templates/${name}/preview`);
      setPreviewHtml(response.data.html || `<p style="color:red;">${response.data.error}</p>`);
    } catch {
      setPreviewHtml('<p style="color:red;">미리보기 생성 실패</p>');
    } finally {
      setPreviewLoading(false);
    }
  };

  /* ==================== LIST VIEW ==================== */
  if (view === 'list') {
    return (
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">템플릿 관리</h1>
            <p className="text-muted-foreground">쿠팡 파트너스 블로그 포스트 템플릿을 관리하세요</p>
          </div>
          <Button onClick={handleNew}>
            <Plus className="h-4 w-4 mr-2" />새 템플릿
          </Button>
        </div>

        {loading ? (
          <Card>
            <CardContent className="flex items-center justify-center h-64">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </CardContent>
          </Card>
        ) : templates.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center">
              <FileCode className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-30" />
              <p>템플릿이 없습니다. 새 템플릿을 만들어보세요.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {templates.map((t) => (
              <Card key={t.filename} className="overflow-hidden hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <FileCode className="h-5 w-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <h3 className="font-semibold truncate">{t.name}</h3>
                      <Badge variant="outline" className="mt-1">
                        {t.filename}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pb-4">
                  {t.platforms?.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {t.platforms.map((p) => (
                        <Badge key={p} variant="secondary" className="text-xs capitalize">
                          {p}
                        </Badge>
                      ))}
                    </div>
                  )}
                  {t.requiredFields?.length > 0 && (
                    <div>
                      <p className="text-xs text-muted-foreground mb-1">필수 필드</p>
                      <div className="flex flex-wrap gap-1">
                        {t.requiredFields.slice(0, 5).map((f) => (
                          <span
                            key={f}
                            className="inline-block px-2 py-0.5 rounded bg-muted text-xs"
                          >
                            {f}
                          </span>
                        ))}
                        {t.requiredFields.length > 5 && (
                          <span className="text-xs text-muted-foreground">
                            +{t.requiredFields.length - 5}
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  <div className="grid grid-cols-3 gap-1.5 pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full"
                      onClick={() => handlePreview(t.name)}
                    >
                      <Eye className="h-3.5 w-3.5 mr-1" />
                      미리보기
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full"
                      onClick={() => handleEdit(t.name)}
                    >
                      <Edit3 className="h-3.5 w-3.5 mr-1" />
                      편집
                    </Button>
                    <div className="flex gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 flex-1"
                        onClick={() => handleCopy(t.name)}
                        title="복제"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="px-2 flex-1 text-destructive hover:text-destructive"
                        onClick={() => handleDelete(t.name)}
                        title="삭제"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    );
  }

  /* ==================== PREVIEW VIEW ==================== */
  if (view === 'preview') {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Eye className="h-5 w-5 text-primary" />
            미리보기: {editingName}
          </h2>
          <div className="flex items-center gap-2">
            <div className="flex border rounded-md overflow-hidden">
              <button
                className={`p-2 ${deviceView === 'desktop' ? 'bg-primary text-white' : 'bg-muted'}`}
                onClick={() => setDeviceView('desktop')}
              >
                <Monitor className="h-4 w-4" />
              </button>
              <button
                className={`p-2 ${deviceView === 'mobile' ? 'bg-primary text-white' : 'bg-muted'}`}
                onClick={() => setDeviceView('mobile')}
              >
                <Smartphone className="h-4 w-4" />
              </button>
            </div>
            <Button variant="outline" onClick={() => setView('list')}>
              <X className="h-4 w-4 mr-1" />
              닫기
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-4 bg-muted/30">
            {previewLoading ? (
              <div className="flex items-center justify-center py-24">
                <Loader2 className="h-8 w-8 animate-spin text-primary mr-3" />
                <span>렌더링 중...</span>
              </div>
            ) : (
              <div
                className={
                  deviceView === 'mobile'
                    ? 'mx-auto max-w-[375px] border rounded-lg overflow-hidden shadow-lg'
                    : 'max-w-full'
                }
                style={{ minHeight: 400 }}
              >
                <iframe
                  srcDoc={`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;padding:16px;font-family:-apple-system,sans-serif;background:#fafafa}</style></head><body>${previewHtml}</body></html>`}
                  className="w-full border-0"
                  style={{ height: deviceView === 'mobile' ? 700 : 800 }}
                  sandbox="allow-same-origin"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ==================== EDITOR VIEW ==================== */
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Edit3 className="h-5 w-5 text-primary" />
          {isNewTemplate ? '새 템플릿' : `편집: ${editingName}`}
        </h2>
        <Button variant="outline" onClick={() => setView('list')}>
          <X className="h-4 w-4 mr-1" />
          취소
        </Button>
      </div>

      {isNewTemplate && (
        <Card>
          <CardContent className="pt-6 pb-6">
            <label className="block text-sm font-medium mb-1">템플릿 이름 (영문/숫자)</label>
            <Input
              placeholder="my-custom-template"
              value={newTemplateName}
              onChange={(e) => setNewTemplateName(e.target.value.replace(/[^a-zA-Z0-9-_]/g, ''))}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 space-y-4">
          <textarea
            value={editingContent}
            onChange={(e) => setEditingContent(e.target.value)}
            spellCheck={false}
            className="w-full h-[500px] font-mono text-sm p-4 border rounded-md bg-zinc-950 text-green-400 resize-none focus:outline-none focus:ring-2 focus:ring-primary"
            placeholder="Handlebars 템플릿을 입력하세요..."
          />
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Handlebars 문법 지원: {'{{#each}}'}, {'{{#if}}'}, {'{{formatPrice price}}'} 등
            </p>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              저장
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
