import { describe, expect, it } from 'vitest';
import {
  collectPublishedPostFailures,
  detectDuplicatedComponents,
  evaluatePublishedPost,
  extractImageLinkHref,
  fetchPublishedPostDocument,
  inspectPublishedComponents,
  summarizePublishedPost,
} from '../../src/platforms/naver/PublishedPostInspector';

/** SE가 실제로 직렬화하는 모양(실측 logNo 224404059950). */
const textComponent = (text: string, link?: string): string =>
  `<div class="se-component se-text se-l-default"><div class="se-module se-module-text"><p>` +
  (link ? `<a href="${link}" class="se-link __se_link">${text}</a>` : text) +
  `</p></div></div>`;

const imageComponent = (src: string, link: string): string =>
  `<div class="se-component se-image se-l-default"><div class="se-module se-module-image">` +
  `<a href="#" class="se-module-image-link${link ? '-use' : ''} se-module-image-link __se_link" ` +
  `data-linkdata="{&quot;linkUse&quot; : &quot;${link ? 'true' : 'false'}&quot;, &quot;link&quot; : &quot;${link}&quot;}">` +
  `<img src="${src}" class="se-image-resource"></a></div></div>`;

const wrap = (...components: string[]): string =>
  `<div class="se-main-container">${components.join('')}</div>`;

describe('extractImageLinkHref — SE 이미지 링크 주소 회수', () => {
  it('&quot;로 이스케이프된 data-linkdata에서 링크를 뽑는다', () => {
    expect(
      extractImageLinkHref(
        '{&quot;linkUse&quot; : &quot;true&quot;, &quot;link&quot; : &quot;https://link.coupang.com/re/A?x=1&quot;}',
      ),
    ).toBe('https://link.coupang.com/re/A?x=1');
  });

  it('링크가 없는 이미지 앵커는 빈 문자열', () => {
    expect(
      extractImageLinkHref(
        '{&quot;linkUse&quot; : &quot;false&quot;, &quot;link&quot; : &quot;&quot;}',
      ),
    ).toBe('');
  });
});

describe('inspectPublishedComponents / summarizePublishedPost', () => {
  const html = wrap(
    textComponent('본문 첫 문단'),
    imageComponent('https://blogfiles.pstatic.net/a.png', ''),
    imageComponent(
      'https://image2.coupangcdn.com/p.jpg',
      'https://link.coupang.com/re/AFFSDPWW?x=1',
    ),
    textComponent('🛒 쿠팡에서 보기', 'https://link.coupang.com/a/abc'),
  );

  it('컴포넌트를 문서 순서로 뽑는다', () => {
    const components = inspectPublishedComponents(html);
    expect(components.map((c) => c.type)).toEqual(['text', 'image', 'image', 'text']);
  });

  it('텍스트 링크와 살아있는 이미지 링크를 나눠 집계한다', () => {
    const components = inspectPublishedComponents(html);
    const summary = summarizePublishedPost(html, components);
    expect(summary.httpTextLinkCount).toBe(1);
    // 링크가 붙은 이미지 1장만 살아있는 링크로 센다(섹션 사진은 link:"" 이다).
    expect(summary.imageLinkAnchorCount).toBe(2);
    expect(summary.liveImageLinkCount).toBe(1);
    expect(summary.naverHostedImages).toBe(1);
    expect(summary.duplicated).toBe(false);
  });

  it('컨테이너 innerHTML만 넘겨도 동작한다(발행 직후 에디터 읽기 경로)', () => {
    const inner = html.replace('<div class="se-main-container">', '<div>');
    expect(inspectPublishedComponents(inner)).toHaveLength(4);
  });
});

