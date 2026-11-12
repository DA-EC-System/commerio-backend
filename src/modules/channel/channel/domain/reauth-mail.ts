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

/**
 * Hạn của thư trước hạn lệch dưới ngưỡng này vẫn là cùng một mốc. Cùng ngưỡng với EXCLUDE `shop_reauth_mails_deadline_drift`
 * (±30 phút quanh hạn, migration RLS của #312). Hạn tính lại từ "số giây còn lại" (Lazada `refresh_expires_in`) sau mỗi
 * lần làm mới token chỉ lệch vài giây; hạn gia hạn thật hay lần nối lại mới thì cách xa hơn nhiều.
 */
export const DEADLINE_DRIFT_MS = 60 * 60_000;

/**
 * Thư đã xếp còn đúng mốc đang tới (`due = dueReauthMail(...)` lúc gửi hay lúc xếp lại): cùng mốc, cùng nhịp, hạn khớp
 * (thư trước hạn trong ngưỡng lệch, thư `lost` đúng lúc chuyển trạng thái). Sai thì thư đã cũ: gian hàng đã nối lại, đã
 * ngắt, hạn đã đổi hẳn, hoặc mốc sau đã thay (thư 3 ngày khi đã vào ngày cuối, nhịp 6 giờ trước khi đã sang nhịp mới).
 */
export function isCurrentMail(mail: ReauthMailMilestone, due: ReauthMailMilestone | null): boolean {
  if (!due || due.stage !== mail.stage || due.seq !== mail.seq) return false;
  const diff = Math.abs(due.deadline.getTime() - mail.deadline.getTime());
  return mail.stage === 'lost' ? diff === 0 : diff < DEADLINE_DRIFT_MS;
}
