import { pino, type DestinationStream, type Logger } from 'pino';
import { env } from './config/env.ts';

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    level: env.LOG_LEVEL,
    // Không ghi token, cookie vào log.
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
      censor: '[ẩn]',
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger = createLogger();
