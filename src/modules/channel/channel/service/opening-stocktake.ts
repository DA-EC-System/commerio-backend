// Kiểm kê đầu kỳ của gian hàng sau thiết lập (#198 phần 2; Documents/21 §11.2 `inventory.stocktake_posted`,
// `fulfillment.allocation_done`, §11.3 `settleOpeningStocktake`, §18.6.2, §18.6.11; Thành chốt 09/11, 11/11/2026). Phiếu
// ghi sổ thì gian hàng thoát chờ kiểm kê và, trong cùng giao dịch, gọi `settleOpeningStocktake` của fulfillment (bù kiện
// hoãn trừ, phân hàng, phát `allocation_done` có `cause`); gian hàng sang chờ phân hàng, thoát khi nhận `allocation_done`
// có `cause.documentId` trùng phiếu. Đẩy tồn lần đầu
// cần cả hai: lượt kéo đơn còn mở theo mốc mới đã xong và đã thoát chờ phân hàng. Phiếu bị từ chối hoặc huỷ thì lập lại
// qua `POST /channel/shops/:id/opening-stocktake`. Consumer chỉ ghi DB (đúng một lần nhờ `processed_events`), không gọi sàn.
import { type EventEnvelope, type EventPayload, recordAudit } from '../../../core/index.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { settleOpeningStocktake } from '../../../order/index.ts';
import { lockShopRow, settleStocktakeAllocation, updateShop } from '../repository/shops.ts';
import { sendListingSync, sendOpenOrderPull } from './shop-jobs.ts';
import { type Actor, ownShop, type Shop, shopView } from './shops.ts';
import { stocktakePort } from './stocktake-port.ts';

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
 * Phiếu nguồn `shop_setup` của gian hàng vừa ghi sổ (§18.6.2, §18.6.11), trong một giao dịch: `openingStocktake = null`,
 * `orderCutoffAt = countedAt`, `open_orders_pulled_at = null`, chờ phân hàng (`allocation_stocktake_id = documentId`), rồi
 * gọi `settleOpeningStocktake` của fulfillment (§11.3, sau khi đặt `openingStocktake = null`), ghi nhật ký hệ thống, gian
 * hàng `active` thì xếp lại lượt kéo đơn còn mở (việc pg-boss đi chung giao dịch nên chỉ chạy nền sau commit, không gọi
 * sàn ở đây; không `active` thì nối lại sẽ xếp, `resumeOpenOrderPull`).
 *
 * Bước nào lỗi thì cả giao dịch rollback, gian hàng vẫn chờ kiểm kê, consumer thử lại; hết lần thử thì DLQ (phiếu ở
 * `posted` mà gian hàng vẫn chờ, §18.6.11). Phiếu khác, nguồn khác, gian hàng công ty khác (RLS ẩn) hay đã xử lý thì bỏ
 * qua, không gọi fulfillment. Gọi trong `withCompany` của sự kiện. Khoá dòng gian hàng (`FOR NO KEY UPDATE`) trước khoá
 * của fulfillment (thứ tự "gian hàng → kiện" như kéo đơn): giao dịch nhận đơn đọc `opening_stocktake_id` dưới `FOR SHARE`
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
  const allocationStocktakeId = event.documentId;
  const updated = await updateShop(
    shop.id,
    { version: shop.version },
    { openingStocktakeId: null, openingStocktakeNumber: null, orderCutoffAt, openOrdersPulledAt: null, allocationStocktakeId },
  );
  // Đã khoá dòng nên `version` không đổi giữa chừng; không trúng là lỗi thật, ném để consumer thử lại.
  if (!updated) throw new Error(`Không cập nhật được gian hàng ${shop.id} khi thoát chờ kiểm kê`);
  const settled = await settleOpeningStocktake({ shopId: shop.id, documentId: event.documentId, countedAt: orderCutoffAt });
  logger.info({ shopId: shop.id, documentId: event.documentId, ...settled }, 'Thoát chờ kiểm kê, fulfillment đã chốt phiếu đầu kỳ');
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
    if (shop.status === 'active' && shop.openOrdersPulledAt) await sendListingSync(companyId, shop.id);
  }
}

/** Handler đăng ký cho `inventory.stocktake_posted` (consumer `channel-opening-stocktake`). */
export const handleStocktakePosted = (e: EventEnvelope<'inventory.stocktake_posted', EventPayload<'inventory.stocktake_posted'>>) =>
  onOpeningStocktakePosted(e.payload);

/** Handler đăng ký cho `fulfillment.allocation_done` (consumer `channel-allocation-done`). */
export const handleAllocationDone = (e: EventEnvelope<'fulfillment.allocation_done', EventPayload<'fulfillment.allocation_done'>>) =>
  onAllocationDone(e.payload);

/**
 * `POST /channel/shops/:id/opening-stocktake` (§18.6.11): lập lại phiếu kiểm kê đầu kỳ khi phiếu hiện tại bị từ chối, bị
 * huỷ hoặc không còn. Dưới khoá dòng gian hàng: đọc trạng thái phiếu, gọi `createOpeningStocktake`, thay `openingStocktake`
 * bằng phiếu mới, ghi nhật ký. `orderCutoffAt` giữ mốc tạm. Hai lần gọi đua thì lần sau thấy phiếu mới ở `draft` (409).
 *
 * Phiếu hiện tại đã `posted` mà channel chưa xử lý sự kiện: coi như không còn chờ kiểm kê (`shop_not_awaiting_stocktake`,
 * "phiếu đã ghi sổ" ở §18.6.11), không lập phiếu mới.
 */
export async function recreateOpeningStocktake(actor: Actor, shopId: string): Promise<{ shop: Shop; stocktakeNumber: string }> {
  return withCompany(actor.companyId, async () => {
    await ownShop(shopId);
    const shop = (await lockShopRow(shopId))!;
    if (shop.status !== 'active') throw new AppError(409, 'shop_not_active', 'Gian hàng chưa hoạt động', { current: shop.status });
    const current = shop.openingStocktakeId;
    if (!current || !shop.openingStocktakeNumber) throw notAwaiting();
    const status = (await stocktakePort().openingStocktakeStatusOf([current])).get(current);
    if (status === 'posted') throw notAwaiting();
    if (status === 'draft' || status === 'pending') {
      throw new AppError(409, 'opening_stocktake_open', `Phiếu ${shop.openingStocktakeNumber} vẫn đang mở. Sửa hoặc duyệt phiếu này`, {
        number: shop.openingStocktakeNumber,
        status,
      });
    }
    const doc = await stocktakePort().createOpeningStocktake(shop.id, { actorId: actor.accountId });
    const updated = await updateShop(shop.id, { version: shop.version }, { openingStocktakeId: doc.documentId, openingStocktakeNumber: doc.number });
    if (!updated) throw new AppError(409, 'version_conflict', 'Gian hàng vừa được cập nhật, thử lại');
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'channel.shops',
      entityId: shop.id,
      before: { openingStocktakeId: current, openingStocktakeNumber: shop.openingStocktakeNumber, openingStocktakeStatus: status ?? null },
      after: { openingStocktakeId: doc.documentId, openingStocktakeNumber: doc.number },
    });
    return { shop: await shopView(updated), stocktakeNumber: doc.number };
  });
}

const notAwaiting = () => new AppError(409, 'shop_not_awaiting_stocktake', 'Gian hàng không còn chờ phiếu kiểm kê đầu kỳ');
