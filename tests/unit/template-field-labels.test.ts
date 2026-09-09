import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import {
  TEMPLATE_FIELD_LABELS,
  labelForTemplateField,
} from '../../src/web/shared/templateFieldLabels';
import { splitRaw } from '../../src/web/shared/hbsConvert';

const templatesDir = fileURLToPath(new URL('../../templates', import.meta.url));
const templateFiles = readdirSync(templatesDir).filter((f) => f.endsWith('.hbs'));

function frontmatterOf(file: string): Record<string, unknown> {
  const raw = readFileSync(`${templatesDir}/${file}`, 'utf8');
  const { frontmatter } = splitRaw(raw);
  return yaml.load(frontmatter.replace(/^---\n|\n---\n?$/g, '')) as Record<string, unknown>;
}

describe('template field labels — 이슈 #23 1-2', () => {
  it('맵에 없는 키는 영문 키를 그대로 돌려준다 (폴백)', () => {
    expect(labelForTemplateField('someBrandNewField')).toBe('someBrandNewField');
  });

  it('알려진 키는 한국어 라벨을 돌려준다', () => {
    expect(labelForTemplateField('productName')).toBe('상품명');
    expect(labelForTemplateField('conclusion')).toBe('총평');
    expect(labelForTemplateField('experienceIntro')).toBe('사용 계기');
  });

  it.each(templateFiles)('%s 의 requiredFields는 모두 라벨 맵에 존재한다', (file) => {
    const fm = frontmatterOf(file);
    const required = (fm.requiredFields as string[]) ?? [];
    const missing = required.filter((k) => !(k in TEMPLATE_FIELD_LABELS));
    expect(missing).toEqual([]);
  });
});
