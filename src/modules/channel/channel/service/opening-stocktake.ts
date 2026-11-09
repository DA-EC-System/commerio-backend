// Thoát chế độ chờ kiểm kê lần đầu khi phiếu đầu kỳ ghi sổ (#198 phần 2; Documents/21 §11.2 `inventory.stocktake_posted`,
// §18.6.2; 25 §6.1 bước 3–4). Consumer chỉ ghi DB (đúng một lần nhờ `processed_events`), không gọi sàn: lượt kéo đơn còn
// mở xếp trong cùng giao dịch chạy lại theo mốc mới, xong lượt đó mới đẩy tồn lần đầu (A10).
import { type EventPayload, recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { lockShopRow, updateShop } from '../repository/shops.ts';
import { sendOpenOrderPull } from './shop-jobs.ts';

/** Lệch giờ cho phép giữa máy phát (inventory) và worker khi so `countedAt` với giờ hiện tại. */
const CLOCK_SKEW_MS = 60_000;

/**
 * `countedAt` sau `postedAt` hoặc ở tương lai là dữ liệu sai: đặt mốc như vậy thì vòng kéo bỏ mọi đơn đặt từ giờ tới
 * `countedAt`. Ném để consumer thử lại rồi đưa sang DLQ cho người xem, không đặt mốc sai (#198 review S1).
 */
function assertCountedAt(event: EventPayload<'inventory.stocktake_posted'>, now: number): Date {
  const counted = new Date(event.countedAt);
  if (counted.getTime() > new Date(event.postedAt).getTime()) {
    throw new Error(`Phiếu ${event.number}: countedAt ${event.countedAt} sau postedAt ${event.postedAt}`);
  }
  if (counted.getTime() > now + CLOCK_SKEW_MS) throw new Error(`Phiếu ${event.number}: countedAt ${event.countedAt} ở tương lai`);
  return counted;
}

/**
 * Phiếu nguồn `shop_setup` của gian hàng vừa ghi sổ: `openingStocktake = null`, `orderCutoffAt = countedAt`, ghi nhật ký
 * hệ thống. Lượt kéo đơn còn mở chạy lại (`open_orders_pulled_at = null`, gian hàng `active` thì xếp việc ngay; gian hàng
 * mất uỷ quyền thì nối lại sẽ xếp, `resumeOpenOrderPull`): mốc dời lên `countedAt` thì đơn đặt giữa lúc thiết lập và lúc
 * đếm mà chưa kéo về sẽ bị vòng 5 phút bỏ (đơn trước mốc chỉ nhận khi đã có trong DB), lượt đơn mở lấy lại đơn còn mở đó.
 * Tồn giữ tới khi lượt này xong (`listing-sync.ts`), rồi lượt đó tự xếp đồng bộ listing.
 *
 * Chỉ đổi khi phiếu đúng là phiếu gian hàng đang chờ; phiếu khác, nguồn khác, gian hàng công ty khác (RLS ẩn) hay đã xử
 * lý thì bỏ qua. Gọi trong `withCompany` của sự kiện. Khoá dòng gian hàng (`FOR NO KEY UPDATE`) trước khi đổi: giao dịch
 * nhận đơn đọc `opening_stocktake_id` dưới `FOR SHARE` (`lockShopForOrders`) nên không nhận đơn với chế độ cũ sau khi thoát.
 */
export async function onOpeningStocktakePosted(event: EventPayload<'inventory.stocktake_posted'>): Promise<void> {
  const orderCutoffAt = assertCountedAt(event, Date.now());
  const companyId = requireCompanyId('onOpeningStocktakePosted');
  if (event.source?.type !== 'shop_setup') return;
  const shop = await lockShopRow(event.source.shopId);
  if (!shop || shop.openingStocktakeId !== event.documentId) {
    logger.debug({ shopId: event.source.shopId, documentId: event.documentId }, 'Phiếu đầu kỳ ghi sổ không khớp gian hàng đang chờ, bỏ qua');
    return;
  }
  if (shop.orderCutoffAt && orderCutoffAt < shop.orderCutoffAt) {
    logger.warn(
      { shopId: shop.id, documentId: event.documentId, countedAt: event.countedAt, setupAt: shop.orderCutoffAt },
      'Thời điểm đếm của phiếu đầu kỳ trước lúc thiết lập gian hàng',
    );
  }
  const updated = await updateShop(
    shop.id,
    { version: shop.version },
    { openingStocktakeId: null, openingStocktakeNumber: null, orderCutoffAt, openOrdersPulledAt: null },
  );
  // Đã khoá dòng nên `version` không đổi giữa chừng; không trúng là lỗi thật, ném để consumer thử lại.
  if (!updated) throw new Error(`Không cập nhật được gian hàng ${shop.id} khi thoát chờ kiểm kê`);
  await recordAudit({
    companyId,
    actorId: null,
    action: 'update',
    entityType: 'channel.shops',
    entityId: shop.id,
    before: { orderCutoffAt: shop.orderCutoffAt, openingStocktakeId: shop.openingStocktakeId, openingStocktakeNumber: shop.openingStocktakeNumber },
    after: { orderCutoffAt, openingStocktakeId: null, openingStocktakeNumber: null, stocktakeNumber: event.number },
  });
  if (shop.status === 'active') await sendOpenOrderPull(companyId, shop.id);
}
