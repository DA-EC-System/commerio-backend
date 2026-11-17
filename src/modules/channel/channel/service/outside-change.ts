// CEO quyết listing bị sàn đổi ngoài app (#360; 21 §18.3 route `outside-change/:action`, 25 §6.4 `hidden → live`).
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { listingMachine, NO_OUTSIDE_CHANGE } from '../domain/listing.ts';
import { findListingById, updateListing } from '../repository/listings.ts';
import { pausedVariants } from './listing-sync.ts';
import { MarketplaceError } from './marketplaces/common.ts';
import type { ProductPort } from './product-port.ts';
import { type ChannelListing, moveListing, requesterNames, toListing } from './listings.ts';
import { sendStockPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, shopSession } from './shops.ts';

export type OutsideChangeAction = 'restore' | 'accept-price';

const notAllowed = (message: string) => new AppError(409, 'invalid_transition', message);

/**
 * `restore`: bật lại trên sàn rồi `hidden → live`, đẩy lại tồn và giá của app. Sàn đã bán lại (người bán tự bật) thì
 * không gọi bật; sàn chưa bán mà adapter không bật được (TikTok, phần 2 của #224) thì 422 `marketplace_unsupported`.
 * SKU đang tạm ngừng: chỉ xoá `outsideChange`, giữ `hidden` (lịch sử `hidden → hidden`); bỏ tạm ngừng sau đó thì `unhide`
 * bật lại. `accept-price` chỉ cho `price_changed` (phát hiện giá sàn là phần giá của #360), `disabled` thì 409.
 */
export async function resolveOutsideChange(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  listingId: string,
  action: OutsideChangeAction,
  version: number,
): Promise<ChannelListing> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  const { adapter, accessToken } = await inCompany(() => shopSession(shopId));
  const row = await inCompany(() => findListingById(listingId));
  if (!row || row.shopId !== shopId) throw new AppError(404, 'not_found', 'Không tìm thấy listing trên gian hàng này');
  if (row.version !== version) {
    throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', { current: toListing(row) });
  }
  if (!row.outsideChangeKind) throw notAllowed('Listing không có thay đổi ngoài app chờ quyết');
  if (action === 'accept-price') throw notAllowed('Chỉ nhận giá sàn khi giá trên sàn bị sửa');

  const paused = row.variantId ? (await inCompany(() => pausedVariants(port, [row.variantId!]))).has(row.variantId) : false;
  if (paused) {
    const updated = await inCompany(async () => {
      const done = await updateListing(row.id, { version, status: 'hidden' }, NO_OUTSIDE_CHANGE);
      if (!done) throw new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
      await recordTransition({ entityType: 'listings', entityId: row.id, from: 'hidden', to: 'hidden', action: 'outside_resolve', actorId: actor.accountId });
      return done;
    });
    return toListing(updated, await inCompany(() => requesterNames([updated])));
  }

  assertTransition(listingMachine, row.status, 'outside_resolve', { actor, view: toListing(row) });
  if (row.hiddenBy === 'platform' && row.externalProductId && row.externalSkuId && row.sellerSku) {
    const { externalProductId, externalSkuId, sellerSku } = row;
    await onMarketplace(async () => {
      const [remote] = (await adapter.getSkus(accessToken, [sellerSku])).filter((s) => s.externalSkuId === externalSkuId);
      if (remote?.state === 'live') return;
      if (!adapter.activate) throw new MarketplaceError('unsupported', 'activate_missing', 'Sàn chưa hỗ trợ bật lại sản phẩm từ app');
      await adapter.activate(accessToken, externalProductId, externalSkuId);
    });
  }
  const updated = await inCompany(() => moveListing(row, 'outside_resolve', actor, { hiddenBy: null, stockSync: 'pending', priceSync: 'pending' }));
  await sendStockPush(actor.companyId, shopId);
  return toListing(updated, await inCompany(() => requesterNames([updated])));
}
