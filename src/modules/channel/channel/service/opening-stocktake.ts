// Thoát chế độ chờ kiểm kê lần đầu khi phiếu đầu kỳ ghi sổ (#198 phần 2; Documents/21 §11.2 `inventory.stocktake_posted`,
// `fulfillment.allocation_done`, §18.6.2; 25 §6.1 bước 3–4). Thứ tự theo Documents (Thành chốt 09/11/2026): ghi sổ xong
// thì phân hàng cho mọi kiện chưa bàn giao, rồi mới đẩy tồn. Lần đẩy tồn đầu chờ đủ hai điều kiện: lượt kéo đơn còn mở chạy
// lại theo mốc mới đã xong (`open_orders_pulled_at`) và fulfillment đã phân hàng từ lúc ghi sổ cho mọi biến thể đã ghép
// của gian hàng (`allocation_pending_since` về null). Consumer chỉ ghi DB (đúng một lần nhờ `processed_events`), không gọi sàn.
import { type EventEnvelope, type EventPayload, recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { lockCompanyAllocation, lockShopRow, recordAllocations, settleAllocationPending, updateShop } from '../repository/shops.ts';
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
 * Phiếu nguồn `shop_setup` của gian hàng vừa ghi sổ: `openingStocktake = null`, `orderCutoffAt = countedAt`, ghi nhật ký
 * hệ thống, vào chờ phân hàng (`allocation_pending_since = occurredAt` của sự kiện).
 *
 * Mốc chờ phân hàng lấy `occurredAt` của vỏ sự kiện (giờ Postgres lúc ghi outbox), không lấy `postedAt` (giờ máy Node
 * của inventory): `allocation_done` so bằng `occurredAt` của nó, cùng một đồng hồ. Lượt phân hàng do ghi sổ gây ra luôn
 * bắt đầu sau khi giao dịch ghi sổ commit, nên `occurredAt` của nó lớn hơn mốc này (#198 review I2).
 *
 * Lượt kéo đơn còn mở chạy lại (`open_orders_pulled_at = null`, gian hàng `active` thì xếp việc ngay; gian hàng mất uỷ
 * quyền thì nối lại sẽ xếp, `resumeOpenOrderPull`): mốc dời lên `countedAt` thì đơn đặt giữa lúc thiết lập và lúc đếm mà
 * chưa kéo về sẽ bị vòng 5 phút bỏ (đơn trước mốc chỉ nhận khi đã có trong DB), lượt đơn mở lấy lại đơn còn mở đó.
 *
 * Chờ phân hàng xoá ngay trong giao dịch này nếu fulfillment đã phân hàng xong trước (sự kiện tới trước, hai topic khác
 * nhau) hoặc gian hàng không có listing nào để đẩy tồn.
 *
 * Chỉ đổi khi phiếu đúng là phiếu gian hàng đang chờ; phiếu khác, nguồn khác, gian hàng công ty khác (RLS ẩn) hay đã xử
 * lý thì bỏ qua. Gọi trong `withCompany` của sự kiện. Khoá phân hàng của công ty trước, rồi khoá dòng gian hàng
 * (`FOR NO KEY UPDATE`): giao dịch nhận đơn đọc `opening_stocktake_id` dưới `FOR SHARE` (`lockShopForOrders`) nên không
 * nhận đơn với chế độ cũ sau khi thoát.
 */
export async function onOpeningStocktakePosted(event: EventPayload<'inventory.stocktake_posted'>, occurredAt: Date): Promise<void> {
  const orderCutoffAt = assertCountedAt(event, Date.now());
  const companyId = requireCompanyId('onOpeningStocktakePosted');
  if (event.source?.type !== 'shop_setup') return;
  await lockCompanyAllocation(companyId);
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
    {
      openingStocktakeId: null,
      openingStocktakeNumber: null,
      orderCutoffAt,
      openOrdersPulledAt: null,
      allocationPendingSince: occurredAt,
    },
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
  await settleAllocationPending(shop.id);
  // Lượt đơn mở xong tự xếp đồng bộ listing; lượt đó chỉ đẩy tồn khi đã hết chờ phân hàng.
  if (shop.status === 'active') await sendOpenOrderPull(companyId, shop.id);
}

/**
 * `fulfillment.allocation_done`: ghi lần phân hàng của các biến thể (lúc phát sự kiện), rồi bỏ cờ chờ phân hàng của gian
 * hàng nào đã đủ. Gian hàng vừa hết chờ, đang `active` và lượt đơn mở đã xong thì xếp đồng bộ listing để đẩy tồn lần đầu;
 * lượt đơn mở chưa xong thì chính lượt đó sẽ xếp. Gọi trong `withCompany` của sự kiện.
 */
export async function onAllocationDone(variantIds: readonly string[], occurredAt: Date): Promise<void> {
  const companyId = requireCompanyId('onAllocationDone');
  await lockCompanyAllocation(companyId);
  await recordAllocations(companyId, variantIds, occurredAt);
  for (const shop of await settleAllocationPending()) {
    if (shop.status === 'active' && shop.openOrdersPulledAt) await sendListingSync(companyId, shop.id);
  }
}

/** Handler đăng ký cho `inventory.stocktake_posted` (consumer `channel-opening-stocktake`). */
export const handleStocktakePosted = (e: EventEnvelope<'inventory.stocktake_posted', EventPayload<'inventory.stocktake_posted'>>) =>
  onOpeningStocktakePosted(e.payload, new Date(e.occurredAt));

/** Handler đăng ký cho `fulfillment.allocation_done` (consumer `channel-allocation-done`). */
export const handleAllocationDone = (e: EventEnvelope<'fulfillment.allocation_done', EventPayload<'fulfillment.allocation_done'>>) =>
  onAllocationDone(e.payload.variantIds, new Date(e.occurredAt));
