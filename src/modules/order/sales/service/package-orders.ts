// Thông tin đơn cho route kiện của fulfillment (spec 199a §5.5). Fulfillment không import sales (sales đã import
// fulfillment): `order/index.ts` tiêm hàm này vào `FulfillmentContext.orderRefsOf` bằng `withContext`.
import type { PackageOrderRef } from '../../fulfillment/index.ts';
import { findOrderLines, findOrders } from '../repository/order-views.ts';
import { packageOrderRef, variantLabels } from './orders.ts';

/** Đơn của các kiện theo id đơn, số câu không theo số đơn; chạy trong `withCompany` của bên gọi. */
export async function orderRefsOf(orderIds: readonly string[]): Promise<Map<string, PackageOrderRef>> {
  const ids = [...new Set(orderIds)];
  if (!ids.length) return new Map();
  const [orders, lines] = await Promise.all([findOrders(ids), findOrderLines(ids)]);
  const labels = await variantLabels(lines.map((l) => (l.attributesLabel ? null : l.variantId)));
  return new Map(orders.map((o) => [o.id, packageOrderRef(o, lines, labels)]));
}
