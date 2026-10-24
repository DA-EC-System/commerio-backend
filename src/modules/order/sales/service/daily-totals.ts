// Hàm nguồn cho báo cáo (#29). Gọi trong `withCompany` của bên gọi.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { channelsOf } from '../repository/daily-totals.ts';
import type { OrderSource } from './payment-boundary.ts';

/**
 * Nguồn và gian hàng của từng đơn; đơn không thấy (id lạ, công ty khác) vắng mặt. Gian hàng chỉ có với đơn sàn: DB
 * không chặn `shop_id` ở đơn hộp thư, đơn tay, nên ép trống ở đây để báo cáo không sinh dòng lạ.
 */
export async function getOrderChannels(
  orderIds: readonly string[],
): Promise<Map<string, { source: OrderSource; shopId: string | null }>> {
  requireCompanyId('getOrderChannels');
  return new Map(
    (await channelsOf(orderIds)).map((o) => [o.id, { source: o.source, shopId: o.source === 'marketplace' ? o.shopId : null }]),
  );
}
