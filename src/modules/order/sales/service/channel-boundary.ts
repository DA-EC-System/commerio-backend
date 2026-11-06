// Đọc đơn cho channel (#207): ngắt gian hàng chặn khi còn đơn chưa xong. Gọi trong `withCompany` của bên gọi.
import { countOpenOrdersOfShop } from '../repository/orders.ts';

/** Số đơn của gian hàng chưa `completed` hoặc `cancelled`. */
export function countOpenOrders(shopId: string): Promise<number> {
  return countOpenOrdersOfShop(shopId);
}
