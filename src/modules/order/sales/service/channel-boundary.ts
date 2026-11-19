// Đọc đơn cho channel (#207, #200 §18.7); xoá đơn của gian hàng bị xoá (#398). Gọi trong `withCompany` của bên gọi.
import type { ShopOrderRefs } from '../../fulfillment/index.ts';
import { countOpenOrdersOfShop, oldestOpenOrdersOfShop, orderCountsOfShops } from '../repository/orders.ts';
import { deleteShopOrderRows, findShopOrderRefs } from '../repository/shop-purge.ts';

/** Đơn có `shop_id` và yêu cầu trả có `shop_id` hoặc trỏ các đơn đó (#398). Không khoá: gian hàng đã ngắt không nhận đơn mới. */
export function shopOrderRefs(shopId: string): Promise<ShopOrderRefs> {
  return findShopOrderRefs(shopId);
}

/**
 * Xoá dòng yêu cầu trả, yêu cầu trả, dòng đơn, đơn của gian hàng (#398). Kiện của các đơn phải đã xoá trong cùng giao
 * dịch (`purgeOrderPackages` của fulfillment, gọi trước): xoá dòng đơn còn dòng kiện thì commit bị trigger kiểm bằng chặn.
 */
export function purgeShopOrders(
  refs: ShopOrderRefs,
): Promise<{ orders: number; orderLines: number; returnRequests: number; returnRequestLines: number }> {
  return deleteShopOrderRows(refs);
}

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
