/**
 * TipTap custom nodes for the Coupang affiliate post/template editors.
 *
 - CoupangWidget: block marker chip (`<div data-coupang-widget ...>`) that the
   server expands to real affiliate HTML at publish time (see plan §2/§6).
 - HbsToken: inline chip for a Handlebars token that appeared as a text node
   (`<span data-hbs-token="{encodeURIComponent(token)}">`, see @shared/hbsConvert).
 - StyleBlock: block atom preserving a template/post inline `<style>` block.
 - EditorImage / LinkMark: minimal img node + link mark (StarterKit has neither,
   and dropping them would destroy affiliate links and product images).
 - HtmlBlock / HtmlInline: pass-through containers that keep unknown
   `div/section/figure/...` wrappers (with class/style) and classed inline
   spans so WYSIWYG round-trips do not flatten the document layout.
 */
import { Node, Mark } from '@tiptap/core';
import { COUPANG_WIDGET_LABELS } from '@shared/coupangWidgets';

export interface CoupangWidgetProps {
  url?: string;
  text?: string;
  snippet?: string;
}

export interface WidgetClickPayload {
  kind: string;
  props: CoupangWidgetProps;
  /** Replace the widget props of the clicked node. */
  update: (props: CoupangWidgetProps) => void;
}

export interface CoupangWidgetOptions {
  onWidgetClick?: (payload: WidgetClickPayload) => void;
}

export function decodeWidgetProps(raw: unknown): CoupangWidgetProps {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw));
    if (parsed && typeof parsed === 'object') return parsed as CoupangWidgetProps;
    return {};
  } catch {
    return {};
  }
}

export function encodeWidgetProps(props: CoupangWidgetProps): string {
  return encodeURIComponent(JSON.stringify(props));
}

const CHIP_CLICK_HINT = '클릭하여 편집';

/* ==================== CoupangWidget ==================== */

export const CoupangWidget = Node.create<CoupangWidgetOptions>({
  name: 'coupangWidget',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { onWidgetClick: undefined };
  },

  addAttributes() {
    return {
      kind: { default: 'product-link' },
      props: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-coupang-widget]',
        // Must win over the generic htmlBlock div rule.
        priority: 1000,
        getAttrs: (el) => ({
          kind: el.getAttribute('data-coupang-widget') || 'product-link',
          props: el.getAttribute('data-widget-props') || '',
        }),
      },
    ];
  },

  renderHTML({ node }) {
    return [
      'div',
      {
        'data-coupang-widget': String(node.attrs.kind),
        'data-widget-props': String(node.attrs.props ?? ''),
      },
    ];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.className =
        'my-3 flex items-center gap-2 rounded-md border border-dashed border-primary/60 bg-primary/5 px-3 py-2.5 text-sm cursor-pointer select-none hover:bg-primary/10 transition-colors';

      const label = document.createElement('span');
      label.className =
        'shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-xs font-semibold text-primary';

      const summary = document.createElement('span');
      summary.className = 'min-w-0 flex-1 truncate text-xs text-muted-foreground';

      const hint = document.createElement('span');
      hint.className = 'shrink-0 text-[11px] text-muted-foreground/70';
      hint.textContent = CHIP_CLICK_HINT;

      const rerender = () => {
        const kind = String(current.attrs.kind ?? '');
        const props = decodeWidgetProps(current.attrs.props);
        label.textContent =
          COUPANG_WIDGET_LABELS[kind as keyof typeof COUPANG_WIDGET_LABELS] ?? kind;
        const detail =
          props.text ||
          props.url ||
          (props.snippet ? `snippet: ${props.snippet.slice(0, 60)}` : '') ||
          '설정되지 않음';
        summary.textContent = detail;
        dom.title = `${label.textContent} 위젯 — ${CHIP_CLICK_HINT}`;
      };
      rerender();

      dom.addEventListener('click', (event) => {
        event.stopPropagation();
        const update = (props: CoupangWidgetProps) => {
          const pos = getPos();
          const { view } = editor;
          view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              props: encodeWidgetProps(props),
            }),
          );
        };
        this.options.onWidgetClick?.({
          kind: String(current.attrs.kind ?? ''),
          props: decodeWidgetProps(current.attrs.props),
          update,
        });
      });

      return {
        dom,
        update: (next) => {
          if (next.type.name !== this.name) return false;
          current = next;
          rerender();
          return true;
        },
      };
    };
  },
});

