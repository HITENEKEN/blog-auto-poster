import { describe, expect, it } from 'vitest';
import { isHttpUrl, isPublishableImageUrl, parseLinkInput } from '../../src/content/linkInput';

/**
 * 2026-09-07 실발행물(logNo 224404059950)에서 URL 칸에 실제로 들어 있던 스니펫.
 * 쿠팡 파트너스 "상품 이미지 배너" 삽입 코드를 통째로 붙여넣은 것이다.
 */
const REAL_BANNER_SNIPPET =
  '<a href="https://link.coupang.com/a/gQTJxrccNM" target="_blank" referrerpolicy="unsafe-url">' +
  '<img src="https://img4a.coupangcdn.com/image/affiliate/banner/14fafc22194d6f061555091522873456@2x.jpg" ' +
  'alt="[백화점 정품] Guess 게스 여성 롱 와이드 데님 청바지" width="120" height="240"></a>';

describe('parseLinkInput — URL 칸 입력 파서', () => {
  it('평범한 URL은 그대로 통과시킨다', () => {
    const parsed = parseLinkInput('  https://link.coupang.com/a/abc  ');
    expect(parsed).toEqual({
      url: 'https://link.coupang.com/a/abc',
      imageUrl: '',
      altText: '',
      fromHtml: false,
    });
  });

  it('파트너스 배너 스니펫에서 링크·이미지·상품명을 뽑는다', () => {
    const parsed = parseLinkInput(REAL_BANNER_SNIPPET);
    expect(parsed.fromHtml).toBe(true);
    expect(parsed.url).toBe('https://link.coupang.com/a/gQTJxrccNM');
    expect(parsed.imageUrl).toBe(
      'https://img4a.coupangcdn.com/image/affiliate/banner/14fafc22194d6f061555091522873456@2x.jpg',
    );
    expect(parsed.altText).toBe('[백화점 정품] Guess 게스 여성 롱 와이드 데님 청바지');
  });

  it('앵커 없이 이미지만 있는 스니펫이면 텍스트에서 첫 http URL을 찾는다', () => {
    const parsed = parseLinkInput(
      '<img src="https://cdn.example.com/b.jpg"> https://a.example.com/x',
    );
    expect(parsed.url).toBe('https://cdn.example.com/b.jpg');
    expect(parsed.imageUrl).toBe('https://cdn.example.com/b.jpg');
  });

  it('속성값의 HTML 엔티티를 되돌린다', () => {
    const parsed = parseLinkInput('<a href="https://x.example.com/?a=1&amp;b=2">go</a>');
    expect(parsed.url).toBe('https://x.example.com/?a=1&b=2');
  });

  it('빈 입력은 빈 결과를 준다', () => {
    expect(parseLinkInput('   ')).toEqual({
      url: '',
      imageUrl: '',
      altText: '',
      fromHtml: false,
    });
  });
});

describe('isHttpUrl / isPublishableImageUrl', () => {
  it('http(s)만 링크로 인정한다', () => {
    expect(isHttpUrl('https://a.example.com')).toBe(true);
    expect(isHttpUrl('http://a.example.com')).toBe(true);
    expect(isHttpUrl('#')).toBe(false);
    expect(isHttpUrl('/relative')).toBe(false);
    expect(isHttpUrl('<a href="https://a.example.com">x</a>')).toBe(false);
  });

  it('이미지는 프로토콜 상대 URL도 허용한다', () => {
    expect(isPublishableImageUrl('//cdn.example.com/a.jpg')).toBe(true);
    expect(isPublishableImageUrl('output/images/a.png')).toBe(false);
  });
});
