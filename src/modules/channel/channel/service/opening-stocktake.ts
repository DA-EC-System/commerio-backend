// Kiểm kê đầu kỳ của gian hàng sau thiết lập (#198 phần 2; Documents/21 §11.2 `inventory.stocktake_posted`,
// `fulfillment.allocation_done`, §18.6.2, §18.6.11; Thành chốt 09/11/2026). Phiếu ghi sổ thì gian hàng thoát chờ kiểm kê
// và sang chờ phân hàng; thoát chờ phân hàng khi nhận `allocation_done` có `cause.documentId` trùng phiếu. Đẩy tồn lần đầu
// cần cả hai: lượt kéo đơn còn mở theo mốc mới đã xong và đã thoát chờ phân hàng. Consumer chỉ ghi DB (đúng một lần nhờ `processed_events`), không gọi sàn.
import { type EventEnvelope, type EventPayload, recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { lockShopRow, settleStocktakeAllocation, updateShop } from '../repository/shops.ts';
import { sendListingSync, sendOpenOrderPull } from './shop-jobs.ts';

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
 * Phiếu nguồn `shop_setup` của gian hàng vừa ghi sổ (§18.6.2, §18.6.11): `openingStocktake = null`, `orderCutoffAt =
 * countedAt`, `open_orders_pulled_at = null`, chờ phân hàng (`allocation_stocktake_id = documentId`), ghi nhật ký hệ thống,
 * gian hàng `active` thì xếp lại lượt kéo đơn còn mở (không `active` thì nối lại sẽ xếp, `resumeOpenOrderPull`).
 *
 * `allocation_done` của phiếu này đã tới trước (`allocated_stocktake_id` trùng, hai topic khác nhau) thì không vào chờ
 * phân hàng. Phiếu khác, nguồn khác, gian hàng công ty khác (RLS ẩn) hay đã xử lý thì bỏ qua. Gọi trong `withCompany`
 * của sự kiện. Khoá dòng gian hàng (`FOR NO KEY UPDATE`): giao dịch nhận đơn đọc `opening_stocktake_id` dưới `FOR SHARE`
 * (`lockShopForOrders`) nên không nhận đơn với chế độ cũ sau khi thoát.
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
  const allocationStocktakeId = shop.allocatedStocktakeId === event.documentId ? null : event.documentId;
  const updated = await updateShop(
    shop.id,
    { version: shop.version },
    { openingStocktakeId: null, openingStocktakeNumber: null, orderCutoffAt, openOrdersPulledAt: null, allocationStocktakeId },
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
    after: { orderCutoffAt, openingStocktakeId: null, openingStocktakeNumber: null, stocktakeNumber: event.number, allocationStocktakeId },
  });
  // Lượt đơn mở xong tự xếp đồng bộ listing; lượt đó chỉ đẩy tồn khi đã thoát chờ phân hàng.
  if (shop.status === 'active') await sendOpenOrderPull(companyId, shop.id);
}

/**
 * `fulfillment.allocation_done` (§11.2, §18.6.11). Chỉ sự kiện có `cause` làm thoát chờ phân hàng, và chỉ ở gian hàng có
 * phiếu đầu kỳ trùng `cause.documentId`; không có `cause` thì bỏ qua (đẩy tồn theo `variantIds` là của #223). Gian hàng vừa
 * thoát chờ, `active` và lượt đơn mở đã xong thì xếp đồng bộ listing để đẩy tồn lần đầu; lượt đơn mở chưa xong thì chính
 * lượt đó sẽ xếp. Gọi trong `withCompany` của sự kiện.
 */
export async function onAllocationDone(event: EventPayload<'fulfillment.allocation_done'>): Promise<void> {
  const companyId = requireCompanyId('onAllocationDone');
  if (!event.cause) return;
  const shops = await settleStocktakeAllocation(event.cause.documentId);
  if (!shops.length) logger.debug({ documentId: event.cause.documentId }, 'allocation_done không trùng phiếu đầu kỳ của gian hàng nào, bỏ qua');
  for (const shop of shops) {
    if (shop.settled && shop.status === 'active' && shop.openOrdersPulledAt) await sendListingSync(companyId, shop.id);
  }
}

/** Handler đăng ký cho `inventory.stocktake_posted` (consumer `channel-opening-stocktake`). */
export const handleStocktakePosted = (e: EventEnvelope<'inventory.stocktake_posted', EventPayload<'inventory.stocktake_posted'>>) =>
  onOpeningStocktakePosted(e.payload);

/** Handler đăng ký cho `fulfillment.allocation_done` (consumer `channel-allocation-done`). */
export const handleAllocationDone = (e: EventEnvelope<'fulfillment.allocation_done', EventPayload<'fulfillment.allocation_done'>>) =>
  onAllocationDone(e.payload);
