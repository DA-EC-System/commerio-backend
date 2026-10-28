// Nguồn và gian hàng của đơn cho báo cáo (#29). Chạy trong `withCompany` của bên gọi.
import { inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { orders } from './schema.ts';

export async function channelsOf(orderIds: readonly string[]) {
  if (orderIds.length === 0) return [];
  return getDb()
    .select({ id: orders.id, source: orders.source, shopId: orders.shopId })
    .from(orders)
    .where(inArray(orders.id, [...orderIds]));
}
