// Tra cứu quá hạn (Documents/21 §12.4; UC-PF-03 ngoại lệ b1; plan #27 A8): mỗi 60 giây trong worker, hỏi cổng các mã
// `active` đã quá hạn không quá 24 giờ. Đã trả → ghi như webhook (`source=query`); chưa trả hoặc cổng không biết mã →
// `expired`. Gọi cổng **ngoài** giao dịch. Không giữ advisory lock: hai worker cùng hỏi một mã thì chống trùng ở DB
// (`webhook_events`, `payment_transactions` unique; `expired` chỉ đổi khi còn `active`), giá là cổng bị hỏi hai lần.
import { withCompany } from '../../../shared/db/client.ts';
import { logger } from '../../../shared/logger.ts';
import { expireLink, findOverdueLinksAnyCompany, touchLink } from '../repository/payment-links.ts';
import { loadGatewayCredentials } from './gateway-configs.ts';
import { GatewayFactory } from './gateways/index.ts';
import { type PaymentContext, verifiedPaymentHandlerOf } from './webhook-handler.ts';
import { toPayment } from './webhooks.ts';

const INTERVAL_MS = 60_000;
const BATCH = 20;
/** MoMo khuyên ≥ 30 giây cho tra cứu (#27 ground-truth D4); cổng khác 10 giây như tạo mã. */
const timeoutOf = (gateway: string) => (gateway === 'momo' ? 30_000 : 10_000);

/** Một lượt tra cứu. Lỗi của một mã (mạng, cổng) chỉ ghi log, mã giữ `active` cho lượt sau. */
export async function runOverdueQuery(ctx: PaymentContext, now: Date = new Date()): Promise<void> {
  const handler = verifiedPaymentHandlerOf(ctx);
  for (const link of await findOverdueLinksAnyCompany(now, BATCH)) {
    try {
      const credentials = await withCompany(link.companyId, () => loadGatewayCredentials(link.gateway));
      const result = credentials
        ? await GatewayFactory.of(link.gateway).queryPayment(link, credentials, AbortSignal.timeout(timeoutOf(link.gateway)))
        : 'not_found';
      await withCompany(link.companyId, async () => {
        if (typeof result === 'string') return expireLink(link.id);
        const { outcome } = await handler(toPayment(link.companyId, link.gateway, 'query', result, link));
        // Đã ghi phiếu thu thì mã đã `paid`. Còn lại (lệch tiền, trùng, thất bại): mã hết hạn, không hỏi lại mỗi phút.
        if (outcome !== 'recorded') await expireLink(link.id);
      });
    } catch (err) {
      logger.warn({ err, gateway: link.gateway, paymentCode: link.paymentCode }, 'tra cứu quá hạn lỗi, thử lại lượt sau');
      // Đẩy mã lỗi xuống cuối hàng chờ để không chiếm chỗ của mã khác trong lô.
      await withCompany(link.companyId, () => touchLink(link.id)).catch(() => undefined);
    }
  }
}

/** Việc nền của payment trong worker: một lượt mỗi 60 giây, không chồng lượt; trả hàm dừng chờ lượt đang chạy. */
export async function startPaymentBackground(ctx: PaymentContext): Promise<() => Promise<void>> {
  let running: Promise<void> | undefined;
  const timer = setInterval(() => {
    running ??= runOverdueQuery(ctx)
      .catch((err: unknown) => logger.error({ err }, 'tra cứu quá hạn lỗi'))
      .finally(() => {
        running = undefined;
      });
  }, INTERVAL_MS);
  return async () => {
    clearInterval(timer);
    await running;
  };
}
