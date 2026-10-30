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

/**
 * Chạy `job` ngay rồi mỗi `ms`, không chồng lượt (lượt cũ chưa xong thì bỏ nhịp); lỗi chỉ ghi log. Trả hàm dừng: huỷ
 * hẹn giờ và chờ lượt đang chạy. Dùng trong `startBackground` của module.
 */
export function every(ms: number, job: () => Promise<unknown>, label: string): () => Promise<void> {
  let running: Promise<unknown> | undefined;
  const tick = () => {
    running ??= job()
      .catch((err: unknown) => logger.error({ err }, label))
      .finally(() => {
        running = undefined;
      });
  };
  tick();
  const timer = setInterval(tick, ms);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
