import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countDisclosures,
  DISCLOSURE_TEXT,
  ensureDisclosure,
  stripDisclosures,
} from '../../src/content/Disclosure';
import {
  summarizePublishedPost,
  inspectPublishedComponents,
} from '../../src/platforms/naver/PublishedPostInspector';

/**
 * 고지 문구 단일 출처 (설계 §3-5).
 *
 * 문구의 출처는 `src/content/Disclosure.ts` 하나다 — 템플릿 6종, 미리보기,
 * 발행물 검사기가 모두 같은 상수를 본다.
 */
const templatesDir = fileURLToPath(new URL('../../templates', import.meta.url));

const body = '<div class="wrap"><p>본문 첫 문단</p><h2>섹션</h2><p>본문</p></div>';

describe('DISCLOSURE_TEXT — 단일 상수', () => {
  it('문구 자체가 판별식에 걸린다(검사기·게이트가 같은 문구를 본다)', () => {
    expect(countDisclosures(`<p>${DISCLOSURE_TEXT}</p>`)).toBe(1);
    expect(DISCLOSURE_TEXT).toContain('쿠팡 파트너스 활동');
  });

  it('PublishedPostInspector가 같은 문구를 고지로 센다', () => {
    const html = `<div class="se-main-container"><div class="se-component se-text"><p>${DISCLOSURE_TEXT}</p></div></div>`;
    const summary = summarizePublishedPost(html, inspectPublishedComponents(html));
    expect(summary.disclosureCount).toBe(1);
  });

  it('문구 변형(이전 템플릿 기본값)도 같은 고지로 센다', () => {
    const legacy =
      '이 포스트는 쿠팡 파트너스 활동의 일환으로, 일정액의 수수료를 제공받을 수 있습니다.';
    expect(countDisclosures(`<p>${legacy}</p>`)).toBe(1);
  });
});

describe('ensureDisclosure', () => {
  it('광고가 있으면 본문 첫 블록에 정확히 1회 넣는다', () => {
    const html = ensureDisclosure(body, true);
    expect(countDisclosures(html)).toBe(1);
    expect(html).toContain(DISCLOSURE_TEXT);
    // 첫 블록 앞
    expect(html.indexOf(DISCLOSURE_TEXT)).toBeLessThan(html.indexOf('본문 첫 문단'));
  });

  it('광고가 없으면 0회다', () => {
    const html = ensureDisclosure(body, false);
    expect(countDisclosures(html)).toBe(0);
    expect(html).not.toContain('쿠팡 파트너스');
  });

  it('두 번 적용해도 1회다(멱등)', () => {
    const once = ensureDisclosure(body, true);
    const twice = ensureDisclosure(once, true);
    expect(countDisclosures(twice)).toBe(1);
    expect(twice).toBe(once);
  });

  it('광고가 사라지면 이전 자동 고지도 지운다', () => {
    const html = ensureDisclosure(body, true);
    expect(countDisclosures(ensureDisclosure(html, false))).toBe(0);
  });
});

describe('stripDisclosures — 템플릿 기본 고지 제거', () => {
  it('상단·하단 두 가지 변형을 모두 지운다', () => {
    const html = [
      '<div class="cbg-wrap">',
      '<div class="cbg-disclosure">이 포스트는 쿠팡 파트너스 활동의 일환으로, 일정액의 수수료를 제공받을 수 있습니다.</div>',
      '<p>본문</p>',
      '<div class="cbg-notice"><small>※ 이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</small></div>',
      '</div>',
    ].join('');
    const stripped = stripDisclosures(html);
    expect(countDisclosures(stripped)).toBe(0);
    expect(stripped).toContain('<p>본문</p>');
    expect(stripped).not.toContain('cbg-notice');
  });

  it('본문에 섞인 "쿠팡 파트너스" 언급은 지우지 않는다', () => {
    const html =
      '<p>쿠팡 파트너스 활동 여부와 무관하게 이 제품은 겨울철에 잘 어울립니다. 소재를 확인하세요.</p>';
    expect(stripDisclosures(html)).toBe(html);
    expect(countDisclosures(html)).toBe(0);
  });
});

describe('템플릿 6종 — 고지 문구를 더 이상 품지 않는다', () => {
  const files = readdirSync(templatesDir).filter((f) => f.endsWith('.hbs'));

  it('템플릿 파일에 고지 문구가 없다(출처는 Disclosure.ts 하나)', () => {
    expect(files.length).toBe(6);
    for (const file of files) {
      const raw = readFileSync(`${templatesDir}/${file}`, 'utf8');
      expect(raw, file).not.toMatch(/쿠팡\s*파트너스\s*활동/);
    }
  });
});
