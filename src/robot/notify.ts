import { execFile } from 'child_process';
import { getLogger } from '@core/logger';

const logger = getLogger('robot');

/**
 * macOS 알림(설계 §5-8). 문구에는 키워드·단계·결과만 넣는다 — URL·토큰·쿠키 금지.
 * 알림 실패는 실행을 막지 않는다(로그만 남긴다).
 */
export interface Notifier {
  notify(message: string, title?: string): void;
}

export const NOTIFICATION_TITLE = '블로그 로봇';

/** osascript 호출 — 실패는 삼킨다. 테스트는 이 함수를 주입하지 않고 Notifier를 대체한다. */
export function osascriptNotify(message: string, title: string = NOTIFICATION_TITLE): void {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`;
  execFile('osascript', ['-e', script], (error) => {
    if (error) logger.debug({ error: String(error) }, 'osascript notification failed');
  });
}

export function createNotifier(): Notifier {
  return { notify: (message: string, title?: string) => osascriptNotify(message, title) };
}

/** 테스트용 — 호출 기록만 남긴다. */
export function createRecordingNotifier(): Notifier & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    notify: (message: string) => {
      messages.push(message);
    },
  };
}