/* ==================== HbsToken ==================== */

export const HbsToken = Node.create({
  name: 'hbsToken',
  group: 'inline',
  inline: true,
  atom: true,
  // Allow to live inside links/bold/etc. so template tokens inside
  // `<a href="...">{{this.title}}</a>` are not dropped.
  marks: '_',

  addAttributes() {
    return {
      token: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-hbs-token]',
        // Must win over the generic htmlInline span rule.
        priority: 1000,
        getAttrs: (el) => ({ token: el.getAttribute('data-hbs-token') || '' }),
      },
    ];
  },

  renderHTML({ node }) {
    return ['span', { 'data-hbs-token': String(node.attrs.token ?? '') }];
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('span');
      dom.contentEditable = 'false';
      dom.className =
        'mx-0.5 inline-block max-w-full truncate align-middle rounded bg-violet-100 px-1.5 py-0.5 font-mono text-[0.75rem] text-violet-700';

      const rerender = () => {
        const token = decodeURIComponent(String(current.attrs.token ?? ''));
        dom.textContent = token;
        dom.title = 'Handlebars 토큰 (소스 모드에서만 편집 가능)';
      };
      rerender();

      return {
        dom,
        update: (next) => {
          if (next.type.name !== this.name) return false;
          current = next;
          rerender();
          return true;
        },
      };
    };
  },
});

/* ==================== StyleBlock ==================== */

export const StyleBlock = Node.create({
  name: 'styleBlock',
  group: 'block',
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      css: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'style',
        priority: 1000,
        getAttrs: (el) => ({ css: el.textContent || '' }),
      },
    ];
  },

  renderHTML({ node }) {
    // Re-emit a real <style> element so the CSS survives editing verbatim.
    const styleEl = document.createElement('style');
    styleEl.textContent = String(node.attrs.css ?? '');
    return styleEl;
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.contentEditable = 'false';
      dom.className =
        'my-3 flex items-center gap-2 rounded-md border bg-zinc-900 px-3 py-2.5 font-mono text-xs text-green-400';

      const rerender = () => {
        const css = String(current.attrs.css ?? '');
        const lines = css ? css.split('\n').length : 0;
        dom.textContent = `CSS 스타일 블록 (${lines}줄) — WYSIWYG에서 편집되지 않음`;
      };
      rerender();

      return {
        dom,
        update: (next) => {
          if (next.type.name !== this.name) return false;
          current = next;
          rerender();
          return true;
        },
      };
    };
  },
});

/* ==================== EditorImage ==================== */

export const EditorImage = Node.create({
  name: 'editorImage',
  group: 'inline',
  inline: true,
  atom: true,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
      loading: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'img[src]',
        priority: 1000,
        getAttrs: (el) => ({
          src: el.getAttribute('src') || '',
          alt: el.getAttribute('alt') || '',
          loading: el.getAttribute('loading'),
        }),
      },
    ];
  },

  renderHTML({ node }) {
    const attrs: Record<string, string> = {
      src: String(node.attrs.src ?? ''),
      alt: String(node.attrs.alt ?? ''),
    };
    if (node.attrs.loading) attrs.loading = String(node.attrs.loading);
    return ['img', attrs];
  },

  addNodeView() {
    return ({ node }) => {
      let current = node;
      const rerenderInto = (target: HTMLElement) => {
        const src = String(current.attrs.src ?? '');
        const isToken = !src || src.includes('{{');
        if (isToken) {
          target.textContent = `🖼️ 이미지 (${src || 'src 없음'})`;
          return;
        }
        const img = document.createElement('img');
        img.src = src;
        img.alt = String(current.attrs.alt ?? '');
        if (current.attrs.loading) img.loading = 'lazy';
        img.className = 'max-w-full rounded-md';
        target.replaceChildren(img);
      };

      const isTokenSrc = () => {
        const src = String(current.attrs.src ?? '');
        return !src || src.includes('{{');
      };
      const dom = document.createElement(isTokenSrc() ? 'div' : 'img');
      if (isTokenSrc()) {
        dom.contentEditable = 'false';
        dom.className =
          'my-2 inline-flex items-center rounded-md border border-dashed border-muted-foreground/50 bg-muted/40 px-3 py-2 text-xs text-muted-foreground';
      }
      rerenderInto(dom as HTMLElement);

      return {
        dom,
        update: (next) => {
          if (next.type.name !== this.name) return false;
          current = next;
          rerenderInto(dom as HTMLElement);
          return true;
        },
      };
    };
  },
});

