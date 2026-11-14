// Listing: danh sách, đẩy lên sàn, gỡ (#104; Documents/21 §18.3, §18.4, §18.6.4). Đẩy chạy nền (#219): request chỉ
// kiểm, chuyển `pushing` và xếp việc `channel.listing_push` (`listing-push.ts`) trong cùng giao dịch, trả ngay.
import { assertTransition, findAccountSummaries, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { DELISTED_REASON, type ListingAction, type ListingStatus, listingMachine, NO_PENDING, pendingOnly } from '../domain/listing.ts';
import { awaitingAllocation } from '../domain/shop.ts';
import { listCategoryMaps } from '../repository/category-maps.ts';
import {
  currentListingRows,
  deleteListing,
  findListingRow,
  insertListing,
  type ListingPatch,
  type ListingRow,
  updateListing,
} from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import type { ShopRow } from '../repository/shops.ts';
import type { ProductPort } from './product-port.ts';
import { pushBlock } from './push-block.ts';
import { sendListingPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, ownShop, shopSession } from './shops.ts';

const ENTITY = 'listings';
/** Mỗi lần đẩy tối đa 20 biến thể (`PushBody`). */
export const PUSH_LIMIT = 20;
/** Trạng thái đã có trên sàn: đẩy nữa là `already_listed` (sửa nội dung listing đang bán là #293). */
const LISTED: readonly ListingStatus[] = ['under_review', 'live', 'hidden'];

export interface ChannelListing {
  id: string;
  externalProductId: string | null;
  externalSkuId: string | null;
  sellerSku: string | null;
  status: ListingStatus;
  rejectReason: string | null;
  pushError: SyncError | null;
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
  /** Ghép chờ CEO duyệt (§18.6.5); `variantId` null là "không quản tồn". */
  pendingMapping: { variantId: string | null; requestedBy: { id: string; name: string }; requestedAt: Date } | null;
  version: number;
}

export interface ListingRowView {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  attributesLabel: string;
  /** Ảnh đại diện catalog của sản phẩm (#303); null khi chưa có ảnh. */
  thumbnailUrl: string | null;
  price: number | null;
  priceSource: 'standard' | null;
  listing: ChannelListing | null;
}

/**
 * Kết quả một dòng của `push` (Documents/21 §18.6.4): dòng được xếp việc có `status = 'pushing'`, `code` null; dòng bị
 * chặn có `code`, `status` là trạng thái listing hiện có (null khi chưa có bản ghi).
 */
export interface PushResult {
  variantId: string;
  listingId: string | null;
  status: ListingStatus | null;
  code: string | null;
  message: string | null;
}

/** Họ tên người xin ghép của các dòng đang chờ CEO duyệt, cho `pendingMapping.requestedBy`. Gọi trong `withCompany`. */
export async function requesterNames(rows: readonly ListingRow[]): Promise<Map<string, string>> {
  const ids = rows.flatMap((r) => (r.pendingRequestedBy ? [r.pendingRequestedBy] : []));
  return new Map((await findAccountSummaries(ids)).map((a) => [a.id, a.fullName]));
}

/** `names`: kết quả `requesterNames`; thiếu (bản ghi trong lỗi 409) thì tên trống. */
export function toListing(r: ListingRow, names: ReadonlyMap<string, string> = new Map()): ChannelListing {
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
    pendingMapping:
      r.pendingRequestedBy && r.pendingRequestedAt
        ? {
            variantId: r.pendingVariantId,
            requestedBy: { id: r.pendingRequestedBy, name: names.get(r.pendingRequestedBy) ?? '' },
            requestedAt: r.pendingRequestedAt,
          }
        : null,
    version: r.version,
  };
}

