import { useState, useEffect } from 'react';
import RichEditor from '../components/Editor/RichEditor';
import { bodyToEditable, editableToHbsBody, splitRaw } from '@shared/hbsConvert';
import { labelForTemplateField } from '@shared/templateFieldLabels';
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
  Code2,
  PenLine,
} from 'lucide-react';

interface TemplateInfo {
  filename: string;
  name: string;
  /** 화면 표시용 한국어 이름 (이슈 #23 1-2). 비면 name으로 폴백. */
  displayName?: string;
  description?: string;
  platforms: string[];
  requiredFields: string[];
  optionalFields?: string[];
  seoTitleTemplate?: string;
}

/** 신규 템플릿 골격은 기준 템플릿(naver-coupang-review)을 시드로 복제한다 (이슈 #23 1-3.2). */
const SEED_TEMPLATE = 'naver-coupang-review';

/** frontmatter 원문에서 최상위 스칼라 키 값을 읽는다(따옴표 제거). 없으면 ''. */
function readFmScalar(frontmatter: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.*)$`, 'm').exec(frontmatter);
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/** frontmatter 원문의 최상위 스칼라 키를 갱신한다. 없으면 name: 줄 바로 뒤에 추가.
 *  빈 값이면 해당 줄을 제거한다. frontmatter 구분자(---)는 그대로 보존한다. */
function writeFmScalar(frontmatter: string, key: string, value: string): string {
  const line = `${key}: "${value.replace(/"/g, '\\"')}"`;
  const re = new RegExp(`^${key}:\\s*.*$`, 'm');
  if (re.test(frontmatter)) {
    return value.trim()
      ? frontmatter.replace(re, line)
      : frontmatter.replace(new RegExp(`^${key}:\\s*.*\\r?\\n`, 'm'), '');
  }
  if (!value.trim()) return frontmatter;
  return frontmatter.replace(/^(name:\s*.*)$/m, `$1\n${line}`);
}

/** frontmatter 원문에서 requiredFields 목록을 읽는다. */
function readFmRequiredFields(frontmatter: string): string[] {
  const block = /^requiredFields:\s*\n((?:\s*-\s*.*\n?)*)/m.exec(frontmatter);
  if (!block) return [];
  return [...block[1].matchAll(/-\s*["']?([^"'\n]+)["']?/g)].map((m) => m[1].trim());
}

type ViewMode = 'list' | 'editor' | 'preview';

