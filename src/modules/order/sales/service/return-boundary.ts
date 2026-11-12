// Cổng của yêu cầu trả cho module khác (Documents/21 §11.3). Gọi trong `withCompany` của bên gọi.
import { openReturnCounts } from '../repository/order-views.ts';

/** Đơn còn yêu cầu trả mở (`requested`, `awaiting_return`, `received`); `refund_only` không tính (§20). */
export async function hasOpenReturns(orderId: string): Promise<boolean> {
  return ((await openReturnCounts([orderId])).get(orderId) ?? 0) > 0;
}
