import { expandCoupangWidgetsReport } from './CoupangWidgets';
import { stylePublishHtml } from './CoupangPreview';
import { inlineStyleBlocks } from './StyleInliner';
import { prepareNaverHtml } from './NaverHtml';

/**
 * 발행 변환 체인과 동일한 순서로 본문 HTML을 변환한다(이슈 #17).
 *
 * 실제 발행 경로(routes/index.ts 발행 라우트 + NaverAdapter.createPost)는:
 *   1. expandCoupangWidgets({ platform })  — 위젯 마커 → 실제 HTML
 *      (미리보기 카드는 네트워크 의존이므로 미리보기에서는 생략하고 텍스트 링크로 표시)
 *   2. stylePublishHtml                    — img max-width 등 스타일 정리
 *   3. (naver) inlineStyleBlocks           — <style> 블록 → 인라인 스타일 (#9)
 *   4. (naver) prepareNaverHtml            — script/style 제거, heading 평탄화 (#10)
 *
 * 편집 화면의 "발행 미리보기"가 이 함수를 사용해 실제 발행물과 동일한 렌더링을
 * 보장한다. AI polish는 발행 시점에만 적용되므로 미리보기에 포함하지 않는다.
 */
export function buildPublishPreviewHtml(content: string, platform: string): string {
  let html = expandCoupangWidgetsReport(content, { platform }).html;
  html = stylePublishHtml(html);
  if (platform === 'naver') {
    html = prepareNaverHtml(inlineStyleBlocks(html));
  }
  return html;
}

/**
 * 미리보기/웹 표시를 위해 로컬 이미지 src를 웹 서빙 경로로 치환한다.
 * post.html은 `output/images/...` 상대경로를 쓰고, 웹 서버는 `/output` 정적
 * 프리셋로 이 디렉터리를 서빙한다(이슈 #17, #19).
 */
export function rewriteLocalImageSrcsForWeb(html: string): string {
  return html.replace(/(\ssrc\s*=\s*")(output\/[^"]*)(")/gi, '$1/$2$3');
}
