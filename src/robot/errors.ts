/** 로봇 실행 제어용 예외 — 드라이버가 이 타입으로 분기한다(설계 §5-1 드라이버 규칙 2·3·4). */

/** 정상 중단(비즈니스 사유). 드라이버가 `finish(aborted-<reason>)`로 처리한다. */
export class RobotAbort extends Error {
  constructor(
    public readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'RobotAbort';
  }
}

/** 일시적 실패(로컬 web 서버 연결 실패·5xx) — 같은 단계를 백오프 재시도한다. */
export class TransientError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'TransientError';
  }
}

/** HTTP 오류(4xx 등) — 기본적으로 재시도하지 않는다. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 종료 신호(SIGTERM/SIGINT)에 따른 중단. */
export class ShutdownError extends Error {
  constructor() {
    super('shutdown requested');
    this.name = 'ShutdownError';
  }
}

export function describeError(error: unknown): string {
  if (error instanceof RobotAbort) return `aborted-${error.reason}: ${error.message}`;
  if (error instanceof HttpError) return `HTTP ${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}
