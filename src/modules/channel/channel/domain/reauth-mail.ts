// Luật mốc thư báo gian hàng sắp hết hoặc đã mất uỷ quyền (#312). Thuần: không I/O, `now` truyền vào.
import { type ShopStatus, tokenExpiringSoon } from './shop.ts';

export type ReauthMailStage = 'expiring_3d' | 'expiring_1d' | 'lost';

/** Còn dưới 1 ngày tới hạn: thư thứ hai trước hạn. Thư thứ nhất dùng đúng ngưỡng 3 ngày của `tokenExpiringSoon`. */
export const EXPIRING_LAST_DAY_MS = 24 * 3600_000;
/** Đã mất uỷ quyền: thư ngay lúc chuyển, sau đó cứ 6 giờ một thư tới khi nối lại hoặc ngắt. */
export const LOST_REPEAT_MS = 6 * 3600_000;

/**
 * Một mốc thư. `deadline` là hạn đang tính: hạn uỷ quyền (`authDeadline`) với hai thư trước hạn, lúc chuyển sang
 * `needs_reauth` với thư sau khi mất quyền. `(shopId, deadline, stage, seq)` là khoá unique của `shop_reauth_mails`.
 */
export interface ReauthMailMilestone {
  stage: ReauthMailStage;
  deadline: Date;
  seq: number;
}

export interface ReauthMailShop {
  status: ShopStatus;
  /** `authDeadline(authExpiresAt, refreshExpiresAt)`; null khi token dán tay không có hạn. */
  deadline: Date | null;
  /** Lúc chuyển sang `needs_reauth` gần nhất (`core.state_transitions`); chỉ dùng khi `needs_reauth`. */
  lostAt: Date | null;
}

/**
 * Mốc thư đã tới của gian hàng lúc `now`, null khi không có. Chỉ trả mốc mới nhất: gian hàng vừa nối với hạn còn 20 giờ
 * chỉ nhận thư 1 ngày, worker nghỉ 13 giờ thì chỉ gửi nhịp 6 giờ hiện tại, không gửi bù các nhịp đã lỡ.
 * - `active`: còn dưới 3 ngày (`tokenExpiringSoon`, cùng lúc nhãn "Sắp hết hạn" trên trang) là `expiring_3d`, còn dưới 1 ngày
 *   là `expiring_1d`. Đã qua hạn thì không: việc nền làm mới token sẽ `lose_auth` và thư sau khi mất quyền lo.
 * - `needs_reauth`: nhịp 6 giờ thứ `seq` kể từ `lostAt`, kể cả khi sàn thu hồi quyền trước hạn.
 * - `connecting`, `disconnected`: không thư (nối lại xong về `active`, ngắt thì dừng).
 */
export function dueReauthMail(shop: ReauthMailShop, now: Date): ReauthMailMilestone | null {
  const at = now.getTime();
  if (shop.status === 'active') {
    if (!shop.deadline || !tokenExpiringSoon(shop.status, shop.deadline, at)) return null;
    const left = shop.deadline.getTime() - at;
    if (left <= 0) return null;
    return { stage: left < EXPIRING_LAST_DAY_MS ? 'expiring_1d' : 'expiring_3d', deadline: shop.deadline, seq: 0 };
  }
  if (shop.status === 'needs_reauth' && shop.lostAt) {
    // Đồng hồ máy app chậm hơn đồng hồ DB (ghi `lostAt`) vài mili giây thì vẫn là nhịp 0.
    const seq = Math.max(0, Math.floor((at - shop.lostAt.getTime()) / LOST_REPEAT_MS));
    return { stage: 'lost', deadline: shop.lostAt, seq };
  }
  return null;
}
