import { useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Button } from '../../pages/ui/Button';
import { Input } from '../../pages/ui/Input';
import { Dialog } from '../../pages/ui/dialog';
import { COUPANG_WIDGET_LABELS } from '@shared/coupangWidgets';
import type { CoupangWidgetKind } from '@shared/coupangWidgets';
import {
  CoupangWidget,
  HbsToken,
  StyleBlock,
  EditorImage,
  LinkMark,
  HtmlBlock,
  HtmlInline,
  encodeWidgetProps,
} from './nodes';
import type { CoupangWidgetProps, WidgetClickPayload } from './nodes';

export type RichEditorMode = 'post' | 'template';

export interface RichEditorProps {
  content: string;
  onUpdate: (html: string) => void;
  mode: RichEditorMode;
  /**
   * 위젯 칩 클릭 시 호출(제공 시 내부 편집 다이얼로그 대신 위임).
   * `update(props)`로 해당 노드의 위젯 속성을 교체한다.
   */
  onWidgetEdit?: (payload: WidgetClickPayload) => void;
}
/** 링크류 위젯: url/text 입력, 임베드류: 파트너스 snippet 붙여넣기 */
const LINK_KINDS: CoupangWidgetKind[] = ['product-link', 'event-link'];

const TOOLBAR_BTN =
  'h-8 min-w-8 px-2 rounded border border-transparent text-sm text-foreground/80 hover:bg-accent hover:text-foreground data-[active=true]:bg-primary/10 data-[active=true]:text-primary';

interface WidgetDialogState {
  kind: CoupangWidgetKind;
  /** 편집 모드: 기존 노드의 props 교체 콜백. 없으면 삽입 모드. */
  update?: (props: CoupangWidgetProps) => void;
  props: CoupangWidgetProps;
}

