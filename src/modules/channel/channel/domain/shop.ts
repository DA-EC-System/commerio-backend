// Máy trạng thái gian hàng (Documents/21 §18.1, sơ đồ C1), cùng bảng với FE `src/lib/machines/channel.ts`.
import { defineMachine } from '../../../core/index.ts';

export type ShopStatus = 'connecting' | 'active' | 'needs_reauth' | 'disconnected';
export type ShopAction = 'finish_setup' | 'lose_auth' | 'reconnect' | 'resume_setup' | 'disconnect';

export const shopMachine = defineMachine<ShopStatus, ShopAction>([
  { from: 'connecting', to: 'active', action: 'finish_setup', permission: 'channel.shop.connect' },
  { from: 'active', to: 'needs_reauth', action: 'lose_auth', system: true },
  { from: ['needs_reauth', 'disconnected'], to: 'active', action: 'reconnect', permission: 'channel.shop.connect' },
  // Chỉ ở BE: ngắt khi chưa thiết lập xong (chưa có mốc kéo đơn) thì nối lại về `connecting` để chạy thiết lập.
  { from: 'disconnected', to: 'connecting', action: 'resume_setup', permission: 'channel.shop.connect' },
  {
    from: ['connecting', 'active', 'needs_reauth'],
    to: 'disconnected',
    action: 'disconnect',
    permission: 'channel.shop.disconnect',
  },
]);

/** Nhãn "Sắp hết hạn" (§18.4): refresh token còn dưới 3 ngày. Access token do #102 tự làm mới nên không tính. */
export const EXPIRING_MS = 3 * 24 * 3600_000;

export function tokenExpiringSoon(status: ShopStatus, refreshExpiresAt: Date | null, now = Date.now()): boolean {
  return status === 'active' && refreshExpiresAt !== null && refreshExpiresAt.getTime() - now < EXPIRING_MS;
}

/** Nối lại gian hàng đã có: thao tác nào, hay chỉ thay token (đang `connecting`, `active`). */
export function reconnectAction(status: ShopStatus, orderCutoffAt: Date | null): 'reconnect' | 'resume_setup' | null {
  if (status === 'connecting' || status === 'active') return null;
  return status === 'disconnected' && orderCutoffAt === null ? 'resume_setup' : 'reconnect';
}
