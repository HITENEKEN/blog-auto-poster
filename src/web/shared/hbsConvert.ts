/**
 * Handlebars body <-> WYSIWYG editor HTML conversion helpers.
 *
 * Lives in src/web/shared so both the client (vite alias `@shared`) and the
 * vitest unit tests (tests/unit/hbs-convert.test.ts) can import it without
 * pulling server-only code into the bundle.
 *
 * Conversion rules:
 * - Tags (`<[^>]*>`) are preserved verbatim, so `{{...}}` inside attribute
 *   values (e.g. `src="{{imageUrl}}"`) stays a literal.
 * - Only `{{...}}` occurrences in text nodes are converted to
 *   `<span data-hbs-token="{encodeURIComponent(token)}"></span>` chips.
 * - Text-only runs of tokens that sit at block level (e.g. `{{#each pros}}`
 *   directly after `<ul>`) are additionally wrapped in
 *   `<div data-hbs-block>` so the editor's schema keeps them (a stray inline
 *   token inside a list/section would otherwise be dropped or re-wrapped).
 * - `editableToHbsBody` restores both exactly, so
 *   `editableToHbsBody(bodyToEditable(body)) === body`.
 */

const TOKEN_RE = /\{\{[^{}]*\}\}/g;

/** Token chip emitted by bodyToEditable and by the TipTap HbsToken node. */
const TOKEN_SPAN_RE = /<span\s[^>]*?data-hbs-token="([^"]*)"[^>]*?(?:\/>|>\s*<\/span>)/g;

/** Block wrapper emitted by bodyToEditable around block-level token runs. */
const BLOCK_WRAPPER_RE = /<div\s[^>]*?data-hbs-block(?:="[^"]*")?[^>]*>([\s\S]*?)<\/div>/g;

/** Elements after whose OPENING tag a text run sits in block-level context. */
const BLOCK_CONTAINER_OPEN =
  /^(?:div|section|article|aside|header|footer|main|figure|ul|ol|blockquote|table|thead|tbody|tr|pre|nav)$/i;

/** Elements after whose CLOSING tag the context is block-level. */
const BLOCK_CLOSE =
  /^(?:div|section|article|aside|header|footer|main|figure|ul|ol|li|blockquote|table|thead|tbody|tr|p|h[1-6]|hr|figcaption|pre|nav)$/i;

const OPEN_TAG_RE = /^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>$/;
const CLOSE_TAG_RE = /^<\/([a-zA-Z][a-zA-Z0-9]*)\s*>$/;
const COMMENT_RE = /^<!--[\s\S]*-->$/;

function isBlockBoundaryTag(tag: string): boolean {
  const open = OPEN_TAG_RE.exec(tag);
  if (open) return BLOCK_CONTAINER_OPEN.test(open[1] ?? '');
  const close = CLOSE_TAG_RE.exec(tag);
  if (close) return BLOCK_CLOSE.test(close[1] ?? '');
  return false; // comments, doctype, malformed fragments
}

/** True when the segment's visible content is only handlebars tokens. */
function isTokenOnlyText(text: string): boolean {
  if (!TOKEN_RE.test(text)) return false;
  TOKEN_RE.lastIndex = 0;
  return text.replace(TOKEN_RE, '').trim() === '';
}

/**
 * Convert a Handlebars template body into editor-friendly HTML.
 * Text-node `{{...}}` become token chips; tags (incl. their attribute values)
 * are passed through untouched.
 */
export function bodyToEditable(body: string): string {
  const parts = body.split(/(<[^>]*>)/g);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part.startsWith('<')) {
      out.push(part);
      continue;
    }
    const withSpans = part.replace(
      TOKEN_RE,
      (token) => `<span data-hbs-token="${encodeURIComponent(token)}"></span>`,
    );
    if (!isTokenOnlyText(part)) {
      out.push(withSpans);
      continue;
    }
    // Token-only run: wrap at block-level positions so the editor schema
    // (which only accepts blocks inside div/ul/section/...) keeps it.
    let boundary = true; // document start == top-level block context
    for (let j = i - 1; j >= 0; j--) {
      const prev = parts[j] ?? '';
      if (COMMENT_RE.test(prev)) continue; // comments are transparent
      boundary = prev.startsWith('<') ? isBlockBoundaryTag(prev) : false;
      break;
    }
    out.push(boundary ? `<div data-hbs-block="">${withSpans}</div>` : withSpans);
  }
  return out.join('');
}

/**
 * Convert editor HTML back into a Handlebars template body.
 * Token chips are restored to their original `{{...}}` text (tags untouched),
 * and the synthetic `data-hbs-block` wrappers are removed.
 */
export function editableToHbsBody(html: string): string {
  let result = html.replace(BLOCK_WRAPPER_RE, (_match, inner: string) =>
    // Inside our own wrapper only token chips, whitespace, and the paragraph
    // the editor inserted around inline content can appear.
    inner.replace(/<\/?p(?:\s[^>]*)?>/gi, ''),
  );
  result = result.replace(TOKEN_SPAN_RE, (_match, encoded: string) => decodeURIComponent(encoded));
  return result;
}

/**
 * Split a raw template file (frontmatter + body) into its exact two halves so
 * `frontmatter + body === raw`. When no frontmatter is present the whole input
 * is returned as body.
 */
export function splitRaw(raw: string): { frontmatter: string; body: string } {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { frontmatter: '', body: raw };
  const frontmatter = raw.slice(0, match[0].length);
  return { frontmatter, body: raw.slice(frontmatter.length) };
}
