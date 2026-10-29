// Giá vốn theo đơn cho báo cáo (#29). Gọi trong `withCompany` của bên gọi.
import { Decimal } from 'decimal.js';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { sumCogsByOrder } from '../repository/cogs.ts';

/**
 * Giá vốn của phần đã bàn giao từng đơn: Σ `quantity × unit_cost` của dòng kiện đã trừ tồn. Đơn chưa bàn giao kiện
 * nào vắng mặt trong kết quả.
 */
export async function getOrderCogs(orderIds: readonly string[]): Promise<Map<string, Decimal>> {
  requireCompanyId('getOrderCogs');
  const ids = [...new Set(orderIds)].filter(isUuid);
  if (ids.length === 0) return new Map();
  const rows = await sumCogsByOrder(ids);
  return new Map(rows.map((r) => [r.orderId, new Decimal(r.cogs)]));
}
