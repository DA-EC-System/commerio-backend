// Hàm nguồn cho báo cáo (#29, plan chuẩn bị 4.5): chỉ #29 viết thân ở file này, không sửa sales/index.ts.
import { notImplemented } from '../../../shared/errors/app-error.ts';
import type { OrderSource } from './payment-boundary.ts';

/** Nguồn và gian hàng của từng đơn (gian hàng trống với đơn hộp thư, đơn tạo tay). */
export async function getOrderChannels(
  _orderIds: readonly string[],
): Promise<Map<string, { source: OrderSource; shopId: string | null }>> {
  throw notImplemented('getOrderChannels', '#29');
}
