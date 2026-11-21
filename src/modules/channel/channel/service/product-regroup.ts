// Gom lại dữ liệu cũ (#295, Documents/21 §18.8.4): các SKU của một cha đang là nhiều sản phẩm sàn riêng trên một gian hàng
// thì tạo MỘT sản phẩm nhiều phân loại, rồi xoá các sản phẩm lẻ. Request `requestRegroup` chỉ kiểm và xếp việc
// `channel.product_regroup`; việc nền `runProductRegroup` gọi sàn ngoài giao dịch. Tạo trước, xoá sau để người mua không gặp
// lúc hết hàng.
import { Decimal } from 'decimal.js';
import { type JobAttempt, HoldJob, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { STALE_PUSH_MS } from '../domain/listing.ts';
import { awaitingAllocation } from '../domain/shop.ts';
import { sentBaseline } from '../domain/remote-title.ts';
import { findListingById, type ListingRow, remoteProductListings } from '../repository/listings.ts';
import { markPushed } from '../repository/price-calculations.ts';
import { findRemoteSkuRow, countRemoteSkusOfProduct } from '../repository/remote-skus.ts';
import {
  cleanupPendingShopProduct,
  openAppShopProduct,
  pushingOfVariants,
  regroupCandidates,
  separateProductGroups,
  replacedListings,
  retiredAppShopProducts,
} from '../repository/regroup.ts';
import type { SyncError } from '../repository/schema.ts';
import { findShopProduct, setShopProductError, setShopProductExternal, setShopProductStatus, startRegroupShopProduct, type ShopProductRow } from '../repository/shop-products.ts';
import { findShopRow } from '../repository/shops.ts';
import { currentPrices } from './listing-prices.ts';
import { insertListing } from './listing-writes.ts';
import { errorOf } from './listing-push.ts';
import { ENTITY, moveListing, requesterNames, toListing } from './listings.ts';
import { MarketplaceError, PRECHECK_CODES, type MarketplaceAdapter } from './marketplaces/index.ts';
import { prepareNewProduct } from './new-product.ts';
import type { ProductPort } from './product-port.ts';
import { specChecks } from './product-specs.ts';
import { pushBlock } from './push-block.ts';
import { PUSH_IMAGE_MAX, type ProductRegroupJob, sendProductRegroup, sendStockPush } from './shop-jobs.ts';
import { type Actor, loseShopAuth, ownShop, platformOf, shopSession } from './shops.ts';

/** Lý do ghi lịch sử của listing cũ (listing `delisted`). */
export const REGROUP_REASON = 'Gom thành một sản phẩm';
/** `push_error.code` của dòng `shop_products` mới khi đã tạo xong mà chưa xoá được sản phẩm lẻ cũ (lượt sau thử lại). */
export const CLEANUP_FAILED = 'regroup_cleanup_failed';
/** Sản phẩm lẻ cũ còn SKU app không quản (hoặc listing chưa gỡ): không tự xoá, người dùng xử lý trên sàn. */
export const OLD_PRODUCTS_KEPT = 'regroup_old_products_kept';
/** Listing delist được theo máy trạng thái (`delist`). */
const DELISTABLE = ['live', 'hidden', 'under_review', 'platform_hold', 'rejected', 'push_failed'];

const productCount = (rows: readonly ListingRow[]) => new Set(rows.map((r) => r.externalProductId)).size;

/**
 * Request gom lại (21 §18.8.4). Thứ tự: 404 gian hàng, sản phẩm → 409 `shop_not_active` (và các mã chờ như đẩy),
 * `shop_not_connected` → 409 `nothing_to_regroup` → 409 `invalid_transition` kèm `current` → 409 `push_blocked` kèm
 * `rows` → xếp việc, 202. Còn nợ xoá sản phẩm lẻ của lượt trước (`regroup_cleanup_failed`) thì bỏ qua ba bước giữa và xếp
 * lại để thử xoá tiếp. Gọi ngoài `withCompany`.
 */
export async function requestRegroup(port: ProductPort, actor: Actor, shopId: string, productId: string): Promise<{ queued: true }> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const catalog = await port.variants(undefined, { productIds: [productId] });
    if (!catalog.length) throw new AppError(404, 'not_found', 'Không tìm thấy sản phẩm');
    if (shop.status !== 'active') {
      throw new AppError(409, 'shop_not_active', 'Hoàn tất thiết lập gian hàng trước khi gom sản phẩm', { current: shop.status });
    }
    if (shop.openingStocktakeNumber) {
      throw new AppError(409, 'shop_awaiting_stocktake', `Gian hàng đang chờ phiếu kiểm kho đầu kỳ ${shop.openingStocktakeNumber} hoàn thành`);
    }
    const waitingFor = awaitingAllocation(shop);
    if (waitingFor) throw new AppError(409, 'shop_awaiting_allocation', 'Gian hàng đang chờ chia hàng hoặc kéo đơn còn mở', { waitingFor });
    if (!shop.accessTokenEnc) {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
    }
    const { adapter } = platformOf(shop.platform);
    if (!adapter.deleteProducts) throw new AppError(422, 'marketplace_unsupported', `${adapter.name} chưa hỗ trợ xoá sản phẩm để gom lại`);
    const job = async () => {
      const [imageUrls, sizeChart] = await Promise.all([
        port.productImageUrls([productId], PUSH_IMAGE_MAX),
        port.productSizeChartUrls?.([productId]) ?? new Map<string, string>(),
      ]);
      await sendProductRegroup({
        companyId: actor.companyId,
        shopId,
        productId,
        startedAt: new Date().toISOString(),
        imageUrls: imageUrls.get(productId) ?? [],
        ...(sizeChart.get(productId) && { sizeChartUrl: sizeChart.get(productId) }),
      });
      return { queued: true as const };
    };
    if (await cleanupPendingShopProduct(shopId, productId)) return job();

    const variantIds = catalog.filter((v) => !v.archived).map((v) => v.id);
    const rows = await regroupCandidates(shopId, variantIds);
    if (productCount(rows) <= 1) {
      throw new AppError(409, 'nothing_to_regroup', 'Các SKU của sản phẩm trên gian hàng này đã nằm trong một sản phẩm sàn');
    }
    const names = await requesterNames(rows);
    const busy =
      (await pushingOfVariants(shopId, variantIds))[0] ??
      rows.find((r) => r.outsideChangeKind !== null || r.pendingRequestedBy !== null);
    if (busy) {
      throw new AppError(409, 'invalid_transition', 'Có listing đang đẩy, đang chờ quyết thay đổi ngoài app hoặc chờ duyệt ghép; xử lý trước khi gom', {
        current: toListing(busy, names),
      });
    }
    const open = await openAppShopProduct(shopId, productId);
    if (open && Date.now() - (open.pushStartedAt?.getTime() ?? 0) < STALE_PUSH_MS) {
      throw new AppError(409, 'invalid_transition', 'Sản phẩm đang được đẩy hay gom lên gian hàng này, chờ xong', { current: null });
    }
    const [imageUrls, sizeCharts, prices, specs] = await Promise.all([
      port.productImageUrls([productId], PUSH_IMAGE_MAX),
      port.productSizeChartUrls?.([productId]) ?? new Map<string, string>(),
      port.standardPrices(rows.map((r) => r.variantId!)),
      specChecks(port, shop, adapter, catalog),
    ]);
    const own = await currentPrices(rows.map((r) => r.variantId!), rows, prices);
    const variants = new Map(catalog.map((v) => [v.id, v]));
    const blocked = rows.flatMap((r) => {
      const v = variants.get(r.variantId!);
      if (!v || v.archived) return [{ variantId: r.variantId!, code: 'not_found' }];
      const price = own.get(v.id)?.price ?? null;
      const block = pushBlock(v, price === null ? null : new Decimal(price), specs.get(productId), (imageUrls.get(productId) ?? []).length > 0, sizeCharts.has(productId));
      return block ? [{ variantId: v.id, code: block.code }] : [];
    });
    if (blocked.length) throw new AppError(409, 'push_blocked', 'Có SKU chưa đủ điều kiện đẩy lên sàn', { rows: blocked });
    return job();
  });
}

