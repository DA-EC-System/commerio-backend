// API công khai của module `channel`: gian hàng sàn, token, ghép SKU, dữ liệu gốc sàn. Không đổi tồn.
// Module khác chỉ được import từ file này.
import { registerConsumer } from '../../core/index.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerChannelOpenApi } from './api/openapi.ts';
import { channelRouter } from './api/routes.ts';
import { logger } from '../../../shared/logger.ts';
import { markStockPending } from './service/listing-sync.ts';
import { pullAllShopsOrdersOnce } from './service/order-pull.ts';

const ORDER_PULL_MS = 5 * 60_000;

export const channelModule: ModuleDefinition = {
  name: 'channel',
  router: channelRouter,
  openapi: registerChannelOpenApi,
  // Tồn đổi thì listing chờ đẩy tồn (chỉ ghi DB, đúng một lần); lần `sync` sau mới gọi sàn, không gọi sàn trong giao dịch.
  async startBackground() {
    registerConsumer('inventory.stock_changed', (e) => markStockPending(e.payload.variantId), { consumer: 'channel-stock-push' });
    // Kéo đơn mọi gian hàng mỗi 5 phút (#105 A7), không chồng lượt; dừng thì chờ lượt đang chạy.
    let running: Promise<void> | undefined;
    const tick = () => {
      running ??= pullAllShopsOrdersOnce()
        .catch((err: unknown) => logger.error({ err }, 'việc nền kéo đơn lỗi'))
        .finally(() => {
          running = undefined;
        });
    };
    tick();
    const timer = setInterval(tick, ORDER_PULL_MS);
    return async () => {
      clearInterval(timer);
      await running;
    };
  },
};

export { getShops, type ShopRef } from './service/shops-lookup.ts';
// Cho #102 (làm mới token thất bại), #133 (sàn báo gỡ app): gọi trong `withCompany`.
export { markNeedsReauth } from './service/shops.ts';
// Cho finance kéo quyết toán (#117), tiêm qua `ctx.settlementSource` ở `src/wiring.ts`.
export { settlementPayouts, settlementTransactions, shopsToSettle } from './service/settlement-port.ts';
export type { Payout, SettlementTxn } from './service/marketplaces/index.ts';

/** Chặn tắt phân hệ Kênh bán khi đã có gian hàng (#152); `src/wiring.ts` đưa cho `platform`. */
export { hasChannelData } from './repository/shops.ts';