/** Mọi biến thể đang bán kèm giá chuẩn và listing trên gian hàng này. Gọi trong `withCompany`. */
export async function listListings(port: ProductPort, shopId: string): Promise<{ items: ListingRowView[] }> {
  const shop = await ownShop(shopId);
  const variants = (await port.variants()).filter((v) => !v.archived);
  const prices = await port.standardPrices(variants.map((v) => v.id));
  // Chỉ ảnh đầu (ảnh đại diện), một lần cho mọi sản phẩm.
  const thumbnails = await port.productImageUrls([...new Set(variants.map((v) => v.productId))], 1);
  const rows = await currentListingRows(shop.id);
  const names = await requesterNames(rows);
  const byVariant = new Map(rows.map((l) => [l.variantId, l]));
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
        thumbnailUrl: thumbnails.get(v.productId)?.[0] ?? null,
        price: price === null ? null : price.toNumber(),
        priceSource: price === null ? null : 'standard',
        listing: listing ? toListing(listing, names) : null,
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
  const actorId = by?.accountId ?? null;
  const dropPending = to === 'delisted' && row.pendingRequestedBy !== null;
  // Dòng chỉ để chờ duyệt "không quản tồn" của SKU chưa ghép: bỏ ghép chờ thì dòng không còn nghĩa (CHECK
  // `listings_unmanaged_approved`), xoá như khi CEO từ chối.
  if (dropPending && pendingOnly(row)) {
    if (!(await deleteListing(row.id, row.version))) throw new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
    await recordTransition({ entityType: ENTITY, entityId: row.id, from: row.status, to: row.status, action: 'reject_mapping', actorId, reason: DELISTED_REASON });
    return { ...row, ...NO_PENDING, status: to };
  }
  const updated = await updateListing(
    row.id,
    { version: row.version, status: row.status },
    { ...patch, ...(dropPending && NO_PENDING), status: to },
  );
  if (!updated) throw new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
  await recordTransition({ entityType: ENTITY, entityId: row.id, from: row.status, to, action, actorId, reason });
  // Gỡ là trạng thái cuối: ghép chờ duyệt không còn đối tượng (CHECK `listings_delisted_no_pending`, #220 đợt 2).
  if (dropPending) {
    await recordTransition({ entityType: ENTITY, entityId: row.id, from: to, to, action: 'reject_mapping', actorId, reason: DELISTED_REASON });
  }
  return updated;
}


const blocked = (variantId: string, existing: ListingRow | undefined, code: string, message: string): PushResult => ({
  variantId,
  listingId: existing?.id ?? null,
  status: existing?.status ?? null,
  code,
  message,
});

const inProgress = (variantId: string, existing: ListingRow | undefined) =>
  blocked(variantId, existing, 'push_in_progress', 'Đang đẩy, chờ sàn trả kết quả');

/**
 * Xếp việc đẩy các biến thể lên gian hàng (Documents/21 §18.6.4). Kiểm cả request trước (gian hàng gọi được sàn, không
 * chờ kiểm kê), rồi từng dòng: `not_found`, `push_in_progress`, `already_listed`, `sku_not_ready`, `price_missing`,
 * `category_unmapped`, `dimensions_missing`, `images_missing`. Dòng hợp lệ: mỗi dòng một giao dịch chuyển `pushing`,
 * ghi lịch sử, xếp việc; hai request đua cùng SKU thì dòng thua ra `push_in_progress` (unique của bảng, `version`).
 * Listing đã gỡ thì tạo bản ghi mới trỏ bản cũ (`replaces_listing_id`), chép mã sàn, SellerSku, ảnh của bản cũ: gỡ chỉ
 * tắt sản phẩm trên sàn nên đẩy lại là bật lại đúng sản phẩm đó.
 */
export async function pushListings(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { variantIds: string[]; imageUrls: Record<string, string[]> },
): Promise<{ results: PushResult[] }> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  // Thứ tự kiểm theo §18.6.11: chưa `active`, chờ kiểm kê, chờ phân hàng (hoặc lượt đơn mở chưa xong), rồi mới tới token.
  // Không giải mã token, không gọi sàn: chỉ kiểm gian hàng còn token.
  const shop = await inCompany(() => ownShop(shopId));
  assertPushable(shop);
  if (!shop.accessTokenEnc) {
    throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
  }
  const ids = [...new Set(input.variantIds)];
  const { variants, prices, maps, current } = await inCompany(async () => {
    const variants = new Map((await port.variants(ids)).map((v) => [v.id, v]));
    const categoryIds = [...new Set([...variants.values()].map((v) => v.categoryId))];
    return {
      variants,
      prices: await port.standardPrices(ids),
      maps: new Map((await listCategoryMaps(shop.platform, categoryIds)).map((m) => [m.categoryId, m])),
      current: new Map(await Promise.all(ids.map(async (id) => [id, await findListingRow(shop.id, id)] as const))),
    };
  });
  const results: PushResult[] = [];
  for (const variantId of ids) {
    const v = variants.get(variantId);
    const existing = current.get(variantId);
    if (!v || v.archived) {
      results.push(blocked(variantId, existing, 'not_found', 'Biến thể không còn bán'));
      continue;
    }
    if (existing?.status === 'pushing') {
      results.push(inProgress(variantId, existing));
      continue;
    }
    if (existing && LISTED.includes(existing.status)) {
      results.push(blocked(variantId, existing, 'already_listed', 'Đã có trên sàn: giá và tồn cập nhật bằng Đồng bộ'));
      continue;
    }
    const imageUrls = input.imageUrls[v.productId] ?? [];
    const block = pushBlock(v, prices.get(v.id) ?? null, maps.get(v.categoryId), Boolean(existing?.externalImageUrls?.length || imageUrls.length));
    if (block) {
      results.push(blocked(variantId, existing, block.code, block.message));
      continue;
    }
    results.push(await enqueue(actor, shop.id, v.id, v.sku, existing, imageUrls));
  }
  return { results };
}

