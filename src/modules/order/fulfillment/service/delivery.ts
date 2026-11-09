// Một chỗ thi hành tác động giao xong, giao thất bại của kiện (spec 199c §5.3, Documents/21 §11.2). Mọi đường vào
// (đồng bộ sàn, hàm bù, quét nhận hoàn) gọi trong giao dịch của bên gọi; kiện đã khoá `FOR UPDATE`. Chốt "phát một
// lần" bằng `delivery_posted_at` (D8).
import { sql } from 'drizzle-orm';
import { publishEvent } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { deliveredAmounts, type DeliveredLine, DEFAULT_FAIL_REASON } from '../domain/delivery.ts';
import {
  anotherDeliveryPosted,
  deliveryLinesOf,
  deliveryStateOf,
  orderShippingOf,
} from '../repository/delivery.ts';
import { updatePackage } from '../repository/packages.ts';

/**
 * Báo kiện giao xong cho finance (spec 199c §5.3): phát `fulfillment.package_delivered` đủ tiền, đúng một lần.
 * Trả `true` khi phát, `false` khi đã phát rồi, còn dòng hoãn trừ, hay đơn không có gian hàng (MVP chưa có đường
 * vào). Chạy trong giao dịch của bên gọi; kiện đã khoá.
 */
export async function reportDelivered(packageId: string): Promise<boolean> {
  requireCompanyId('reportDelivered');
  const state = await deliveryStateOf(packageId);
  if (!state) return false;
  // 1. Đã phát rồi (đồng bộ lại, kiện vào delivered lần hai) không phát lại.
  if (state.deliveryPostedAt !== null) return false;
  // 2. Kiện còn dòng đã ghép SKU chưa trừ tồn (không before_cutoff): hoãn, hàm bù gọi lại sau khi chốt giá vốn.
  if (state.deferred) return false;
  // 3. Đơn không có gian hàng (đơn tạo tay, MVP chưa có đường vào) không báo.
  if (state.shopId === null) {
    logger.warn({ packageId, orderId: state.orderId }, 'kiện giao xong nhưng đơn không có gian hàng, không báo finance');
    return false;
  }
  const lines = await deliveryLinesOf(packageId);
  const shipping = await orderShippingOf(state.orderId);
  // 4. Kiện đầu của đơn mang ship cấp đơn; kiện khác đã báo thì ship "0.00" (D4).
  const first = !(await anotherDeliveryPosted(state.orderId, packageId));
  const amounts = deliveredAmounts(lines, shipping, first);
  // 5. Phát sự kiện cùng giao dịch, đặt mốc phát.
  await publishEvent({
    type: 'fulfillment.package_delivered',
    aggregateId: state.orderId,
    payload: {
      packageId,
      orderId: state.orderId,
      shopId: state.shopId,
      deliveredAt: (state.deliveredAt ?? new Date()).toISOString(),
      ...amounts,
    },
  });
  await updatePackage(packageId, { deliveryPostedAt: sql`now()` });
  return true;
}

/**
 * Báo kiện giao thất bại (spec 199c §5.3): phát `fulfillment.package_delivery_failed` với lý do (mặc định
 * `DEFAULT_FAIL_REASON` khi hành trình không cho). Chạy trong giao dịch của bên gọi.
 */
export async function reportDeliveryFailed(pkg: { id: string; orderId: string }, reason: string): Promise<void> {
  await publishEvent({
    type: 'fulfillment.package_delivery_failed',
    aggregateId: pkg.orderId,
    payload: { packageId: pkg.id, orderId: pkg.orderId, reason: reason || DEFAULT_FAIL_REASON },
  });
}

export type { DeliveredLine };
