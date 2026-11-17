// CEO quyết listing bị sàn đổi ngoài app (#360; 21 §18.3 route `outside-change/:action`, 25 §6.4 `hidden → live`).
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { listingMachine, NO_OUTSIDE_CHANGE } from '../domain/listing.ts';
import { findListingById, type ListingRow, listListingRows, updateListing } from '../repository/listings.ts';
import { activateOnMarketplace, hidesByProduct, pausedVariants, productGroup, remoteSkuOf, type Session } from './listing-sync.ts';
import { MarketplaceError } from './marketplaces/common.ts';
import type { ProductPort } from './product-port.ts';
import { type ChannelListing, ENTITY, moveListing, requesterNames, toListing } from './listings.ts';
import { sendStockPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, shopSession } from './shops.ts';

export type OutsideChangeAction = 'restore' | 'accept-price';

const notAllowed = (message: string) => new AppError(409, 'invalid_transition', message);
const conflict = async (fresh: ListingRow | undefined) =>
  new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', {
    current: fresh ? toListing(fresh, await requesterNames([fresh])) : null,
  });

/**
 * `restore`: bật lại trên sàn rồi `hidden → live`, đẩy lại tồn và giá của app. Sàn đã bán lại (người bán tự bật) thì
 * không gọi bật. SKU đang tạm ngừng: chỉ xoá `outsideChange`, giữ `hidden` (lịch sử `hidden → hidden`; máy không có cạnh
 * này vì `outside_resolve` từ `hidden` đã đi `live`); bỏ tạm ngừng sau đó thì `unhide` bật lại. Sàn tắt theo cả sản phẩm
 * (TikTok, #224 phần 2): người bán tắt cả sản phẩm nên quyết cho mọi listing `disabled` cùng sản phẩm; listing cùng sản
 * phẩm còn ẩn sau quyết định được đưa tồn 0 lên sàn trước khi bật sản phẩm. `accept-price` chỉ cho `price_changed`
 * (phát hiện giá sàn là phần giá của #360), `disabled` thì 409.
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
  const { session, row, byProduct, group, paused } = await inCompany(async () => {
    const session = await shopSession(shopId);
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== shopId) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    if (row.version !== version) throw await conflict(row);
    if (!row.outsideChangeKind) throw notAllowed('Listing không có thay đổi ngoài app chờ quyết');
    if (action === 'accept-price') throw notAllowed('Chỉ nhận giá sàn khi giá trên sàn bị sửa');
    const byProduct = hidesByProduct(session.adapter);
    const group = byProduct && row.externalProductId ? productGroup(await listListingRows(shopId), row.externalProductId) : [row];
    const paused = await pausedVariants(port, group.flatMap((r) => (r.variantId ? [r.variantId] : [])));
    return { session, row, byProduct, group, paused };
  });
  assertTransition(listingMachine, row.status, 'outside_resolve', { actor, view: toListing(row) });

  const isPaused = (r: ListingRow) => !!r.variantId && paused.has(r.variantId);
  const targets = group.filter((r) => r.id === row.id || (r.status === 'hidden' && r.outsideChangeKind === 'disabled'));
  const toLive = targets.filter((r) => !isPaused(r));
  if (toLive.length) await onMarketplace(() => enableOnMarketplace(session, group, toLive));

  const updated = await inCompany(async () => {
    let result = row;
    for (const target of targets) {
      const clicked = target.id === row.id;
      const moved = await decide(target, isPaused(target), byProduct, actor, clicked);
      if (clicked) result = moved;
    }
    return toListing(result, await requesterNames([result]));
  });
  if (toLive.length) await sendStockPush(actor.companyId, shopId);
  return updated;
}

/**
 * Bật trên sàn trước khi ghi DB; sàn đã bán lại thì thôi. Sàn tắt theo cả sản phẩm: đưa tồn 0 lên cho listing cùng sản
 * phẩm còn ẩn sau quyết định (SKU tạm ngừng, chờ quyết giá), lỗi thì chưa bật để không lộ SKU đó.
 */
async function enableOnMarketplace(session: Session, group: readonly ListingRow[], toLive: readonly ListingRow[]): Promise<void> {
  const probe = toLive.find((r) => r.hiddenBy === 'platform' && r.externalProductId && r.externalSkuId && r.sellerSku);
  if (!probe) return;
  if ((await remoteSkuOf(session, probe))?.state === 'live') return;
  // Nhóm chỉ có hơn một dòng khi sàn tắt theo sản phẩm.
  const staying = group.filter((r) => r.status === 'hidden' && !toLive.includes(r) && r.externalSkuId);
  if (staying.length) {
    const items = staying.map((r) => ({ externalProductId: r.externalProductId!, externalSkuId: r.externalSkuId!, quantity: 0 }));
    const results = await session.adapter.updatePriceQuantity(session.accessToken, items);
    const ok = new Set(results.filter((x) => (x.stock ?? x).ok).map((x) => x.externalSkuId));
    if (!items.every((i) => ok.has(i.externalSkuId))) {
      throw new MarketplaceError('rejected', 'zero_stock_failed', 'Chưa đưa được tồn 0 lên sàn cho phân loại còn ẩn, chưa bật lại sản phẩm');
    }
  }
  await activateOnMarketplace(session, probe.externalProductId!, probe.externalSkuId!);
}

/**
 * Ghi quyết định cho một listing. Lệch `version` (tồn vừa đổi trong lúc gọi sàn) thì ghi trên dòng mới nếu vẫn chờ quyết,
 * không để app thôi đẩy tồn khi sàn đang bán; dòng đã đổi thì 409 kèm `current` cho dòng được bấm, bỏ qua dòng cùng sản phẩm.
 */
async function decide(row: ListingRow, paused: boolean, byProduct: boolean, actor: Actor, clicked: boolean): Promise<ListingRow> {
  const write = async (r: ListingRow) => {
    if (!paused) return moveListing(r, 'outside_resolve', actor, { hiddenBy: null, stockSync: 'pending', priceSync: 'pending' });
    // Sàn tắt theo sản phẩm: listing còn ẩn để tồn 0 như mọi listing app ẩn (`zero_stock`).
    const patch = { ...NO_OUTSIDE_CHANGE, ...(byProduct && { hiddenBy: 'zero_stock' as const, stockSync: 'pending' as const }) };
    const updated = await updateListing(r.id, { version: r.version, status: 'hidden' }, patch);
    if (!updated) throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật');
    await recordTransition({ entityType: ENTITY, entityId: r.id, from: 'hidden', to: 'hidden', action: 'outside_resolve', actorId: actor.accountId });
    return updated;
  };
  try {
    return await write(row);
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'version_conflict') throw err;
  }
  const fresh = await findListingById(row.id);
  if (fresh?.status !== 'hidden' || !fresh.outsideChangeKind) {
    if (clicked) throw await conflict(fresh);
    return fresh ?? row;
  }
  return write(fresh);
}