const WAITING_MESSAGE = {
  open_orders: 'Đang kéo đơn còn mở về. Đẩy sản phẩm sau khi lượt này xong',
  allocation: 'Đang chia hàng cho các kiện sau kiểm kê. Đẩy sản phẩm sau khi chia xong',
} as const;

/**
 * Chỉ đẩy khi gian hàng `active` (409 `shop_not_active` kèm `current`; §18.6.4, 25 §6.3). Gian hàng đang giữ tồn sau
 * thiết lập thì không đẩy listing (không tạo sản phẩm với tồn 0, không xếp việc): chờ phiếu kiểm kê đầu kỳ 409
 * `shop_awaiting_stocktake` (§18.6.2); lượt kéo đơn còn mở chưa xong hoặc chờ phân hàng 409 `shop_awaiting_allocation`
 * kèm `waitingFor` (§18.6.11). `shopSession` chung không đổi (ghép danh mục vẫn gọi được khi `connecting`).
 */
function assertPushable(shop: ShopRow): void {
  if (shop.status !== 'active') {
    throw new AppError(409, 'shop_not_active', 'Hoàn tất thiết lập gian hàng trước khi đẩy', { current: shop.status });
  }
  if (shop.openingStocktakeNumber) {
    throw new AppError(409, 'shop_awaiting_stocktake', `Gian hàng đang chờ phiếu kiểm kê đầu kỳ ${shop.openingStocktakeNumber} ghi sổ`);
  }
  const waitingFor = awaitingAllocation(shop);
  if (waitingFor) throw new AppError(409, 'shop_awaiting_allocation', WAITING_MESSAGE[waitingFor], { waitingFor });
}

/**
 * Một dòng hợp lệ: chuyển `pushing` (dòng có sẵn) hoặc tạo bản ghi `pushing` (chưa có, hoặc chỉ còn bản đã gỡ), ghi lịch
 * sử và xếp việc trong một giao dịch. Bắt lỗi ngoài giao dịch: 23505 làm hỏng cả giao dịch đang mở.
 */
async function enqueue(
  actor: Actor,
  shopId: string,
  variantId: string,
  sku: string,
  existing: ListingRow | undefined,
  imageUrls: string[],
): Promise<PushResult> {
  const pushStartedAt = new Date();
  try {
    const row = await withCompany(actor.companyId, async () => {
      let row: ListingRow;
      if (existing && existing.status !== 'delisted') {
        // Lượt mới: đếm lại số lần thử, xoá lỗi và lý do từ chối của lượt trước.
        row = await moveListing(existing, 'push', actor, { pushStartedAt, pushAttempts: 0, pushError: null, rejectReason: null });
      } else {
        row = await insertListing({
          companyId: actor.companyId,
          shopId,
          variantId,
          sellerSku: existing?.sellerSku ?? sku,
          status: 'pushing',
          pushStartedAt,
          externalProductId: existing?.externalProductId ?? null,
          externalSkuId: existing?.externalSkuId ?? null,
          externalImageUrls: existing?.externalImageUrls ?? null,
          replacesListingId: existing?.id ?? null,
        });
        await recordTransition({ entityType: ENTITY, entityId: row.id, from: null, to: 'pushing', action: 'push', actorId: actor.accountId });
      }
      await sendListingPush({ companyId: actor.companyId, shopId, listingId: row.id, imageUrls });
      return row;
    });
    return { variantId, listingId: row.id, status: row.status, code: null, message: null };
  } catch (err) {
    // Request khác vừa chuyển hay tạo listing của SKU này.
    if (err instanceof AppError && err.code === 'version_conflict') return inProgress(variantId, existing);
    const constraint = pgError(err).constraint;
    if (constraint === 'listings_shop_variant_uq') return inProgress(variantId, existing);
    // Đẩy lại listing đã gỡ mà sản phẩm trên sàn của nó đang gắn với listing khác chưa gỡ của gian hàng (ghép tay).
    if (constraint === 'listings_shop_external_sku_uq') {
      return blocked(variantId, existing, 'already_listed', 'Sản phẩm trên sàn của listing đã gỡ đang gắn với SKU khác của gian hàng');
    }
    throw err;
  }
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
  return toListing(updated, await withCompany(actor.companyId, () => requesterNames([updated])));
}