/**
 * Việc nền gom lại. Dòng `shop_products` `app` mới giữ lượt (mốc `startedAt`, thử lại dùng lại dòng cũ); tạo sản phẩm sàn
 * nhiều SKU (bỏ chống trùng SellerSku); một giao dịch ghi mã sàn, `delist` listing cũ và tạo listing mới
 * (`replaces_listing_id`); rồi xoá sản phẩm lẻ cũ. Tạo lỗi: dòng mới `failed`, listing cũ giữ nguyên. Xoá lỗi: ghi
 * `regroup_cleanup_failed` lên dòng mới và ném để pg-boss thử lại (lượt sau chỉ xoá tiếp).
 */
export async function runProductRegroup(port: ProductPort, job: ProductRegroupJob, attempt?: JobAttempt): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const shop = await inCompany(() => findShopRow(job.shopId));
  if (!shop || shop.status === 'disconnected') {
    logger.warn({ shopId: job.shopId, productId: job.productId }, 'Gom sản phẩm: gian hàng đã ngắt, bỏ việc');
    return;
  }
  if (shop.status === 'needs_reauth') throw new HoldJob('gian hàng mất uỷ quyền');
  const { adapter, accessToken } = await inCompany(() => shopSession(job.shopId));
  if (!adapter.deleteProducts) return;
  const pending = await inCompany(() => cleanupPendingShopProduct(job.shopId, job.productId));
  if (pending) {
    await cleanupOldProducts(job, pending, adapter, accessToken);
    return;
  }
  const catalog = await inCompany(() => port.variants(undefined, { productIds: [job.productId] }));
  const variantIds = catalog.filter((v) => !v.archived).map((v) => v.id);
  const rows = await inCompany(() => regroupCandidates(job.shopId, variantIds));
  if (productCount(rows) <= 1) return;
  const startedAt = new Date(job.startedAt);
  if (Date.now() - startedAt.getTime() > STALE_PUSH_MS) {
    logger.warn({ shopId: job.shopId, productId: job.productId }, 'Gom sản phẩm: quá 30 phút chưa chạy, bỏ việc');
    return;
  }
  const begun = await inCompany(() => startRegroupShopProduct(job.companyId, job.shopId, job.productId, startedAt));
  if (!begun) return;
  const sp = begun.row;
  // Lỗi: dòng mới `failed` trước, rồi trả `active` cho dòng `app` cũ đã nhường chỗ (unique một phần).
  const fail = (error: SyncError) =>
    inCompany(async () => {
      await setShopProductStatus(sp.id, 'failed', error);
      for (const id of new Set([...begun.retired, ...(await retiredAppShopProducts(job.shopId, variantIds))])) await setShopProductStatus(id, 'active');
    });

  try {
    const prepared = await prepareNewProduct({
      port,
      companyId: job.companyId,
      shop,
      adapter,
      accessToken,
      productId: job.productId,
      rows,
      imageUrls: job.imageUrls,
      sizeChartUrl: job.sizeChartUrl,
      idempotencyKey: `cm-sp-${sp.id}-${startedAt.getTime()}`,
    });
    if (!prepared.ok) {
      await fail(errorOf('push_blocked', prepared.blocked.map((b) => `${b.row.sellerSku ?? b.row.variantId}: ${b.code}`).join('; ')));
      return;
    }
    const { product, ready } = prepared;
    const result = await adapter.createProduct(accessToken, product);
    const created = new Map((result.skus ?? [{ sellerSku: product.skus![0]!.sellerSku, externalSkuId: result.externalSkuId }]).map((s) => [s.sellerSku, s.externalSkuId]));
    const at = new Date();
    await inCompany(async () => {
      await setShopProductExternal(sp.id, result.externalProductId);
      let moved = 0;
      for (const r of ready) {
        const externalSkuId = created.get(r.sku.sellerSku);
        const old = await findListingById(r.row.id);
        if (!externalSkuId || !old || !DELISTABLE.includes(old.status)) {
          logger.warn({ listingId: r.row.id, status: old?.status, created: Boolean(externalSkuId) }, 'Gom sản phẩm: bỏ qua listing, giữ listing cũ');
          continue;
        }
        await moveListing(old, 'delist', null, { hiddenBy: null, platformStock: 0 }, REGROUP_REASON);
        const row = await insertListing({
          companyId: job.companyId,
          shopId: job.shopId,
          variantId: old.variantId,
          sellerSku: old.sellerSku ?? r.sku.sellerSku,
          status: 'pushing',
          pushStartedAt: startedAt,
          replacesListingId: old.id,
          contentSource: 'app',
          shopProductId: sp.id,
          manualPrice: old.manualPrice,
          priceCalcId: old.priceCalcId,
        });
        await recordTransition({ entityType: ENTITY, entityId: row.id, from: null, to: 'pushing', action: 'push', actorId: null, reason: REGROUP_REASON });
        const remote = await findRemoteSkuRow(job.shopId, externalSkuId);
        await moveListing(row, result.live ? 'go_live' : 'send_review', null, {
          externalProductId: result.externalProductId,
          externalSkuId,
          externalImageUrls: product.imageUrls,
          externalCategoryId: product.externalCategoryId,
          pushError: null,
          ...sentBaseline(product.name, remote, at),
          listedPrice: r.priceText,
          priceSync: 'synced',
          priceSyncError: null,
          lastPushedAt: at,
          lastPricePushedAt: at,
          platformStock: r.sku.quantity ?? 0,
          stockSync: r.untrusted ? 'pending' : 'synced',
          stockSyncError: null,
        });
        if (r.shopPrice && r.row.priceCalcId) await markPushed(r.row.priceCalcId);
        moved += 1;
      }
      if (moved) await sendStockPush(job.companyId, job.shopId);
    });
  } catch (err) {
    if (!(err instanceof MarketplaceError)) throw err;
    if (err.kind === 'unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi gom sản phẩm');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    if (err.kind === 'unavailable' && !attempt?.lastAttempt) throw err;
    const code = err.kind === 'unavailable' ? 'marketplace_unavailable' : err.platformCode && PRECHECK_CODES.has(err.platformCode) ? err.platformCode : 'marketplace_rejected';
    await fail(errorOf(code, err.platformMessage ?? 'Sàn từ chối sản phẩm'));
    return;
  }
  const done = await inCompany(() => findShopProduct(sp.id));
  await cleanupOldProducts(job, done ?? sp, adapter, accessToken);
}

