// Việc nền của finance trong worker: áp dụng phiên bản cấu hình đã tới ngày (#118) mỗi 5 phút, kéo quyết toán của mọi
// gian hàng đang hoạt động (#117) mỗi 6 giờ. Mỗi việc không chồng lượt; dừng thì chờ lượt đang chạy.
import { logger } from '../../../../shared/logger.ts';
import { activateDueConfigsOnce } from './config-versions.ts';
import { pullAllShopsOnce } from './settlement-runs.ts';
import type { FinanceContext } from './settlement-views.ts';

function every(ms: number, job: () => Promise<unknown>, label: string) {
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

export async function startFinanceBackground(ctx: FinanceContext): Promise<() => Promise<void>> {
  const stops = [
    every(5 * 60_000, () => activateDueConfigsOnce(), 'việc nền áp dụng phiên bản cấu hình lỗi'),
    every(6 * 3_600_000, () => pullAllShopsOnce(ctx), 'việc nền kéo quyết toán lỗi'),
  ];
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}
