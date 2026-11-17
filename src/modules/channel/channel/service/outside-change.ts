// CEO quyết listing bị sàn đổi ngoài app (#360; 21 §18.3 route `outside-change/:action`, 25 §6.4 `hidden → live`).
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { listingMachine, NO_OUTSIDE_CHANGE } from '../domain/listing.ts';
import { findListingById, updateListing } from '../repository/listings.ts';
import { activateOnMarketplace, appHidesOn, pausedVariants } from './listing-sync.ts';
import type { ProductPort } from './product-port.ts';
import { type ChannelListing, ENTITY, moveListing, requesterNames, toListing } from './listings.ts';
import { sendStockPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, shopSession } from './shops.ts';

export type OutsideChangeAction = 'restore' | 'accept-price';

const notAllowed = (message: string) => new AppError(409, 'invalid_transition', message);

/**
 * `restore`: bật lại trên sàn rồi `hidden → live`, đẩy lại tồn và giá của app. Sàn đã bán lại (người bán tự bật) thì
 * không gọi bật; sàn chưa bán mà adapter không bật được (TikTok, phần 2 của #224) thì 422 `marketplace_unsupported`.
 * SKU đang tạm ngừng (sàn app tự ẩn, hiện được; TikTok đi nhánh thường): chỉ xoá `outsideChange`, giữ `hidden` (lịch sử `hidden → hidden`; máy không có cạnh này vì
 * `outside_resolve` từ `hidden` đã đi `live`); bỏ tạm ngừng sau đó thì `unhide` bật lại. `accept-price` chỉ cho
 * `price_changed` (phát hiện giá sàn là phần giá của #360), `disabled` thì 409.
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
  const { session, row, paused } = await inCompany(async () => {
    const session = await shopSession(shopId);
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== shopId) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    if (row.version !== version) {
      throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', { current: toListing(row, await requesterNames([row])) });
    }
    if (!row.outsideChangeKind) throw notAllowed('Listing không có thay đổi ngoài app chờ quyết');
    if (action === 'accept-price') throw notAllowed('Chỉ nhận giá sàn khi giá trên sàn bị sửa');
    const paused = appHidesOn(session.shop.platform) && !!row.variantId && (await pausedVariants(port, [row.variantId])).has(row.variantId);
    return { session, row, paused };
  });

  if (paused) {
    return inCompany(async () => {
      const updated = await updateListing(row.id, { version, status: 'hidden' }, NO_OUTSIDE_CHANGE);
      if (!updated) {
        const fresh = await findListingById(row.id);
        throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', {
          current: fresh ? toListing(fresh, await requesterNames([fresh])) : null,
        });
      }
      await recordTransition({ entityType: ENTITY, entityId: row.id, from: 'hidden', to: 'hidden', action: 'outside_resolve', actorId: actor.accountId });
      return toListing(updated, await requesterNames([updated]));
    });
  }

  assertTransition(listingMachine, row.status, 'outside_resolve', { actor, view: toListing(row) });
  const { externalProductId, externalSkuId, sellerSku } = row;
  if (row.hiddenBy === 'platform' && externalProductId && externalSkuId && sellerSku) {
    const { adapter, accessToken } = session;
    await onMarketplace(async () => {
      const remote = (await adapter.getSkus(accessToken, [sellerSku])).find((s) => s.externalSkuId === externalSkuId);
      if (remote?.state !== 'live') await activateOnMarketplace(adapter, accessToken, externalProductId, externalSkuId);
    });
  }
  // Sàn đã bật: lệch `version` (tồn vừa đổi) thì ghi trên dòng mới nếu vẫn chờ quyết, không để app thôi đẩy tồn khi sàn đang bán.
  const patch = { hiddenBy: null, stockSync: 'pending', priceSync: 'pending' } as const;
  const updated = await inCompany(async () => {
    let moved;
    try {
      moved = await moveListing(row, 'outside_resolve', actor, patch);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'version_conflict') throw err;
      const fresh = await findListingById(row.id);
      if (fresh?.status !== 'hidden' || !fresh.outsideChangeKind) throw err;
      moved = await moveListing(fresh, 'outside_resolve', actor, patch);
    }
    return toListing(moved, await requesterNames([moved]));
  });
  await sendStockPush(actor.companyId, shopId);
  return updated;
}
