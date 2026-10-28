// Listing: danh sách, đẩy lên sàn, gỡ (#104; Documents/21 §18.3, §18.4). Gọi sàn ngoài giao dịch (#104 A3):
// ghi `pushing` rồi commit, gọi sàn, ghi kết quả trong giao dịch mới.
import type { Decimal } from 'decimal.js';
import { assertTransition, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { type ListingAction, type ListingStatus, listingMachine } from '../domain/listing.ts';
import { type CategoryMapRow, listCategoryMaps } from '../repository/category-maps.ts';
import {
  findListingRow,
  insertListing,
  type ListingPatch,
  type ListingRow,
  listListingRows,
  updateListing,
} from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import { type MarketplaceAdapter, MarketplaceError } from './marketplaces/index.ts';
import type { ListingVariant, ProductPort } from './product-port.ts';
import { type Actor, onMarketplace, ownShop, shopSession } from './shops.ts';

const ENTITY = 'listings';
/** Mỗi lần đẩy tối đa 20 biến thể: gọi sàn lần lượt trong một request (#104 A3). */
export const PUSH_LIMIT = 20;

export interface ChannelListing {
  id: string;
  externalProductId: string | null;
  externalSkuId: string | null;
  sellerSku: string | null;
  status: ListingStatus;
  rejectReason: string | null;
  pushError: string | null;
  pushAttempts: number;
  hiddenBy: ListingRow['hiddenBy'];
  stockSync: ListingRow['stockSync'];
  priceSync: ListingRow['priceSync'];
  platformStock: number | null;
  stockSyncError: SyncError | null;
  priceSyncError: SyncError | null;
  /** Cảnh báo QC (§18.4): chưa đọc từ sàn, luôn null. */
  qcAlert: null;
  lastPushedAt: Date | null;
  lastPushedPrice: number | null;
  version: number;
}

export interface ListingRowView {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  attributesLabel: string;
  /** Catalog chưa lưu ảnh (#104 Q1). */
  thumbnailUrl: null;
  price: number | null;
  priceSource: 'standard' | null;
  listing: ChannelListing | null;
}

export interface PushResult {
  variantId: string;
  sku: string;
  outcome: 'created' | 'updated' | 'failed';
  status?: ListingStatus;
  externalSkuId?: string;
  code?: string;
  message?: string;
}

export function toListing(r: ListingRow): ChannelListing {
  return {
    id: r.id,
    externalProductId: r.externalProductId,
    externalSkuId: r.externalSkuId,
    sellerSku: r.sellerSku,
    status: r.status,
    rejectReason: r.rejectReason,
    pushError: r.pushError,
    pushAttempts: r.pushAttempts,
    hiddenBy: r.hiddenBy,
    stockSync: r.stockSync,
    priceSync: r.priceSync,
    platformStock: r.platformStock,
    stockSyncError: r.stockSyncError,
    priceSyncError: r.priceSyncError,
    qcAlert: null,
    lastPushedAt: r.lastPushedAt,
    lastPushedPrice: r.listedPrice === null ? null : Number(r.listedPrice),
    version: r.version,
  };
}

/** Mọi biến thể đang bán kèm giá chuẩn và listing trên gian hàng này. Gọi trong `withCompany`. */
export async function listListings(port: ProductPort, shopId: string): Promise<{ items: ListingRowView[] }> {
  const shop = await ownShop(shopId);
  const variants = (await port.variants()).filter((v) => !v.archived);
  const prices = await port.standardPrices(variants.map((v) => v.id));
  const byVariant = new Map((await listListingRows(shop.id)).map((l) => [l.variantId, l]));
  return {
    items: variants.map((v) => {
      const price = prices.get(v.id) ?? null;
      const listing = byVariant.get(v.id);
      return {
        variantId: v.id,
        productId: v.productId,
        productName: v.productName,
        sku: v.sku,
        attributesLabel: v.attributesLabel,
        thumbnailUrl: null,
        price: price === null ? null : price.toNumber(),
        priceSource: price === null ? null : 'standard',
        listing: listing ? toListing(listing) : null,
      };
    }),
  };
}

/**
 * Chuyển trạng thái listing theo máy trạng thái, ghi lịch sử; 409 khi listing vừa đổi. `by` null: sàn hoặc hệ thống.
 * Gọi trong `withCompany`.
 */
export async function moveListing(
  row: ListingRow,
  action: ListingAction,
  by: Actor | null,
  patch: ListingPatch = {},
  reason: string | null = null,
): Promise<ListingRow> {
  const { to } = assertTransition(listingMachine, row.status, action, { actor: by, view: toListing(row) });
  const updated = await updateListing(row.id, { version: row.version, status: row.status }, { ...patch, status: to });
  if (!updated) throw new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
  const actorId = by?.accountId ?? null;
  await recordTransition({ entityType: ENTITY, entityId: row.id, from: row.status, to, action, actorId, reason });
  return updated;
}

const fail = (variantId: string, sku: string, code: string, message: string, status?: ListingStatus): PushResult => ({
  variantId,
  sku,
  outcome: 'failed',
  code,
  message,
  ...(status && { status }),
});

interface PushContext {
  actor: Actor;
  shopId: string;
  adapter: MarketplaceAdapter;
  accessToken: string;
  imageUrls: Record<string, string[]>;
}

/**
 * Đẩy biến thể lên sàn: tạo sản phẩm mới (một SKU một sản phẩm, #104 A1). Thất bại theo dòng, không hỏng cả lô.
 * Listing đã có mã trên sàn thì giá và tồn đồng bộ bằng `sync`; sửa nội dung (`/product/update`) chưa làm.
 */
export async function pushListings(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { variantIds: string[]; imageUrls: Record<string, string[]> },
): Promise<{ results: PushResult[] }> {
  const { shop, adapter, accessToken } = await withCompany(actor.companyId, () => shopSession(shopId));
  const ids = [...new Set(input.variantIds)];
  const { variants, prices, available, maps } = await withCompany(actor.companyId, async () => {
    const variants = new Map((await port.variants(ids)).map((v) => [v.id, v]));
    return {
      variants,
      prices: await port.standardPrices(ids),
      available: await port.availableOf(ids),
      maps: new Map(
        (await listCategoryMaps(shop.platform, [...new Set([...variants.values()].map((v) => v.categoryId))])).map((m) => [
          m.categoryId,
          m,
        ]),
      ),
    };
  });
  const ctx: PushContext = { actor, shopId: shop.id, adapter, accessToken, imageUrls: input.imageUrls };
  const results: PushResult[] = [];
  for (const variantId of ids) {
    const v = variants.get(variantId);
    if (!v || v.archived) {
      results.push(fail(variantId, v?.sku ?? variantId, 'not_found', 'Biến thể không còn bán'));
      continue;
    }
    results.push(await pushOne(ctx, v, prices.get(v.id) ?? null, available.get(v.id) ?? 0, maps.get(v.categoryId)));
  }
  return { results };
}

async function pushOne(
  ctx: PushContext,
  v: ListingVariant,
  price: Decimal | null,
  quantity: number,
  map: CategoryMapRow | undefined,
): Promise<PushResult> {
  const { actor, shopId } = ctx;
  const existing = await withCompany(actor.companyId, () => findListingRow(shopId, v.id));
  if (existing?.status === 'pushing') return fail(v.id, v.sku, 'push_in_progress', 'Đang đẩy, chờ sàn trả kết quả', 'pushing');
  if (existing?.status === 'platform_hold') return fail(v.id, v.sku, 'platform_hold', 'Sàn đang khoá listing này', 'platform_hold');
  if (existing?.externalSkuId) {
    return fail(v.id, v.sku, 'already_listed', 'Đã có trên sàn: giá và tồn cập nhật bằng Đồng bộ', existing.status);
  }
  if (price === null) return fail(v.id, v.sku, 'price_missing', 'Chưa có giá chuẩn', existing?.status);
  if (!map) return fail(v.id, v.sku, 'category_unmapped', 'Danh mục chưa ghép với danh mục của sàn', existing?.status);
  const { weightG, lengthMm, widthMm, heightMm } = v;
  if (!weightG || !lengthMm || !widthMm || !heightMm) {
    return fail(v.id, v.sku, 'dimensions_missing', 'Thiếu cân nặng hoặc kích thước gói của SKU', existing?.status);
  }
  const sourceImages = existing?.externalImageUrls?.length ? null : (ctx.imageUrls[v.productId] ?? []);
  if (sourceImages && !sourceImages.length) {
    return fail(v.id, v.sku, 'images_missing', 'Sàn bắt buộc ảnh: gửi kèm URL ảnh của sản phẩm', existing?.status);
  }

  // Ghi `pushing` và commit trước khi gọi sàn.
  let row = await withCompany(actor.companyId, async () => {
    if (existing) return moveListing(existing, 'push', actor, { pushStartedAt: new Date() });
    const created = await insertListing({
      companyId: actor.companyId,
      shopId,
      variantId: v.id,
      sellerSku: v.sku,
      status: 'pushing',
      pushStartedAt: new Date(),
    });
    await recordTransition({ entityType: ENTITY, entityId: created.id, from: null, to: 'pushing', action: 'push', actorId: actor.accountId });
    return created;
  });

  const priceText = price.toFixed(0);
  try {
    const imageUrls =
      row.externalImageUrls?.length ? row.externalImageUrls : await uploadAll(ctx, sourceImages ?? []);
    const createdOnPlatform = await ctx.adapter.createProduct(ctx.accessToken, {
      externalCategoryId: map.externalCategoryId,
      attributes: map.attributes,
      name: v.attributesLabel ? `${v.productName} - ${v.attributesLabel}` : v.productName,
      description: v.description ?? v.productName,
      imageUrls,
      sellerSku: v.sku,
      price: priceText,
      quantity,
      weightG,
      lengthMm,
      widthMm,
      heightMm,
    });
    row = await withCompany(actor.companyId, async () =>
      moveListing(row, createdOnPlatform.live ? 'go_live' : 'send_review', null, {
        externalProductId: createdOnPlatform.externalProductId,
        externalSkuId: createdOnPlatform.externalSkuId,
        externalImageUrls: imageUrls,
        pushError: null,
        listedPrice: priceText,
        lastPushedAt: new Date(),
        platformStock: quantity,
        stockSync: 'synced',
        priceSync: 'synced',
        stockSyncError: null,
        priceSyncError: null,
      }),
    );
    return { variantId: v.id, sku: v.sku, outcome: 'created', status: row.status, externalSkuId: createdOnPlatform.externalSkuId };
  } catch (err) {
    if (!(err instanceof MarketplaceError)) throw err;
    const transient = err.kind === 'unavailable';
    const message = transient ? 'Sàn lỗi tạm, đẩy lại sau' : (err.platformMessage ?? 'Sàn từ chối sản phẩm');
    row = await withCompany(actor.companyId, async () =>
      moveListing(row, 'fail', null, { pushError: message, pushAttempts: row.pushAttempts + 1 }, err.platformCode),
    );
    const code = transient ? 'marketplace_unavailable' : 'marketplace_rejected';
    return fail(v.id, v.sku, code, message, row.status);
  }
}

async function uploadAll(ctx: PushContext, urls: string[]) {
  const out: string[] = [];
  for (const url of urls) out.push(await ctx.adapter.uploadImage(ctx.accessToken, url));
  return out;
}

/** Gỡ khỏi sàn (§18.3): tắt sản phẩm trên sàn rồi chuyển `delisted`, giữ ghép để đẩy lại. */
export async function delistListing(actor: Actor, shopId: string, variantId: string, version: number): Promise<ChannelListing> {
  const { adapter, accessToken } = await withCompany(actor.companyId, () => shopSession(shopId));
  const row = await withCompany(actor.companyId, () => findListingRow(shopId, variantId));
  if (!row) throw new AppError(404, 'not_found', 'Biến thể chưa có listing trên gian hàng này');
  if (row.version !== version) {
    throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', { current: toListing(row) });
  }
  assertTransition(listingMachine, row.status, 'delist', { actor, view: toListing(row) });
  const { externalProductId, externalSkuId } = row;
  if (externalProductId && externalSkuId) {
    await onMarketplace(() => adapter.deactivate(accessToken, externalProductId, externalSkuId));
  }
  const updated = await withCompany(actor.companyId, () =>
    moveListing(row, 'delist', actor, { hiddenBy: null, platformStock: 0 }),
  );
  return toListing(updated);
}
