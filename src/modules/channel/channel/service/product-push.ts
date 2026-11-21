// Việc nền đẩy các SKU của một sản phẩm cha thành phân loại của một sản phẩm sàn (#295, Documents/21 §18.8.4). Request `push`
// gom SKU theo cha, chuyển `pushing` và xếp `channel.product_push`; việc này gọi sàn ngoài giao dịch rồi ghi kết quả từng SKU.
// Cha chưa có sản phẩm trên gian hàng: tạo một sản phẩm nhiều phân loại. Có rồi: thêm phân loại (`addVariants`).
import { Decimal } from 'decimal.js';
import { HoldJob, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { STALE_PUSH_MS } from '../domain/listing.ts';
import { groupVariants } from '../domain/variant-group.ts';
import { sentBaseline } from '../domain/remote-title.ts';
import { findListingByExternalSku, type ListingRow, pushingRowsOfShopProduct } from '../repository/listings.ts';
import { markPushed } from '../repository/price-calculations.ts';
import { findRemoteSkuRow } from '../repository/remote-skus.ts';
import {
  findShopProduct,
  markShopProductCreateAttempted,
  setShopProductError,
  setShopProductExternal,
  type ShopProductRow,
} from '../repository/shop-products.ts';
import type { SyncError } from '../repository/schema.ts';
import { findShopRow } from '../repository/shops.ts';
import { currentPrices } from './listing-prices.ts';
import { CLOCK_SKEW_MS, errorOf, finish, PUSH_ATTEMPTS, refreshPermission, sizeChartRuleOf, uploadAll } from './listing-push.ts';
import { countedOf } from './listing-sync.ts';
import { updateListing } from './listing-writes.ts';
import { type CreatedSku, MarketplaceError, type NewProduct, PRECHECK_CODES, type ProductSku } from './marketplaces/index.ts';
import { evaluatePrices } from './price-inputs.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { ensureLeaf } from './platform-categories.ts';
import { pushAttributes, specChecks } from './product-specs.ts';
import { pushBlock } from './push-block.ts';
import type { ProductPushJob } from './shop-jobs.ts';
import { loseShopAuth, shopSession } from './shops.ts';
import { untrustedVariants } from './stock-trust.ts';

interface Ready {
  row: ListingRow;
  v: ListingVariant;
  sku: ProductSku;
  priceText: string;
  shopPrice: boolean;
  untrusted: boolean;
}

/**
 * Chạy một lượt đẩy theo cha. Dòng `shop_products` không còn `active` hay mốc lượt khác `pushStartedAt` (lượt mới hơn đã
 * thay) thì bỏ. SKU bị chặn (giá, kích thước, dưới giá thấp nhất) thì `fail` riêng SKU đó, đẩy các SKU còn lại (§18.8.4: cả
 * hai sàn thêm phân loại sau được). Kết quả theo từng SKU, ghép theo `seller_sku`: SKU sàn trả về thì `go_live` hoặc
 * `send_review`, SKU sàn không nhận thì `fail`. Lỗi tạm ném để pg-boss thử lại (tới `PUSH_ATTEMPTS` thì `fail` cả lượt); sàn
 * từ chối thì `fail` cả lượt ngay; mất uỷ quyền thì giữ việc (`HoldJob`).
 */
export async function runProductPush(port: ProductPort, job: ProductPushJob): Promise<void> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(job.companyId, fn);
  const sp = await inCompany(() => findShopProduct(job.shopProductId));
  if (!sp || sp.status !== 'active' || sp.pushStartedAt?.toISOString() !== job.pushStartedAt) return;
  const rows = await inCompany(() => pushingRowsOfShopProduct(sp.id));
  if (!rows.length) return;
  const failAll = (pushError: SyncError, extra: { pushAttempts?: number } = {}) =>
    Promise.all(rows.map((row) => finish(job, row, 'fail', { pushError, ...(extra.pushAttempts !== undefined && { pushAttempts: extra.pushAttempts }) })));
  if (new Date(job.pushStartedAt).getTime() < Date.now() - STALE_PUSH_MS) {
    await failAll(errorOf('marketplace_unavailable', 'Quá 30 phút chưa có kết quả từ sàn, đăng bán lại'));
    return;
  }
  const shop = await inCompany(() => findShopRow(job.shopId));
  if (!shop || shop.status === 'disconnected') {
    await failAll(errorOf('shop_not_connected', 'Gian hàng đã ngắt'));
    return;
  }
  if (shop.status === 'needs_reauth') throw new HoldJob('gian hàng mất uỷ quyền');
  const session = await inCompany(() => shopSession(job.shopId));
  const { adapter, accessToken } = session;
  if (sp.externalProductId && !adapter.addVariants) {
    await failAll(errorOf('variant_add_unsupported', `${adapter.name} không thêm được phân loại vào sản phẩm đã có`));
    return;
  }

  const productId = sp.productId ?? job.productId;
  if (!productId) {
    await failAll(errorOf('not_found', 'Không xác định được sản phẩm của lượt đẩy, đăng bán lại'));
    return;
  }
  const specOf = async () => (await specChecks(port, shop, adapter, await port.variants(undefined, { productIds: [productId] }))).get(productId);
  const first = await inCompany(specOf);
  if (first && adapter.leafAttributes) {
    try {
      await ensureLeaf(shop.companyId, shop.platform, adapter, first.externalCategoryId, { shopId: shop.id });
    } catch (err) {
      if (!(err instanceof MarketplaceError) && !(err instanceof AppError)) throw err;
    }
  }
  if (first) await refreshPermission(shop, adapter, accessToken, first.externalCategoryId);

  const variantIds = rows.map((r) => r.variantId!);
  const data = await inCompany(async () => {
    const map = await specOf();
    const variants = new Map((await port.variants(variantIds)).map((v) => [v.id, v]));
    const prices = await currentPrices(variantIds, rows, await port.standardPrices(variantIds));
    const available = await port.availableOf(variantIds);
    const untrusted = await untrustedVariants();
    const counted = await countedOf(port, variantIds);
    const shopPrices = new Map(variantIds.flatMap((id) => (prices.get(id)?.priceSource === 'shop' ? [[id, String(prices.get(id)!.price)] as const] : [])));
    const floors = shopPrices.size ? (await evaluatePrices(shop.id, shopPrices)).results : new Map();
    return { map, variants, prices, available, untrusted, counted, floors, responsible: await responsibleOrgOf(shop.companyId) };
  });
  const { map } = data;
  const sizeChartRule = map ? await sizeChartRuleOf(adapter, accessToken, map) : null;
  const ready: Ready[] = [];
  for (const row of rows) {
    const v = data.variants.get(row.variantId!);
    if (!v || v.archived) {
      await finish(job, row, 'fail', { pushError: errorOf('not_found', 'Biến thể không còn bán') });
      continue;
    }
    const own = data.prices.get(v.id)!;
    const price = own.price === null ? null : new Decimal(own.price);
    const floor = data.floors.get(v.id);
    if (floor !== undefined && (!floor.ok || floor.belowFloor === true)) {
      await finish(job, row, 'fail', { pushError: errorOf('below_floor', 'Giá theo bộ lọc giá của gian hàng có thực nhận dưới giá thấp nhất') });
      continue;
    }
    const block = pushBlock(v, price, map && { ...map, sizeChartRule }, Boolean(job.imageUrls.length), Boolean(job.sizeChartUrl));
    if (block) {
      await finish(job, row, 'fail', { pushError: errorOf(block.code, block.message) });
      continue;
    }
    const untrusted = data.untrusted.has(v.id);
    const quantity = untrusted || !data.counted.has(v.id) ? 0 : (data.available.get(v.id) ?? 0);
    const priceText = price!.toFixed(0);
    const sku = { sellerSku: row.sellerSku ?? v.sku, price: priceText, quantity, values: [], weightG: v.weightG!, lengthMm: v.lengthMm!, widthMm: v.widthMm!, heightMm: v.heightMm! };
    ready.push({ row, v, sku, priceText, shopPrice: own.priceSource === 'shop', untrusted });
  }
  if (!ready.length) return;
  const group = groupVariants(
    ready.map((r) => ({ id: r.v.id, attributes: r.v.attributes })),
    map!.row.axisMap,
    map!.attributes,
  );
  if (!group.ok) {
    await Promise.all(ready.map((r) => finish(job, r.row, 'fail', { pushError: errorOf(group.code, group.message) })));
    return;
  }
  for (const r of ready) r.sku.values = group.valuesOf.get(r.v.id)!;
  const lead = ready[0]!.v;

  try {
    const imageUrls = await uploadAll(adapter, accessToken, job.imageUrls);
    const sizeChartUri =
      job.sizeChartUrl && sizeChartRule !== 'unsupported' ? await adapter.uploadImage(accessToken, job.sizeChartUrl, 'size_chart') : null;
    const product: NewProduct = {
      externalCategoryId: map!.externalCategoryId,
      attributes: pushAttributes(map!.attributes, map!.resolved),
      responsible: data.responsible,
      brand: lead.brand ?? null,
      // Tiêu đề là tên sản phẩm cha (§18.8.4), không ghép nhãn biến thể.
      name: lead.productName,
      description: lead.description ?? lead.productName,
      imageUrls,
      ...(sizeChartUri && { sizeChartUri }),
      ...ready[0]!.sku,
      ...(group.axes.length && { salesAttributes: group.axes }),
      skus: ready.map((r) => r.sku),
      idempotencyKey: `cm-sp-${sp.id}-${new Date(job.pushStartedAt).getTime()}`,
    };
    let created: { externalProductId: string; skus: CreatedSku[]; live: boolean };
    if (sp.externalProductId) {
      const added = await adapter.addVariants!(accessToken, sp.externalProductId, { ...product, skus: product.skus! });
      created = { externalProductId: sp.externalProductId, ...added };
    } else {
      await inCompany(() => markShopProductCreateAttempted(sp.id, new Date()));
      const result = await adapter.createProduct(accessToken, product);
      const skus = result.skus ?? [{ sellerSku: product.skus![0]!.sellerSku, externalSkuId: result.externalSkuId }];
      if (result.existing) {
        const refused = await existingRefusal(job, sp, ready, skus, result.createdAt, adapter.name, result.title);
        if (refused) {
          await inCompany(() => markShopProductCreateAttempted(sp.id, sp.createAttemptedAt));
          await Promise.all(ready.map((r) => finish(job, r.row, 'fail', { pushError: refused, pushAttempts: r.row.pushAttempts + 1 })));
          return;
        }
      }
      await inCompany(() => setShopProductExternal(sp.id, result.externalProductId));
      created = { externalProductId: result.externalProductId, skus, live: result.live };
    }
    await recordResults(job, sp, ready, created, imageUrls, product);
  } catch (err) {
    if (!(err instanceof MarketplaceError)) throw err;
    if (err.kind === 'unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi đẩy listing');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    const attempts = Math.max(...ready.map((r) => r.row.pushAttempts)) + 1;
    if (err.kind === 'unavailable') {
      const pushError = errorOf('marketplace_unavailable', err.platformMessage ?? 'Sàn lỗi tạm, đang thử lại');
      if (attempts < PUSH_ATTEMPTS) {
        await inCompany(async () => {
          await setShopProductError(sp.id, pushError);
          for (const r of ready) await updateListing(r.row.id, { version: r.row.version, status: 'pushing' }, { pushError, pushAttempts: attempts });
        });
        throw err;
      }
      await inCompany(() => setShopProductError(sp.id, pushError));
      await Promise.all(ready.map((r) => finish(job, r.row, 'fail', { pushError, pushAttempts: attempts }, err.platformCode)));
      return;
    }
    const message = err.platformMessage ?? (err.kind === 'unsupported' ? 'Sàn chưa hỗ trợ đăng bán sản phẩm' : 'Sàn từ chối sản phẩm');
    const code = err.platformCode && PRECHECK_CODES.has(err.platformCode) ? err.platformCode : 'marketplace_rejected';
    const pushError = errorOf(code, message);
    await inCompany(() => setShopProductError(sp.id, pushError));
    await Promise.all(ready.map((r) => finish(job, r.row, 'fail', { pushError, pushAttempts: attempts }, err.platformCode)));
  }
}