export default function Templates() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('list');
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [editMode, setEditMode] = useState<'source' | 'wysiwyg'>('wysiwyg');
  const [newTemplateName, setNewTemplateName] = useState('');
  const [wysiwygHtml, setWysiwygHtml] = useState('');
  const [isNewTemplate, setIsNewTemplate] = useState(false);
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

  /** 편집 진입은 WYSIWYG가 기본 (이슈 #23 1-3.1). frontmatter는 editingContent에
   *  원문 그대로 보존하고, body만 칩으로 변환해 에디터에 싣는다. */
  const handleEdit = async (name: string) => {
    try {
      const response = await api.get(`/api/templates/${name}`);
      const raw = response.data.raw || '';
      setEditingName(name);
      applyEditorRaw(raw);
      setEditMode('wysiwyg');
      setIsNewTemplate(false);
      setView('editor');
    } catch (error) {
      console.error('Failed to load template:', error);
    }
  };

  /** 신규 생성도 WYSIWYG로 진입하고, 골격은 기준 템플릿을 시드로 복제한다
   *  (이슈 #23 1-3.1·1-3.2). 시드의 frontmatter name은 저장 시 새 이름으로 교체된다. */
  const applyEditorRaw = (raw: string) => {
    setEditingContent(raw);
    setWysiwygHtml(bodyToEditable(splitRaw(raw).body));
  };

  const handleNew = async () => {
    setEditingName(null);
    setNewTemplateName('');
    setIsNewTemplate(true);
    setEditMode('wysiwyg');
    const skeleton = `---\nname: "new-template"\nplatforms: ["naver"]\nrequiredFields:\n  - "productName"\nseo:\n  titleTemplate: "{{productName}} 추천"\n---\n\n<div>\n<h1>{{productName}}</h1>\n</div>`;
    applyEditorRaw(skeleton);
    setView('editor');
    try {
      const response = await api.get(`/api/templates/${SEED_TEMPLATE}`);
      if (response.data.raw) applyEditorRaw(response.data.raw);
    } catch (error) {
      console.error('Failed to load seed template, keeping minimal skeleton:', error);
    }
  };

  /** WYSIWYG → 소스 전환: 프론트매터 보존 + 편집된 body 반영 */
  const switchToSource = () => {
    const { frontmatter } = splitRaw(editingContent);
    setEditingContent(frontmatter + editableToHbsBody(wysiwygHtml));
    setEditMode('source');
  };

  /** 소스 → WYSIWYG 전환: body만 편집 대상으로 로드 */
  const switchToWysiwyg = () => {
    setWysiwygHtml(bodyToEditable(splitRaw(editingContent).body));
    setEditMode('wysiwyg');
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (isNewTemplate) {
        if (!newTemplateName.trim()) return;
        const name = newTemplateName.trim();
        const body =
          editMode === 'wysiwyg' ? editableToHbsBody(wysiwygHtml) : splitRaw(editingContent).body;
        // 시드 복제분의 frontmatter name/displayName을 새 이름 기준으로 정리한다
        // (식별자 name은 파일명과 API 경로로 계속 쓰이므로 파일명과 일치해야 한다).
        const frontmatter = splitRaw(editingContent).frontmatter.replace(
          /^name:\s*.*$/m,
          `name: "${name}"`,
        );
        await api.post('/api/templates', { name, content: frontmatter + body });
      } else if (editingName) {
        const content =
          editMode === 'wysiwyg'
            ? splitRaw(editingContent).frontmatter + editableToHbsBody(wysiwygHtml)
            : editingContent;
        await api.put(`/api/templates/${editingName}`, { content });
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
                      <h3 className="font-semibold truncate">{t.displayName || t.name}</h3>
                      <Badge variant="outline" className="mt-1">
                        {t.filename}
                      </Badge>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pb-4">
                  {t.description && (
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  )}
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
                            title={f}
                          >
                            {labelForTemplateField(f)}
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

      {/* frontmatter는 WYSIWYG 대상이 아니므로 별도 폼으로 편집한다 (이슈 #23 1-3.3).
          식별자 name/플랫폼/SEO 등 나머지는 고급(소스) 모드에서 다룬다. */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <p className="text-sm font-medium">템플릿 정보</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">표시 이름 (한국어)</label>
              <Input
                placeholder="예: 네이버 쿠팡 리뷰"
                value={readFmScalar(splitRaw(editingContent).frontmatter, 'displayName')}
                onChange={(e) => {
                  const { frontmatter, body } = splitRaw(editingContent);
                  setEditingContent(
                    writeFmScalar(frontmatter, 'displayName', e.target.value) + body,
                  );
                }}
              />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">설명</label>
              <Input
                placeholder="한 줄 설명"
                value={readFmScalar(splitRaw(editingContent).frontmatter, 'description')}
                onChange={(e) => {
                  const { frontmatter, body } = splitRaw(editingContent);
                  setEditingContent(
                    writeFmScalar(frontmatter, 'description', e.target.value) + body,
                  );
                }}
              />
            </div>
          </div>
          {readFmRequiredFields(splitRaw(editingContent).frontmatter).length > 0 && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">필수 필드</p>
              <div className="flex flex-wrap gap-1">
                {readFmRequiredFields(splitRaw(editingContent).frontmatter).map((f) => (
                  <span
                    key={f}
                    className="inline-block px-2 py-0.5 rounded bg-muted text-xs"
                    title={f}
                  >
                    {labelForTemplateField(f)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-1">
            <Button
              variant={editMode === 'source' ? 'default' : 'outline'}
              size="sm"
              onClick={switchToSource}
              disabled={editMode === 'source'}
              title="토큰 칩으로 표현되지 않는 편집(주석·복잡한 블록 헬퍼)을 위한 고급 모드"
            >
              <Code2 className="mr-1 h-4 w-4" />
              고급(소스)
            </Button>
            <Button
              variant={editMode === 'wysiwyg' ? 'default' : 'outline'}
              size="sm"
              onClick={switchToWysiwyg}
              disabled={editMode === 'wysiwyg'}
              title="본문 WYSIWYG 편집 (위젯 마커 삽입 가능)"
            >
              <PenLine className="mr-1 h-4 w-4" />
              WYSIWYG
            </Button>
          </div>
          {editMode === 'source' ? (
            <textarea
              value={editingContent}
              onChange={(e) => setEditingContent(e.target.value)}
              spellCheck={false}
              className="w-full h-[500px] font-mono text-sm p-4 border rounded-md bg-zinc-950 text-green-400 resize-none focus:outline-none focus:ring-2 focus:ring-primary"
              placeholder="Handlebars 템플릿을 입력하세요..."
            />
          ) : (
            <RichEditor mode="template" content={wysiwygHtml} onUpdate={setWysiwygHtml} />
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {editMode === 'source'
                ? 'Handlebars 문법 지원: {{#each}}, {{#if}}, {{formatPrice price}} 등'
                : '본문을 필드가 아닌 WYSIWYG로 편집합니다. 표시 이름·설명은 위 “템플릿 정보” 폼에서, 나머지 frontmatter는 고급(소스) 모드에서 편집하세요.'}
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
