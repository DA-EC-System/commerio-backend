// Đọc đơn cho channel (#207, #200 §18.7). Gọi trong `withCompany` của bên gọi.
import { countOpenOrdersOfShop, oldestOpenOrdersOfShop, orderCountsOfShops } from '../repository/orders.ts';

/** Số đơn của gian hàng chưa `completed` hoặc `cancelled`. */
export function countOpenOrders(shopId: string): Promise<number> {
  return countOpenOrdersOfShop(shopId);
}

/** Đơn chưa xong (`open`, cùng cách đếm với `countOpenOrders`) và đơn đặt từ `placedSince` (`placed`) theo gian hàng. */
export function orderCountsByShop(shopIds: readonly string[], placedSince: Date): Promise<Map<string, { open: number; placed: number }>> {
  return orderCountsOfShops(shopIds, placedSince);
}

export interface OpenOrderRef {
  id: string;
  code: string;
  externalOrderId: string | null;
}

/** Tối đa `limit` đơn chưa xong của gian hàng, cũ nhất trước. */
export function oldestOpenOrders(shopId: string, limit: number): Promise<OpenOrderRef[]> {
  return oldestOpenOrdersOfShop(shopId, limit);
}
