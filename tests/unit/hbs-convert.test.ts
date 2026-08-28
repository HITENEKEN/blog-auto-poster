import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bodyToEditable, editableToHbsBody, splitRaw } from '../../src/web/shared/hbsConvert';

const raw = readFileSync(
  fileURLToPath(new URL('../../templates/coupang-product-review.hbs', import.meta.url)),
  'utf8',
);

describe('hbsConvert — real template round-trip', () => {
  const { frontmatter, body } = splitRaw(raw);

  it('splits the real template into frontmatter + body', () => {
    expect(frontmatter.startsWith('---')).toBe(true);
    expect(frontmatter).toContain('name: "coupang-product-review"');
    expect(frontmatter + body).toBe(raw);
  });

  it('round-trips the real coupang-product-review body losslessly', () => {
    const editable = bodyToEditable(body);
    const restored = editableToHbsBody(editable);
    expect(restored).toBe(body);
  });

  it('emits token chips for text-node handlebars', () => {
    const editable = bodyToEditable(body);
    expect(editable).toContain('data-hbs-token=');
    // 토큰이 인코딩되어 칩 속성값으로 보관된다
    expect(editable).toContain(encodeURIComponent('{{productName}}'));
  });
});

describe('hbsConvert — attribute token preservation', () => {
  it('preserves src="{{imageUrl}}" attribute tokens verbatim', () => {
    const img = '<img src="{{imageUrl}}" alt="{{productName}} 제품 이미지" loading="lazy" />';
    const editable = bodyToEditable(img);
    // 태그 내부 속성값은 칩으로 치환되지 않고 그대로 유지된다
    expect(editable).toBe(img);
    expect(editable).not.toContain('data-hbs-token');
    expect(editableToHbsBody(editable)).toBe(img);
  });

  it('does not convert handlebars inside any tag attribute', () => {
    const tag = '<a href="{{affiliateUrl}}" class="btn btn-{{kind}}">{{text}}</a>';
    const editable = bodyToEditable(tag);
    expect(editable).toContain('href="{{affiliateUrl}}"');
    expect(editable).toContain('class="btn btn-{{kind}}"');
    // 텍스트 노드의 토큰만 칩이 된다
    expect(editable).toContain(`data-hbs-token="${encodeURIComponent('{{text}}')}"`);
    expect(editableToHbsBody(editable)).toBe(tag);
  });
});