/**
 * Xoá các sản phẩm lẻ cũ mà listing của `sp` đã thay. Chỉ xoá sản phẩm sàn không còn listing chưa gỡ và không còn SKU lạ
 * (bản sao `remote_skus` nhiều hơn số listing đã gỡ ở đó): SKU người bán không quản không bị xoá theo. Xoá lỗi thì ghi
 * `regroup_cleanup_failed` và ném để thử lại; sản phẩm giữ lại thì ghi `regroup_old_products_kept` (không thử lại).
 */
async function cleanupOldProducts(job: ProductRegroupJob, sp: ShopProductRow, adapter: MarketplaceAdapter, accessToken: string): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const { deletable, kept } = await inCompany(async () => {
    const replaced = (await replacedListings(sp.id)).filter((l) => l.externalProductId && l.externalProductId !== sp.externalProductId);
    const byProduct = new Map<string, number>();
    for (const l of replaced) byProduct.set(l.externalProductId!, (byProduct.get(l.externalProductId!) ?? 0) + 1);
    const deletable: string[] = [];
    const kept: string[] = [];
    for (const [id, ours] of byProduct) {
      const stillListed = (await remoteProductListings([{ shopId: job.shopId, externalProductId: id }])).length > 0;
      const onPlatform = await countRemoteSkusOfProduct(job.shopId, id);
      (stillListed || onPlatform > ours ? kept : deletable).push(id);
    }
    return { deletable, kept };
  });
  try {
    if (deletable.length) await adapter.deleteProducts!(accessToken, deletable);
  } catch (err) {
    if (!(err instanceof MarketplaceError)) throw err;
    if (err.kind === 'unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi xoá sản phẩm cũ');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    logger.warn({ err, shopId: job.shopId, externalProductIds: deletable }, 'Gom sản phẩm: chưa xoá được sản phẩm lẻ cũ trên sàn');
    await inCompany(() => setShopProductError(sp.id, errorOf(CLEANUP_FAILED, `Chưa xoá được sản phẩm cũ trên sàn (${deletable.join(', ')}): ${err.platformMessage ?? err.platformCode ?? err.kind}`)));
    throw err;
  }
  await inCompany(() =>
    setShopProductError(
      sp.id,
      kept.length ? errorOf(OLD_PRODUCTS_KEPT, `Sản phẩm cũ ${kept.join(', ')} còn SKU khác trên sàn, không tự xoá; xử lý trên Seller Center`) : null,
    ),
  );
}

/**
 * `separateProducts` của `GET /channel/products/:productId/listings` (#295): theo gian hàng chưa ngắt, số sản phẩm sàn khác
 * nhau của listing chưa gỡ của các biến thể chưa lưu trữ; chỉ gian hàng có hơn một. Gọi trong `withCompany`.
 */
export async function separateProductsOf(port: ProductPort, productId: string): Promise<{ shopId: string; platform: string; productCount: number }[]> {
  const variants = await port.variants(undefined, { productIds: [productId] });
  return separateProductGroups(variants.filter((v) => !v.archived).map((v) => v.id));
}
