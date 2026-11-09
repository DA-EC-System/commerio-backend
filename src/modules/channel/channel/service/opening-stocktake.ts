// Thoát chế độ chờ kiểm kê lần đầu khi phiếu đầu kỳ ghi sổ (#198 phần 2; Documents/21 §11.2 `inventory.stocktake_posted`,
// §18.6.2; 25 §6.1 bước 3). Consumer chỉ ghi DB (đúng một lần nhờ `processed_events`), không gọi sàn: tồn đẩy ở lượt
// `channel.listing_sync` xếp trong cùng giao dịch.
import { type EventPayload, recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { lockShopRow, updateShop } from '../repository/shops.ts';
import { sendListingSync } from './shop-jobs.ts';

/**
 * Phiếu nguồn `shop_setup` của gian hàng vừa ghi sổ: `openingStocktake = null`, `orderCutoffAt = countedAt`, ghi nhật ký
 * hệ thống, gian hàng `active` thì xếp một lượt đồng bộ listing để đẩy tồn. Chỉ đổi khi phiếu đúng là phiếu gian hàng đang
 * chờ; phiếu khác, nguồn khác, gian hàng công ty khác (RLS ẩn) hay đã xử lý thì bỏ qua. Gọi trong `withCompany` của sự kiện.
 *
 * Khoá dòng gian hàng (`FOR NO KEY UPDATE`) trước khi đổi: giao dịch nhận đơn đọc `opening_stocktake_id` dưới
 * `FOR SHARE` (`lockShopForOrders`) nên không nhận đơn với chế độ cũ sau khi đã thoát.
 */
export async function onOpeningStocktakePosted(event: EventPayload<'inventory.stocktake_posted'>): Promise<void> {
  const companyId = requireCompanyId('onOpeningStocktakePosted');
  if (event.source?.type !== 'shop_setup') return;
  const shop = await lockShopRow(event.source.shopId);
  if (!shop || shop.openingStocktakeId !== event.documentId) {
    logger.info({ shopId: event.source.shopId, documentId: event.documentId }, 'Phiếu đầu kỳ ghi sổ không khớp gian hàng đang chờ, bỏ qua');
    return;
  }
  const orderCutoffAt = new Date(event.countedAt);
  const updated = await updateShop(
    shop.id,
    { version: shop.version },
    { openingStocktakeId: null, openingStocktakeNumber: null, orderCutoffAt },
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
  if (shop.status === 'active') await sendListingSync(companyId, shop.id);
}
