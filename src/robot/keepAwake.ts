import { spawn, type ChildProcess } from 'child_process';
import { getLogger } from '@core/logger';

const logger = getLogger('robot');

/**
 * 슬롯 실행 동안 Mac이 잠들지 않게 `caffeinate -i -w <pid>` 자식 프로세스를 유지한다
 * (설계 §5-6). 잠든 Mac을 **깨우는** 것은 `pmset`이 한다 — 로봇은 깨어 있는 동안만
 * 개입할 수 있다.
 */
export interface KeepAwake {
  start(): void;
  stop(): void;
  isRunning(): boolean;
}

export function createKeepAwake(): KeepAwake {
  let child: ChildProcess | null = null;

  const stop = (): void => {
    if (!child) return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      logger.debug({ error: String(error) }, 'caffeinate 종료 실패');
    }
    child = null;
  };

  return {
    start: () => {
      if (child) return;
      try {
        // -i: idle sleep 방지, -w <pid>: 이 프로세스가 살아 있는 동안만 어서션 유지
        child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        child.on('exit', () => {
          child = null;
        });
        child.on('error', (error) => {
          logger.warn({ error: String(error) }, 'caffeinate 실행 실패 — 계속 진행');
          child = null;
        });
        logger.info('keepAwake 시작');
      } catch (error) {
        logger.warn({ error: String(error) }, 'caffeinate 실행 실패 — 계속 진행');
        child = null;
      }
    },
    stop,
    isRunning: () => child !== null,
  };
}
