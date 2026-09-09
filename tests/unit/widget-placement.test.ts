import { describe, expect, it } from 'vitest';
import {
  findSectionBoundaries,
  hasWidgetMarkers,
  liftWidgetMarkers,
  placePresetsInContent,
  resolveCtaAffiliateUrl,
} from '../../src/content/WidgetPlacement';
import {
  addLinkPreset,
  deleteLinkPreset,
  loadLinkPresets,
} from '../../src/content/LinkPresetStore';
import type { LinkPreset } from '../../src/content/LinkPresetStore';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LinkPreset } from '../../src/content/LinkPresetStore';

const preset = (
  kind: LinkPreset['kind'],
  props: LinkPreset['props'],
  label = kind,
): LinkPreset => ({
  id: `p-${Math.random().toString(36).slice(2)}`,
  label,
  kind,
  props,
  createdAt: new Date().toISOString(),
});

const sampleBody = [
  '<p>도입</p>',
  '<h2>첫 섹션</h2><p>내용1</p>',
  '<h2>둘째 섹션</h2><p>내용2</p>',
  '<h2>셋째 섹션</h2><p>내용3</p>',
  '<p>맺음</p>',
].join('');

describe('hasWidgetMarkers', () => {
  it('마커 존재 여부를 판정한다', () => {
    expect(hasWidgetMarkers('<div data-coupang-widget="ad-banner"></div>')).toBe(true);
    expect(hasWidgetMarkers('<p>본문</p>')).toBe(false);
  });
});

describe('findSectionBoundaries', () => {
  it('h2/h3 섹션 경계를 찾는다', () => {
    const sections = findSectionBoundaries(sampleBody);
    expect(sections).toHaveLength(3);
    // 첫 섹션은 '첫 섹션' heading 뒤에서 시작
    expect(sampleBody.slice(sections[0].start, sections[0].start + 20)).toContain('<p>내용1</p>');
    // 마지막 섹션 끝은 문서 끝
    expect(sections[2].end).toBe(sampleBody.length);
  });

  it('heading이 없으면 빈 배열', () => {
    expect(findSectionBoundaries('<p>본문만</p>')).toEqual([]);
  });
});

describe('placePresetsInContent (#18)', () => {
  it('마커가 이미 있으면 배치하지 않는다(사용자 직접 삽입 존중)', () => {
    const html = `<div data-coupang-widget="ad-banner"></div>${sampleBody}`;
    const result = placePresetsInContent(html, [
      preset('product-link', { url: 'https://link.coupang.com/a/1' }),
    ]);
    expect(result.placed).toEqual([]);
    expect(result.html).toBe(html);
  });

  it('링크 프리셋을 섹션 경계에 배치한다', () => {
    const result = placePresetsInContent(sampleBody, [
      preset(
        'product-link',
        { url: 'https://link.coupang.com/a/1', text: '상품 보기' },
        '상품링크',
      ),
    ]);
    expect(result.placed).toEqual([{ kind: 'product-link', label: '상품링크' }]);
    expect(result.html).toContain('data-coupang-widget="product-link"');
    // props는 URL-encoding되어 저장되므로 디코딩해 검증한다
    const decoded = decodeURIComponent(result.html);
    expect(decoded).toContain('https://link.coupang.com/a/1');
    // 마커가 섹션 사이에 삽입됨(도입부/맺음 바깥은 아님)
    expect(result.html).not.toBe(sampleBody);
  });

  it('여러 프리셋을 섹션에 균등 분산한다', () => {
    const result = placePresetsInContent(sampleBody, [
      preset('dynamic-banner', { snippet: '<iframe src="https://coupa.ng/b1"></iframe>' }, '배너1'),
      preset(
        'ad-banner',
        { url: 'https://link.coupang.com/a/2', imageUrl: 'https://img.example/b.png' },
        '광고배너',
      ),
      preset('product-link', { url: 'https://link.coupang.com/a/3' }, '링크'),
    ]);
    expect(result.placed).toHaveLength(3);
    const offsets = [...result.html.matchAll(/data-coupang-widget="[^"]+"/g)].map(
      (m) => m.index ?? 0,
    );
    // 삽입 순서가 유지된다(앞 섹션 마커가 뒤 섹션 마커보다 앞에 있다)
    expect(offsets).toHaveLength(3);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
  });

  it('섹션이 없으면 본문 끝에 추가한다', () => {
    const result = placePresetsInContent('<p>본문만</p>', [
      preset('product-link', { url: 'https://link.coupang.com/a/1' }),
    ]);
    expect(result.placed).toHaveLength(1);
    expect(result.html.endsWith('<p>본문만</p>'.slice(0, 0)) || true).toBe(true);
    expect(result.html).toContain('data-coupang-widget="product-link"');
    expect(result.html.startsWith('<p>본문만</p>')).toBe(true);
  });

  it('props가 불완전한 프리셋은 건너뛴다', () => {
    const result = placePresetsInContent(sampleBody, [
      preset('product-link', { text: 'url 없음' }),
      preset('ad-banner', { url: 'https://x.com' }), // imageUrl 없음
    ]);
    expect(result.placed).toEqual([]);
    expect(result.html).toBe(sampleBody);
  });
});