describe('detectDuplicatedComponents — 본문 2배 발행 판정 (logNo 224404059950)', () => {
  const seq = [
    textComponent('광고 고지'),
    textComponent('제목'),
    imageComponent('https://blogfiles.pstatic.net/a.png', ''),
    textComponent('본문'),
  ];

  it('전반부와 후반부가 완전히 같으면 중복으로 본다', () => {
    const components = inspectPublishedComponents(wrap(...seq, ...seq));
    expect(components).toHaveLength(8);
    expect(detectDuplicatedComponents(components)).toBe(true);
  });

  it('정상 발행물은 중복이 아니다', () => {
    expect(detectDuplicatedComponents(inspectPublishedComponents(wrap(...seq)))).toBe(false);
  });

  it('짝수여도 내용이 다르면 중복이 아니다', () => {
    const components = inspectPublishedComponents(
      wrap(...seq, ...seq.slice(0, 3), textComponent('다른 마무리')),
    );
    expect(detectDuplicatedComponents(components)).toBe(false);
  });
});

describe('evaluatePublishedPost / collectPublishedPostFailures', () => {
  it('중복 발행과 고지 반복을 불합격으로 잡는다', () => {
    const seq = [
      textComponent('이 포스팅은 쿠팡 파트너스 활동의 일환입니다'),
      textComponent('본문'),
      textComponent('🛒 쿠팡에서 보기', 'https://link.coupang.com/a/abc'),
    ];
    const html = wrap(...seq, ...seq);
    const failures = collectPublishedPostFailures(html);
    expect(failures.join('\n')).toContain('본문이 중복 발행되지 않음');
    expect(failures.join('\n')).toContain('파트너스 고지 문구 1회');
  });

  it('살아있는 링크가 하나도 없으면 불합격', () => {
    const checks = evaluatePublishedPost(
      summarizePublishedPost(
        wrap(textComponent('상품 보기')),
        inspectPublishedComponents(wrap(textComponent('상품 보기'))),
      ),
    );
    const linkCheck = checks.find((c) => c.label.startsWith('살아있는 쿠팡 링크'));
    expect(linkCheck?.pass).toBe(false);
  });

  it('외부 호스팅 이미지를 불합격으로 잡는다', () => {
    // 광고 차단기/DNS 필터가 막는 순간 네이버가 "존재하지 않는 이미지입니다."를
    // 대신 넣는다(실측 224405221163: 쿠팡 CDN 차단 시 4회 노출).
    const html = wrap(
      textComponent('본문'),
      imageComponent('https://image2.coupangcdn.com/p.jpg', 'https://link.coupang.com/re/A?x=1'),
    );
    expect(collectPublishedPostFailures(html).join('\n')).toContain(
      '본문 이미지가 전부 네이버 호스팅',
    );
  });

  it('정상 발행물은 실패 항목이 없다', () => {
    const html = wrap(
      textComponent('이 포스팅은 쿠팡 파트너스 활동의 일환입니다'),
      textComponent('본문'),
      imageComponent('https://postfiles.pstatic.net/p.jpg', 'https://link.coupang.com/re/A?x=1'),
      textComponent('🛒 쿠팡에서 보기', 'https://link.coupang.com/a/abc'),
    );
    expect(collectPublishedPostFailures(html)).toEqual([]);
  });

  it('컴포넌트가 하나도 없으면 판정하지 않는다(읽기 실패와 구분)', () => {
    expect(collectPublishedPostFailures('<div></div>')).toEqual([]);
  });
});

describe('fetchPublishedPostDocument — frameset 추적', () => {
  it('본문이 없으면 내부 프레임을 한 번 더 가져온다', async () => {
    const calls: string[] = [];
    const get = async (url: string) => {
      calls.push(url);
      return url.includes('inner')
        ? { status: 200, body: '<div class="se-main-container">본문</div>' }
        : { status: 200, body: '<frameset><frame src="/inner?logNo=1"></frameset>' };
    };
    const doc = await fetchPublishedPostDocument('blog', '1', get);
    expect(doc.viaFrame).toBe(true);
    expect(calls[1]).toBe('https://blog.naver.com/inner?logNo=1');
  });

  it('비공개 글처럼 본문 프레임을 못 찾으면 이유를 담아 던진다', async () => {
    const get = async () => ({
      status: 200,
      body: '<html><body>로그인이 필요합니다</body></html>',
    });
    await expect(fetchPublishedPostDocument('blog', '1', get)).rejects.toThrow(/비공개 글이거나/);
  });
});