export default function RichEditor({ content, onUpdate, mode, onWidgetEdit }: RichEditorProps) {
  const [widgetDialog, setWidgetDialog] = useState<WidgetDialogState | null>(null);
  const [widgetUrl, setWidgetUrl] = useState('');
  const [widgetText, setWidgetText] = useState('');
  const [widgetImageUrl, setWidgetImageUrl] = useState('');
  const [widgetSnippet, setWidgetSnippet] = useState('');

  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onWidgetEditRef = useRef(onWidgetEdit);
  onWidgetEditRef.current = onWidgetEdit;

  // 내보낸 html을 기록해 부모가 되돌려주는 content 에코로 커서가 리셋되지 않게 한다
  const lastEmittedRef = useRef<string>(content);

  const editor = useEditor({
    extensions: [
      StarterKit,
      CoupangWidget.configure({
        onWidgetClick: (payload) => {
          if (onWidgetEditRef.current) {
            onWidgetEditRef.current(payload);
            return;
          }
          setWidgetUrl(payload.props.url ?? '');
          setWidgetText(payload.props.text ?? '');
          setWidgetImageUrl(payload.props.imageUrl ?? '');
          setWidgetSnippet(payload.props.snippet ?? '');
          setWidgetDialog({
            kind: payload.kind as CoupangWidgetKind,
            update: payload.update,
            props: payload.props,
          });
        },
      }),
      StyleBlock,
      EditorImage,
      LinkMark,
      HtmlBlock,
      HtmlInline,
      // Handlebars 토큰 칩은 template 모드에서만 스키마에 포함
      ...(mode === 'template' ? [HbsToken] : []),
    ],
    content,
    onUpdate: ({ editor: ed }) => {
      lastEmittedRef.current = ed.getHTML();
      onUpdateRef.current(lastEmittedRef.current);
    },
  });

  // 외부 content 변경 동기화
  useEffect(() => {
    if (!editor) return;
    if (content === lastEmittedRef.current) return;
    lastEmittedRef.current = content;
    editor.commands.setContent(content, false);
  }, [content, editor]);

  if (!editor) return null;

  const insertWidgetMarker = (kind: CoupangWidgetKind, props: CoupangWidgetProps) => {
    editor
      .chain()
      .focus()
      .insertContent(
        `<div data-coupang-widget="${kind}" data-widget-props="${encodeWidgetProps(props)}"></div>`,
      )
      .run();
  };

  const openInsertDialog = (kind: CoupangWidgetKind) => {
    setWidgetUrl('');
    setWidgetText('');
    setWidgetImageUrl('');
    setWidgetSnippet('');
    setWidgetDialog({ kind, props: {} });
  };

  const handleWidgetConfirm = () => {
    if (!widgetDialog) return;
    // 링크류 위젯은 표시 텍스트가 비어 발행 시 유실되지 않도록 기본 라벨을 부여한다(이슈 #10).
    const defaultLinkText = widgetDialog.kind === 'event-link' ? '이벤트 확인하기' : '상품 보기';
    const props: CoupangWidgetProps =
      widgetDialog.kind === 'ad-banner'
        ? { url: widgetUrl.trim(), imageUrl: widgetImageUrl.trim(), text: widgetText.trim() }
        : LINK_KINDS.includes(widgetDialog.kind)
          ? { url: widgetUrl.trim(), text: widgetText.trim() || defaultLinkText }
          : { snippet: widgetSnippet };
    if (widgetDialog.update) {
      widgetDialog.update(props);
    } else {
      insertWidgetMarker(widgetDialog.kind, props);
    }
    setWidgetDialog(null);
  };

  const isLinkKind = widgetDialog ? LINK_KINDS.includes(widgetDialog.kind) : false;
  const isBannerKind = widgetDialog?.kind === 'ad-banner';
  const widgetKinds: CoupangWidgetKind[] =
    mode === 'post'
      ? [
          'product-link',
          'event-link',
          'dynamic-banner',
          'search-widget',
          'category-banner',
          'ad-banner',
        ]
      : ['product-link', 'dynamic-banner', 'search-widget', 'category-banner'];

  return (
    <div className="rounded-md border bg-background">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b p-2">
        <button
          type="button"
          className={TOOLBAR_BTN}
          data-active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
          disabled={!editor.can().toggleBold()}
          title="굵게"
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={`${TOOLBAR_BTN} italic`}
          data-active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
          disabled={!editor.can().toggleItalic()}
          title="기울임"
        >
          I
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          data-active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
          title="제목 2"
        >
          H2
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          data-active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
          title="제목 3"
        >
          H3
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          data-active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
          title="글머리표"
        >
          • 목록
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          data-active={editor.isActive('orderedList')}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
          title="번호 매기기"
        >
          1. 목록
        </button>
        <button
          type="button"
          className={TOOLBAR_BTN}
          onClick={() => editor.chain().focus().unsetMark('link').run()}
          disabled={!editor.isActive('link')}
          title="링크 해제"
        >
          링크 해제
        </button>

        <span className="mx-1 h-5 w-px bg-border" />

        {widgetKinds.map((kind) => (
          <button
            key={kind}
            type="button"
            className={`${TOOLBAR_BTN} text-primary`}
            onClick={() => openInsertDialog(kind)}
            title={`${COUPANG_WIDGET_LABELS[kind]} 삽입`}
          >
            + {COUPANG_WIDGET_LABELS[kind]}
          </button>
        ))}
      </div>

      {/* Editor body */}
      <EditorContent
        editor={editor}
        className="prose-coupang max-w-none p-4 [&_.ProseMirror]:min-h-[400px] [&_.ProseMirror]:outline-none [&_.ProseMirror]:leading-[1.9] [&_.ProseMirror_p]:my-3 [&_.ProseMirror_p]:leading-[1.9] [&_.ProseMirror_img]:max-w-full [&_.ProseMirror_h1]:text-2xl [&_.ProseMirror_h1]:font-bold [&_.ProseMirror_h1]:mt-6 [&_.ProseMirror_h1]:mb-3 [&_.ProseMirror_h2]:text-xl [&_.ProseMirror_h2]:font-bold [&_.ProseMirror_h2]:mt-6 [&_.ProseMirror_h2]:mb-3 [&_.ProseMirror_h3]:text-lg [&_.ProseMirror_h3]:font-semibold [&_.ProseMirror_h3]:mt-5 [&_.ProseMirror_h3]:mb-2 [&_.ProseMirror_ul]:list-disc [&_.ProseMirror_ul]:pl-6 [&_.ProseMirror_ul]:my-3 [&_.ProseMirror_ol]:list-decimal [&_.ProseMirror_ol]:pl-6 [&_.ProseMirror_ol]:my-3 [&_.ProseMirror_a]:text-primary [&_.ProseMirror_a]:underline"
      />

      {/* Widget insert/edit dialog */}
      <Dialog
        open={widgetDialog !== null}
        onClose={() => setWidgetDialog(null)}
        title={
          widgetDialog
            ? `${COUPANG_WIDGET_LABELS[widgetDialog.kind] ?? widgetDialog.kind}${
                widgetDialog.update ? ' 편집' : ' 삽입'
              }`
            : ''
        }
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setWidgetDialog(null)}>
              취소
            </Button>
            <Button size="sm" onClick={handleWidgetConfirm}>
              {widgetDialog?.update ? '수정' : '삽입'}
            </Button>
          </>
        }
      >
        {widgetDialog && isBannerKind ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              배너 이미지 URL과 클릭 시 이동할 링크 URL을 입력하세요. 대체텍스트는 이미지 alt로
              사용되며 캡션으로도 표시됩니다(선택).
            </p>
            <label className="block text-sm font-medium">
              이미지 URL
              <Input
                className="mt-1"
                placeholder="https://example.com/banner.jpg"
                value={widgetImageUrl}
                onChange={(e) => setWidgetImageUrl(e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium">
              링크 URL
              <Input
                className="mt-1"
                placeholder="https://link.coupang.com/..."
                value={widgetUrl}
                onChange={(e) => setWidgetUrl(e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium">
              대체텍스트·캡션 (선택)
              <Input
                className="mt-1"
                placeholder="광고 상품 배너"
                value={widgetText}
                onChange={(e) => setWidgetText(e.target.value)}
              />
            </label>
          </div>
        ) : widgetDialog && isLinkKind ? (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              쿠팡 파트너스에서 생성한 링크 URL과 표시할 텍스트를 입력하세요.
            </p>
            <label className="block text-sm font-medium">
              URL
              <Input
                className="mt-1"
                placeholder="https://link.coupang.com/..."
                value={widgetUrl}
                onChange={(e) => setWidgetUrl(e.target.value)}
              />
            </label>
            <label className="block text-sm font-medium">
              표시 텍스트
              <Input
                className="mt-1"
                placeholder="최저가 확인하기"
                value={widgetText}
                onChange={(e) => setWidgetText(e.target.value)}
              />
            </label>
          </div>
        ) : (
          widgetDialog && (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                쿠팡 파트너스에서 제공하는 위젯/배너 HTML·script 코드를 그대로 붙여넣으세요. 발행 시
                해당 위치에 치환됩니다.
              </p>
              <textarea
                className="h-40 w-full rounded-md border border-input bg-background p-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="<script src='//...'></script>"
                value={widgetSnippet}
                onChange={(e) => setWidgetSnippet(e.target.value)}
              />
            </div>
          )
        )}
      </Dialog>
    </div>
  );
}
