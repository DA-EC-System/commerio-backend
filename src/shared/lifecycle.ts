import type { Server } from 'node:http';
import { logger } from './logger.ts';

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/** Dừng êm khi Kubernetes gửi SIGTERM: đóng cổng, đóng kết nối DB, rồi mới thoát. */
export function onShutdown(processName: string, close: () => Promise<void>): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, `${processName} đang dừng`);
      close().then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, `${processName} dừng lỗi`);
          process.exit(1);
        },
      );
    });
  }
}