/* ==================== LinkMark ==================== */

export const LinkMark = Mark.create({
  name: 'link',
  inclusive: false,

  addAttributes() {
    return {
      href: { default: null },
      target: { default: null },
      rel: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'a[href]',
        getAttrs: (el) => ({
          href: el.getAttribute('href'),
          target: el.getAttribute('target'),
          rel: el.getAttribute('rel'),
        }),
      },
    ];
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs: Record<string, string> = {};
    for (const key of ['href', 'target', 'rel'] as const) {
      const value = HTMLAttributes[key] ?? (mark.attrs as Record<string, unknown>)[key];
      if (value) attrs[key] = String(value);
    }
    return ['a', attrs, 0];
  },
});

/* ==================== HtmlBlock / HtmlInline ==================== */

interface PassthroughAttrs {
  tag: string;
  class: string | null;
  style: string | null;
  hbsBlock: string | null;
}

function readPassthroughAttrs(el: HTMLElement, defaultTag: string): PassthroughAttrs {
  return {
    tag: el.tagName.toLowerCase() || defaultTag,
    class: el.getAttribute('class'),
    style: el.getAttribute('style'),
    hbsBlock: el.hasAttribute('data-hbs-block') ? (el.getAttribute('data-hbs-block') ?? '') : null,
  };
}

function buildPassthroughDom(attrs: Record<string, unknown>): HTMLElement {
  const el = document.createElement(String(attrs.tag || 'div'));
  if (typeof attrs.class === 'string' && attrs.class) el.setAttribute('class', attrs.class);
  if (typeof attrs.style === 'string' && attrs.style) el.setAttribute('style', attrs.style);
  if (attrs.hbsBlock !== null && attrs.hbsBlock !== undefined) {
    el.setAttribute('data-hbs-block', String(attrs.hbsBlock));
  }
  return el;
}

/** Keeps unknown block containers (div/section/figure/...) with class/style. */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      tag: { default: 'div' },
      class: { default: null },
      style: { default: null },
      hbsBlock: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div, section, article, aside, header, footer, main, figure, nav',
        getAttrs: (el) => readPassthroughAttrs(el, 'div'),
      },
    ];
  },

  renderHTML({ node }) {
    const el = buildPassthroughDom(node.attrs as Record<string, unknown>);
    return { dom: el, contentDOM: el };
  },
});

/** Keeps classed inline containers (span.small styled spans, small, ...). */
export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  content: 'inline*',
  marks: '_',

  addAttributes() {
    return {
      tag: { default: 'span' },
      class: { default: null },
      style: { default: null },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[class], span[style], small',
        getAttrs: (el) => {
          const { tag, class: cls, style } = readPassthroughAttrs(el, 'span');
          return { tag, class: cls, style };
        },
      },
    ];
  },

  renderHTML({ node }) {
    const attrs = node.attrs as Record<string, unknown>;
    const el = document.createElement(String(attrs.tag || 'span'));
    if (typeof attrs.class === 'string' && attrs.class) el.setAttribute('class', attrs.class);
    if (typeof attrs.style === 'string' && attrs.style) el.setAttribute('style', attrs.style);
    return { dom: el, contentDOM: el };
  },
});