/**
 * Sàn đã có các SellerSku của lượt trong một sản phẩm (#346, #399): nhận khi sản phẩm sinh ra trong lần gọi tạo ngay trước của
 * chính dòng này (giờ tạo lệch dưới `CLOCK_SKEW_MS`) và không SKU nào thuộc listing khác; không thì trả lỗi để `fail` cả lượt.
 */
async function existingRefusal(
  job: ProductPushJob,
  sp: ShopProductRow,
  ready: readonly Ready[],
  skus: readonly CreatedSku[],
  createdAt: Date | undefined,
  platformName: string,
  title: string | undefined,
): Promise<SyncError | null> {
  const mine = new Set(ready.map((r) => r.row.id));
  for (const s of skus) {
    const owner = await withCompany(job.companyId, () => findListingByExternalSku(job.shopId, s.externalSkuId));
    if (owner && !mine.has(owner.id)) {
      return errorOf('marketplace_rejected', `SKU người bán ${s.sellerSku} đã có trên sàn và đang liên kết với variant khác; liên kết SKU tay hoặc đổi SKU`);
    }
  }
  const previousCall = sp.createAttemptedAt;
  if (!previousCall || !createdAt || Math.abs(createdAt.getTime() - previousCall.getTime()) > CLOCK_SKEW_MS) {
    const named = title ? ` (${title})` : '';
    return errorOf('sku_exists_on_platform', `SKU ${skus.map((s) => s.sellerSku).join(', ')} đã có trên ${platformName}${named}. Dùng Liên kết SKU thay vì đăng bán.`);
  }
  return null;
}

