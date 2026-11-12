// Việc nền của finance trong worker: áp dụng phiên bản cấu hình đã tới ngày (#118) mỗi 5 phút, mở lần kéo quyết toán
// cho mọi gian hàng đang hoạt động (#117) mỗi 6 giờ, chạy các lần kéo ở hàng `finance.settlement_run` (#248). Mỗi việc
// định kỳ không chồng lượt; dừng thì chờ lượt đang chạy.
import { logger } from '../../../../shared/logger.ts';
import { registerConsumer, workQueue } from '../../../core/index.ts';
import { activateDueConfigsOnce } from './config-versions.ts';
import { markOrderCancelled } from './order-settlement-state.ts';
import { pullAllShopsOnce, runSettlementJob, settlementRunQueue } from './settlement-runs.ts';
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
  // Đơn huỷ sau khi quyết toán đã về (E139 rồi huỷ): trạng thái tiền `none` sang `mismatch` (#247).
  registerConsumer('sales.order_cancelled', (e) => markOrderCancelled(e.payload.orderId), { consumer: 'finance-order-cancelled' });
  await workQueue(settlementRunQueue, (job, attempt) => runSettlementJob(ctx, job, attempt));
  const stops = [
    every(5 * 60_000, () => activateDueConfigsOnce(), 'việc nền áp dụng phiên bản cấu hình lỗi'),
    every(6 * 3_600_000, () => pullAllShopsOnce(ctx), 'việc nền kéo quyết toán lỗi'),
  ];
  return async () => {
    await Promise.all(stops.map((stop) => stop()));
  };
}