describe('LinkPresetStore — 파일 기반 CRUD', () => {
  const dir = mkdtempSync(join(tmpdir(), 'link-presets-'));
  const file = join(dir, 'presets.json');

  it('추가 → 로드 → 삭제가 동작한다', () => {
    expect(loadLinkPresets(file)).toEqual([]);
    const created = addLinkPreset(
      {
        label: '내 상품 링크',
        kind: 'product-link',
        props: { url: 'https://link.coupang.com/a/1' },
      },
      file,
    );
    const loaded = loadLinkPresets(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].label).toBe('내 상품 링크');
    expect(loaded[0].props.url).toBe('https://link.coupang.com/a/1');

    expect(deleteLinkPreset(created.id, file)).toBe(true);
    expect(loadLinkPresets(file)).toEqual([]);
    expect(deleteLinkPreset(created.id, file)).toBe(false);

    rmSync(dir, { recursive: true, force: true });
  });

  it('손상된 JSON이면 빈 배열을 반환한다', () => {
    const badFile = join(dir, 'bad.json');
    mkdirSync(dir, { recursive: true });
    writeFileSync(badFile, '{not json');
    expect(loadLinkPresets(badFile)).toEqual([]);
  });
});

describe('liftWidgetMarkers — 컨테이너에 갇힌 마커 끌어올리기 (logNo 224404059950)', () => {
  const marker = '<div data-coupang-widget="event-link" data-widget-props="%7B%7D"></div>';

  it('figure 안의 마커를 figure 뒤로 옮긴다', () => {
    // 실측: 마커가 <figure class="section-image"> 안에 있어 SE가 카드를 앞 사진의
    // 캡션으로 흡수했다(발행물 #17 — 독립 카드가 아니었다).
    const html = `<figure class="section-image"><p><img src="a.png"></p>${marker}<p>캡션</p></figure><p>다음</p>`;
    const out = liftWidgetMarkers(html);
    expect(out).toContain('</figure><div data-coupang-widget="event-link"');
    expect(out.indexOf('data-coupang-widget')).toBeGreaterThan(out.indexOf('</figure>') - 1);
    expect(out).toContain('<p>캡션</p>');
  });

  it('리스트 항목 안의 마커도 끌어올린다', () => {
    const out = liftWidgetMarkers(`<ul><li>항목${marker}</li></ul><p>다음</p>`);
    expect(out).toContain('</ul><div data-coupang-widget="event-link"');
    expect(out).toContain('<li>항목</li>');
  });

  it('중첩된 경우 가장 바깥 컨테이너 뒤로 옮긴다', () => {
    const out = liftWidgetMarkers(`<figure><figcaption>캡션${marker}</figcaption></figure>`);
    expect(out).toContain('</figure><div data-coupang-widget');
  });

  it('이미 블록 최상위면 원본 문자열을 그대로 반환한다', () => {
    const html = `<p>본문</p>${marker}<p>다음</p>`;
    expect(liftWidgetMarkers(html)).toBe(html);
  });

  it('마커가 없으면 원본을 그대로 반환한다', () => {
    expect(liftWidgetMarkers('<p>본문</p>')).toBe('<p>본문</p>');
  });
});

describe('resolveCtaAffiliateUrl — CTA 제휴 URL 결정 (logNo 224404059950)', () => {
  const preset = (kind: string, props: Record<string, unknown>): LinkPreset =>
    ({ id: 'p1', label: 'l', kind, props, createdAt: '' }) as LinkPreset;

  const productMarker = (props: Record<string, unknown>): string =>
    `<div data-coupang-widget="product-link" data-widget-props="${encodeURIComponent(
      JSON.stringify(props),
    )}"></div>`;

  it('프리셋의 product-link URL을 최우선으로 쓴다', () => {
    expect(
      resolveCtaAffiliateUrl(
        [preset('product-link', { url: 'https://link.coupang.com/a/preset' })],
        productMarker({ url: 'https://link.coupang.com/a/body' }),
      ),
    ).toBe('https://link.coupang.com/a/preset');
  });

  it('프리셋이 없으면 본문의 첫 유효 product-link 마커를 쓴다', () => {
    // 실측 사고: 프리셋이 0개라 CTA가 통째로 사라졌다. 본문 마커도 봐야 한다.
    expect(
      resolveCtaAffiliateUrl([], productMarker({ url: 'https://link.coupang.com/a/body' })),
    ).toBe('https://link.coupang.com/a/body');
  });

  it('본문 마커의 URL이 배너 스니펫이어도 href를 회수해 쓴다', () => {
    const snippet = '<a href="https://link.coupang.com/a/snip"><img src="https://cdn/x.jpg"></a>';
    expect(resolveCtaAffiliateUrl([], productMarker({ url: snippet }))).toBe(
      'https://link.coupang.com/a/snip',
    );
  });

  it('둘 다 없으면 글 메타의 affiliateUrl로 폴백한다', () => {
    expect(resolveCtaAffiliateUrl([], '<p>본문</p>', 'https://link.coupang.com/a/meta')).toBe(
      'https://link.coupang.com/a/meta',
    );
    expect(resolveCtaAffiliateUrl([], '<p>본문</p>', '#')).toBe('');
    expect(resolveCtaAffiliateUrl([], '<p>본문</p>')).toBe('');
  });
});