/** Ghi kết quả từng SKU theo `seller_sku`; SKU sàn không trả về là sàn không nhận phân loại đó. */
async function recordResults(
  job: ProductPushJob,
  sp: ShopProductRow,
  ready: readonly Ready[],
  created: { externalProductId: string; skus: readonly CreatedSku[]; live: boolean },
  imageUrls: string[],
  product: NewProduct,
): Promise<void> {
  const bySeller = new Map(created.skus.map((s) => [s.sellerSku, s.externalSkuId]));
  const at = new Date();
  for (const r of ready) {
    const externalSkuId = bySeller.get(r.sku.sellerSku);
    if (!externalSkuId) {
      await finish(job, r.row, 'fail', { pushError: errorOf('marketplace_rejected', 'Sàn không nhận phân loại này'), pushAttempts: r.row.pushAttempts + 1 });
      continue;
    }
    if (r.shopPrice && r.row.priceCalcId) await withCompany(job.companyId, () => markPushed(r.row.priceCalcId!));
    const remote = await withCompany(job.companyId, () => findRemoteSkuRow(job.shopId, externalSkuId));
    await finish(job, r.row, created.live ? 'go_live' : 'send_review', {
      shopProductId: sp.id,
      externalProductId: created.externalProductId,
      externalSkuId,
      externalImageUrls: imageUrls,
      pushError: null,
      externalCategoryId: product.externalCategoryId,
      contentSource: 'app',
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
  }
}
