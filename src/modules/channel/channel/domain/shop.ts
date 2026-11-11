// Máy trạng thái gian hàng (Documents/21 §18.1, sơ đồ C1), cùng bảng với FE `src/lib/machines/channel.ts`.
import { defineMachine } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';

export type ShopStatus = 'connecting' | 'active' | 'needs_reauth' | 'disconnected';
export type ShopAction = 'finish_setup' | 'lose_auth' | 'reconnect' | 'resume_setup' | 'disconnect';

export const shopMachine = defineMachine<ShopStatus, ShopAction>([
  { from: 'connecting', to: 'active', action: 'finish_setup', permission: 'channel.shop.connect' },
  // Từ `connecting`: seller gỡ app khi đang thiết lập (§18.1, #171).
  { from: ['connecting', 'active'], to: 'needs_reauth', action: 'lose_auth', system: true },
  { from: ['needs_reauth', 'disconnected'], to: 'active', action: 'reconnect', permission: 'channel.shop.connect' },
  // Chỉ ở BE: gian hàng chưa thiết lập xong (chưa có mốc lấy đơn) mà ngắt hoặc mất uỷ quyền thì nối lại về
  // `connecting` để chạy thiết lập, vì CHECK `shops_active_cutoff` bắt `active` phải có `order_cutoff_at`.
  { from: ['needs_reauth', 'disconnected'], to: 'connecting', action: 'resume_setup', permission: 'channel.shop.connect' },
  {
    from: ['connecting', 'active', 'needs_reauth'],
    to: 'disconnected',
    action: 'disconnect',
    permission: 'channel.shop.disconnect',
  },
]);

interface StockHoldState {
  openingStocktakeId: string | null;
  allocationStocktakeId: string | null;
  orderCutoffAt: Date | null;
  openOrdersPulledAt: Date | null;
}

/**
 * Đẩy listing tay lúc gian hàng đang giữ tồn sau thiết lập (Documents/21 §18.6.11): `open_orders` khi lượt kéo đơn còn mở
 * chưa xong (kể cả đang chờ phân hàng), `allocation` khi phiếu đầu kỳ đã ghi sổ mà chưa nhận `allocation_done` của phiếu;
 * null khi không chờ. Gian hàng chưa thiết lập (chưa có mốc) không chờ. Chờ kiểm kê xét riêng trước (`shop_awaiting_stocktake`).
 */
export function awaitingAllocation(shop: StockHoldState): 'open_orders' | 'allocation' | null {
  if (shop.orderCutoffAt !== null && shop.openOrdersPulledAt === null) return 'open_orders';
  return shop.allocationStocktakeId !== null ? 'allocation' : null;
}

/**
 * Gian hàng đang giữ tồn (#198): chỉ đẩy giá, không gửi số tồn lên sàn. Giữ khi chờ phiếu kiểm kê đầu kỳ, chờ phân hàng
 * sau khi phiếu ghi sổ (§18.6.11), hoặc chưa kéo xong đơn còn mở (A10, số đẩy phải trừ phần giữ cho đơn đó).
 */
export function holdsStock(shop: StockHoldState): boolean {
  return shop.openingStocktakeId !== null || awaitingAllocation(shop) !== null;
}

/** Nhãn "Sắp hết hạn" (§18.4): hạn uỷ quyền còn dưới 3 ngày. Access token do việc nền tự làm mới nên không tính. */
export const EXPIRING_MS = 3 * 24 * 3600_000;

/**
 * Hạn phải kết nối lại (21 §18.4, #201): hạn gần hơn trong `authExpiresAt` (hạn uỷ quyền seller chọn) và
 * `refreshExpiresAt` (Lazada: refresh token không gia hạn được). null khi không biết cả hai.
 */
export function authDeadline(authExpiresAt: Date | null, refreshExpiresAt: Date | null): Date | null {
  if (!authExpiresAt) return refreshExpiresAt;
  if (!refreshExpiresAt) return authExpiresAt;
  return authExpiresAt < refreshExpiresAt ? authExpiresAt : refreshExpiresAt;
}

/** `deadline` là `authDeadline(...)`. Gian hàng `active` còn dưới 3 ngày tới hạn đó thì bật nhãn (US-GH-12 dòng 1). */
export function tokenExpiringSoon(status: ShopStatus, deadline: Date | null, now = Date.now()): boolean {
  return status === 'active' && deadline !== null && deadline.getTime() - now < EXPIRING_MS;
}

/** Đã qua hạn uỷ quyền: làm mới không cứu được, gian hàng phải `lose_auth` (US-GH-12 dòng 2). */
export function authLapsed(deadline: Date | null, now = Date.now()): boolean {
  return deadline !== null && deadline.getTime() <= now;
}

/** Nối lại gian hàng đã có: thao tác nào, hay chỉ thay token (đang `connecting`, `active`). */
export function reconnectAction(status: ShopStatus, orderCutoffAt: Date | null): 'reconnect' | 'resume_setup' | null {
  if (status === 'connecting' || status === 'active') return null;
  return orderCutoffAt === null ? 'resume_setup' : 'reconnect';
}

/**
 * Còn đơn chưa `completed` hoặc `cancelled` thì không cho ngắt (Documents/21 §18.6.1 bước 4, #207): ngắt xong app không
 * còn nhận cập nhật từ sàn nên đơn sẽ treo. `orders` là tối đa 20 đơn cũ nhất để FE liệt kê (§18.7.8), `openOrders` là tổng.
 */
export function assertNoOpenOrders(
  openOrders: number,
  orders: readonly { id: string; code: string; externalOrderId: string | null }[],
): void {
  if (openOrders > 0) {
    throw new AppError(409, 'shop_has_open_orders', `Còn ${openOrders} đơn chưa xong. Đợi các đơn hoàn tất hoặc huỷ rồi ngắt`, {
      openOrders,
      orders,
    });
  }
}

/**
 * Năng lực của sàn do adapter khai (Documents/21 §18.4, §18.6.3). Code ngoài adapter và FE rẽ nhánh theo đây, không theo mã sàn.
 * - `listingReview`: sàn duyệt listing trước khi bán.
 * - `hideBy`: ẩn listing bằng tắt (`deactivate`) hay bằng đẩy tồn 0 (`zero_stock`).
 * - `splitLevel`: mức tách kiện sàn cho phép (`unit` từng đơn vị, `sku` theo nhóm dòng, `none` không tách).
 * - `returnWindow`: hết hạn trả hàng tính bằng số ngày của gian hàng (`days`, cần `returnWindowDays`) hay theo trạng thái sàn.
 */
export interface ShopCapabilities {
  listingReview: boolean;
  hideBy: 'deactivate' | 'zero_stock';
  splitLevel: 'unit' | 'sku' | 'none';
  returnWindow: 'days' | 'platform_status';
}

/**
 * Lỗi của `returnWindowDays` lúc thiết lập (Documents/21 §18.6.2), null là hợp lệ. Chỉ sàn `returnWindow = 'days'` mới kiểm;
 * không gửi thì chưa bắt buộc tới khi FE gửi trường này (luật chuyển tiếp 18.6, #200 A3).
 */
export function returnWindowError(returnWindow: ShopCapabilities['returnWindow'], days: number | null | undefined): string | null {
  if (returnWindow !== 'days' || days === null || days === undefined) return null;
  return Number.isInteger(days) && days >= 1 && days <= 60 ? null : 'Hạn trả hàng từ 1 đến 60 ngày';
}
