import { describe, expect, it } from 'vitest';
import { validatePolishedHtml } from '../../src/content/ContentGenerator';

describe('validatePolishedHtml — 발행용 AI 다듬기 검증(이슈 #12)', () => {
  const original = [
    '<h2>제목</h2>',
    '<p>첫 문장입니다. 본문 텍스트가 충분히 길어야 검증기가 텍스트 비율을 계산할 수 있습니다. 구체적으로 사용 상황과 수치를 담은 두 번째 문장이 이어집니다.</p>',
    '<div data-coupang-widget="product-link" data-widget-props="%7B%7D"></div>',
    '<img src="https://image.example.com/a.jpg" alt="a">',
    '<a href="https://link.coupang.com/a/abc">링크</a>',
  ].join('');

  it('구조가 보존된 다듬기 결과는 통과한다', () => {
    const polished = original.replace('첫 문장입니다.', '다듬어진 첫 문장입니다.');
    expect(validatePolishedHtml(original, polished)).toBe(true);
  });

  it('위젯 마커가 유실되면 탈락시킨다', () => {
    const polished = original.replace(/ data-coupang-widget="product-link"/, '');
    expect(validatePolishedHtml(original, polished)).toBe(false);
  });

  it('링크가 유실되면 탈락시킨다', () => {
    const polished = original.replace('<a href="https://link.coupang.com/a/abc">링크</a>', '');
    expect(validatePolishedHtml(original, polished)).toBe(false);
  });

  it('이미지가 유실되면 탈락시킨다', () => {
    const polished = original.replace(/<img[^>]+>/, '');
    expect(validatePolishedHtml(original, polished)).toBe(false);
  });

  it('본문이 과도하게 삭제되면 탈락시킨다', () => {
    const polished = original
      .replace('본문 텍스트가 충분히 길어야 검증기가 텍스트 비율을 계산할 수 있습니다.', '')
      .replace('구체적으로 사용 상황과 수치를 담은 두 번째 문장이 이어집니다.', '')
      .replace('제목', '제');
    expect(validatePolishedHtml(original, polished)).toBe(false);
  });

  it('너무 짧은 결과는 탈락시킨다', () => {
    expect(validatePolishedHtml(original, '<p>짧음</p>')).toBe(false);
  });
});
