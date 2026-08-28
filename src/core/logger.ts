import pino, { Logger, DestinationStream } from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getConfigManager } from './config';

let loggerInstance: Logger | null = null;

export function getLogger(name?: string): Logger {
  if (!loggerInstance) {
    initializeLogger();
  }
  const logger = loggerInstance!;
  return name ? logger.child({ module: name }) : logger;
}

function initializeLogger(): void {
  const configManager = getConfigManager();
  const logLevel = configManager.get<string>('app.logLevel', 'info');
  const logDir = path.join(configManager.get<string>('app.dataDir'), 'logs');

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const transports: DestinationStream[] = [
    {
      // stdout sink; pino lines already end with '\n', console.log semantics preserved.
      write: (msg: string) => {
        process.stdout.write(`${msg}\n`);
      },
    },
  ];

  const fileTransport = pino.destination({
    dest: path.join(logDir, 'app.log'),
    sync: false,
    minLength: 0,
  });

  transports.push(fileTransport);

  loggerInstance = pino(
    {
      level: logLevel,
      formatters: {
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      base: {
        pid: process.pid,
        hostname: os.hostname(),
      },
    },
    pino.multistream(transports),
  );

  loggerInstance.info({ logLevel, logDir }, 'Logger initialized');
}

export function setLogger(logger: Logger): void {
  loggerInstance = logger;
}

export function createChildLogger(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}

export type { Logger } from 'pino';
