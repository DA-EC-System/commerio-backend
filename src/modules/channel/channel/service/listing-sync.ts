// Đồng bộ listing với sàn (#104; Documents/21 §18.3, §18.4): đọc trạng thái sàn theo SellerSku của mình (#104 A4),
// đẩy giá và tồn của listing chờ đồng bộ theo lô. Gọi sàn ngoài giao dịch như `listings.ts`. Bấm tay ở route `sync`;
// #102 gọi lại `syncListings` theo lịch.
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type ListingStatus, STALE_PUSH_MS, syncAction } from '../domain/listing.ts';
import { type ListingPatch, listListingRows, markStockPendingRows, updateListing } from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import { MarketplaceError, type PriceQuantity } from './marketplaces/index.ts';
import { moveListing } from './listings.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, onMarketplace, shopSession } from './shops.ts';

/** Listing đọc trạng thái từ sàn. */
const WATCHED: readonly ListingStatus[] = ['under_review', 'live', 'hidden', 'platform_hold'];
/** Listing có sản phẩm trên sàn để đẩy giá, tồn. */
const PUSHABLE: readonly ListingStatus[] = [...WATCHED, 'rejected'];

export interface SyncSummary {
  /** Số listing đã đọc trạng thái từ sàn. */
  checked: number;
  /** Số listing đổi trạng thái (theo sàn, hoặc kẹt `pushing` quá 30 phút). */
  changed: number;
  /** Số SKU đã đẩy giá, tồn. */
  pushed: number;
  /** Số SKU đẩy lỗi. */
  errors: number;
}

/** Tồn của biến thể vừa đổi (`inventory.stock_changed`): listing còn trên sàn chờ đẩy tồn. Gọi trong `withCompany`. */
export async function markStockPending(variantId: string): Promise<void> {
  requireCompanyId('markStockPending');
  await markStockPendingRows(variantId, PUSHABLE);
}

export async function syncListings(port: ProductPort, companyId: string, shopId: string): Promise<SyncSummary> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(companyId, fn);
  const { shop, adapter, accessToken } = await inCompany(() => shopSession(shopId));
  const summary: SyncSummary = { checked: 0, changed: 0, pushed: 0, errors: 0 };
  let rows = await inCompany(() => listListingRows(shop.id));

  // Kẹt `pushing` (server chết giữa lúc gọi sàn): quá 30 phút thì báo lỗi đẩy (§18.3).
  const staleBefore = Date.now() - STALE_PUSH_MS;
  for (const row of rows.filter((r) => r.status === 'pushing' && (r.pushStartedAt?.getTime() ?? 0) < staleBefore)) {
    const message = 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại';
    await inCompany(() => moveListing(row, 'fail', null, { pushError: message }, message));
    summary.changed++;
  }

  const watched = rows.filter((r) => WATCHED.includes(r.status) && r.sellerSku && r.externalSkuId);
  summary.checked = watched.length;
  if (watched.length) {
    const remote = await onMarketplace(() => adapter.getSkus(accessToken, watched.map((r) => r.sellerSku!)));
    const bySku = new Map(remote.map((s) => [s.externalSkuId, s]));
    for (const row of watched) {
      const r = bySku.get(row.externalSkuId!);
      const action = r && syncAction(row.status, r.state);
      if (!action) continue;
      const patch = action === 'reject' ? { rejectReason: r.rejectReason ?? 'Sàn từ chối, không ghi lý do' } : {};
      await inCompany(() => moveListing(row, action, null, patch, patch.rejectReason ?? null));
      summary.changed++;
    }
    rows = await inCompany(() => listListingRows(shop.id));
  }

  const due = rows.filter(
    (r) =>
      r.mode === 'mapped' &&
      PUSHABLE.includes(r.status) &&
      r.externalSkuId &&
      (r.stockSync !== 'synced' || r.priceSync !== 'synced'),
  );
  if (!due.length) return summary;
  const ids = due.map((r) => r.variantId!);
  const { prices, available } = await inCompany(async () => ({
    prices: await port.standardPrices(ids),
    available: await port.availableOf(ids),
  }));
  const at = new Date();
  // Biến thể không có trong Map (đã xoá, công ty khác): không đẩy tồn, giữ `stock_sync = pending`, ghi `variant_missing`.
  const variantMissing: SyncError = {
    code: 'variant_missing',
    message: 'Không đọc được số có thể bán của SKU này',
    at: at.toISOString(),
  };
  const plan = due.map((row) => {
    const price = prices.get(row.variantId!);
    const quantity = available.get(row.variantId!);
    const item: PriceQuantity | null =
      !price && quantity === undefined
        ? null
        : {
            externalProductId: row.externalProductId!,
            externalSkuId: row.externalSkuId!,
            ...(price && { price: price.toFixed(0) }),
            ...(quantity !== undefined && { quantity }),
          };
    return { row, item };
  });
  const missing = plan.filter((p) => p.item?.quantity === undefined).length;
  if (missing) logger.warn({ shopId: shop.id, missing }, 'Đồng bộ listing bỏ qua SKU không đọc được số có thể bán');
  const items = plan.flatMap((p) => (p.item ? [p.item] : []));
  const results = new Map(
    items.length
      ? (await onMarketplace(() => adapter.updatePriceQuantity(accessToken, items))).map((x) => [x.externalSkuId, x])
      : [],
  );
  await inCompany(async () => {
    for (const { row, item } of plan) {
      let patch: ListingPatch = item?.quantity === undefined ? { stockSyncError: variantMissing } : {};
      if (item) {
        const result = results.get(row.externalSkuId!);
        summary.pushed++;
        if (result?.ok) {
          patch = { ...patch, ...synced(item, at) };
        } else {
          summary.errors++;
          const error: SyncError = {
            code: result?.code ?? 'no_result',
            message: result?.message ?? 'Sàn không trả kết quả cho SKU này',
            at: at.toISOString(),
          };
          patch = { ...patch, ...failed(error, item) };
        }
      }
      // Lệch `version` (tồn vừa đổi, đánh dấu lại pending giữa lúc đọc và lúc ghi): bỏ kết quả lượt này, giữ dòng
      // như đang có để lượt sau đẩy số mới; không tính là lỗi.
      await updateListing(row.id, { version: row.version }, patch);
    }
  });
  return summary;
}

/**
 * Ngắt kèm `zeroStock` (§18.1): đẩy tồn 0 cho listing còn trên sàn trước khi ngắt. Không gọi được sàn (gian hàng cần
 * nối lại, sàn lỗi) thì 422 `zero_stock_unavailable` và chưa ngắt; lỗi riêng từng SKU thì vẫn ngắt.
 */
export async function pushZeroStock(actor: Actor, shopId: string): Promise<void> {
  const unavailable = () =>
    new AppError(422, 'zero_stock_unavailable', 'Không đẩy được tồn 0 lên sàn lúc này; ngắt không kèm đẩy tồn 0, hoặc thử lại');
  const session = await withCompany(actor.companyId, () => shopSession(shopId)).catch((err: unknown) => {
    throw err instanceof AppError && err.code === 'shop_not_connected' ? unavailable() : err;
  });
  const rows = await withCompany(actor.companyId, () => listListingRows(session.shop.id));
  const items = rows
    .filter((r) => PUSHABLE.includes(r.status) && r.externalSkuId)
    .map((r) => ({ externalProductId: r.externalProductId!, externalSkuId: r.externalSkuId!, quantity: 0 }));
  if (!items.length) return;
  try {
    await session.adapter.updatePriceQuantity(session.accessToken, items);
  } catch (err) {
    if (err instanceof MarketplaceError) throw unavailable();
    throw err;
  }
}

function synced(item: PriceQuantity, at: Date): ListingPatch {
  return {
    ...(item.quantity !== undefined && { stockSync: 'synced', stockSyncError: null, platformStock: item.quantity }),
    ...(item.price === undefined
      ? { priceSync: 'error', priceSyncError: { code: 'price_missing', message: 'Chưa có giá chuẩn', at: at.toISOString() } }
      : { priceSync: 'synced', priceSyncError: null, listedPrice: item.price }),
    lastPushedAt: at,
  };
}

/**
 * Giá và tồn đi chung một lời gọi sàn: lỗi của SKU là lỗi của cả hai. Tồn đẩy lỗi giữ `pending` kèm `stockSyncError`
 * (Documents/21 mục 18.5, 18.6.6); `error` dành cho nhãn Lệch tồn.
 */
function failed(error: SyncError, item: PriceQuantity): ListingPatch {
  return {
    ...(item.quantity !== undefined && { stockSync: 'pending', stockSyncError: error }),
    ...(item.price !== undefined && { priceSync: 'error', priceSyncError: error }),
  };
}
