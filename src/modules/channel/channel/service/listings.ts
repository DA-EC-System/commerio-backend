// Listing: danh sách, đẩy lên sàn, gỡ (#104; Documents/21 §18.3, §18.4, §18.6.4). Đẩy chạy nền (#219): request chỉ
// kiểm, chuyển `pushing` và xếp việc `channel.listing_push` (`listing-push.ts`) trong cùng giao dịch, trả ngay.
import { Decimal } from 'decimal.js';
import { assertTransition, findAccountSummaries, lastEntries, recordAudit, recordTransition, responsibleOrgOf } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import {
  DELISTED_REASON,
  type ListingAction,
  type ListingStatus,
  listingMachine,
  NO_OUTSIDE_CHANGE,
  NO_PENDING,
  NO_REVISION,
  pendingOnly,
  REVISION_KEPT,
  TAKE_OVER_FROM,
} from '../domain/listing.ts';
import { awaitingAllocation } from '../domain/shop.ts';
import { listCategoryMaps } from '../repository/category-maps.ts';
import {
  currentListingRows,
  deleteListing,
  findListingById,
  findListingRow,
  insertListing,
  type ListingPatch,
  type ListingRow,
  updateListing,
} from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import type { ShopRow } from '../repository/shops.ts';
import type { ProductPort } from './product-port.ts';
import { insertConfirmed, type NewPriceCalculation } from '../repository/price-calculations.ts';
import { countRemoteSkusOfProduct } from '../repository/remote-skus.ts';
import { currentPrices, type ListingPrice, listingPrices } from './listing-prices.ts';
import { firstPushCalculations } from './repricing.ts';
import { listingText, pushBlock } from './push-block.ts';
import { PUSH_IMAGE_MAX, sendListingPush } from './shop-jobs.ts';
import { MarketplaceError } from './marketplaces/index.ts';
import { type Actor, onMarketplace, ownShop, shopSession } from './shops.ts';

export const ENTITY = 'listings';
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
  /** Sàn đổi listing ngoài app, chờ CEO quyết (#360, 21 §18.3). */
  outsideChange: { kind: NonNullable<ListingRow['outsideChangeKind']>; platformPrice: number | null; detectedAt: Date } | null;
  /** Ghép chờ CEO duyệt (§18.6.5); `variantId` null là "không quản tồn". */
  pendingMapping: { variantId: string | null; externalSkuId: string | null; requestedBy: { id: string; name: string }; requestedAt: Date } | null;
  /** Bản sửa nội dung chờ sàn duyệt (§18.3, #293). */
  pendingRevision: { status: 'auditing' | 'failed'; rejectReason: string | null; at: Date } | null;
  /** Ai tạo nội dung sản phẩm trên sàn (#399). */
  contentSource: ListingRow['contentSource'];
  version: number;
}

export interface ListingRowView extends ListingPrice {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  attributesLabel: string;
  /** Ảnh đại diện catalog của sản phẩm (#303); null khi chưa có ảnh. */
  thumbnailUrl: string | null;
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
    outsideChange:
      r.outsideChangeKind && r.outsideChangeAt
        ? {
            kind: r.outsideChangeKind,
            platformPrice: r.outsideChangePrice === null ? null : Number(r.outsideChangePrice),
            detectedAt: r.outsideChangeAt,
          }
        : null,
    pendingMapping:
      r.pendingRequestedBy && r.pendingRequestedAt
        ? {
            variantId: r.pendingVariantId,
            externalSkuId: r.pendingExternalSkuId,
            requestedBy: { id: r.pendingRequestedBy, name: names.get(r.pendingRequestedBy) ?? '' },
            requestedAt: r.pendingRequestedAt,
          }
        : null,
    pendingRevision:
      r.revisionStatus && r.revisionAt ? { status: r.revisionStatus, rejectReason: r.revisionRejectReason, at: r.revisionAt } : null,
    contentSource: r.contentSource,
    version: r.version,
  };
}

/**
 * "Giá đã đổi, chưa đẩy" (#360, 21 §18.6.6) tính lúc đọc: listing có trên sàn ghi `synced` mà giá đang bán khác giá đẩy
 * lần cuối (đổi giá chuẩn, xác nhận giá gian hàng) thì trả `pending`; lượt đồng bộ đẩy khi hai giá khác nhau. Listing chờ
 * CEO quyết thay đổi ngoài app giữ nguyên.
 */
function shownPriceSync(l: ListingRow, price: number | null): ListingRow['priceSync'] {
  const stale = l.priceSync === 'synced' && !l.outsideChangeKind && l.externalSkuId && l.status !== 'delisted' && price !== null && l.listedPrice !== null;
  return stale && !new Decimal(l.listedPrice!).eq(price) ? 'pending' : l.priceSync;
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
  const shopPrices = await listingPrices(shop.id, variants.map((v) => v.id), rows, prices);
  return {
    items: variants.map((v) => {
      const listing = byVariant.get(v.id);
      const price = shopPrices.get(v.id)!;
      return {
        variantId: v.id,
        productId: v.productId,
        productName: v.productName,
        sku: v.sku,
        attributesLabel: v.attributesLabel,
        thumbnailUrl: thumbnails.get(v.productId)?.[0] ?? null,
        ...price,
        listing: listing ? { ...toListing(listing, names), priceSync: shownPriceSync(listing, price.price) } : null,
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
    // Bản sửa nội dung chỉ còn ở trạng thái sàn vẫn duyệt nó (#293, CHECK `listings_revision`).
    { ...(to !== 'hidden' && NO_OUTSIDE_CHANGE), ...patch, ...(dropPending && NO_PENDING), ...(!REVISION_KEPT.includes(to) && NO_REVISION), status: to },
  );
  if (!updated) throw new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại');
  await recordTransition({ entityType: ENTITY, entityId: row.id, from: row.status, to, action, actorId, reason });
  // Gỡ là trạng thái cuối: ghép chờ duyệt không còn đối tượng (CHECK `listings_delisted_no_pending`, #220 đợt 2).
  if (dropPending) {
    await recordTransition({ entityType: ENTITY, entityId: row.id, from: to, to, action: 'reject_mapping', actorId, reason: DELISTED_REASON });
  }
  return updated;
}


/**
 * Thao tác khi lượt đẩy của listing `pushing` lỗi (sàn từ chối, hết lượt thử, quá 30 phút). Lượt `take-over-content` xuất
 * phát từ `live` thì sản phẩm người bán vẫn đang bán: `take_over_failed` về `live`, tồn và giá đánh `pending` để lượt đồng bộ
 * đẩy lại, `content_source` giữ nguyên. Còn lại `fail` → `push_failed`. Điểm xuất phát lấy từ lần vào `pushing` gần nhất
 * trong `core.state_transitions` (lượt đồng bộ kẹt 30 phút không có dữ liệu việc). Gọi trong `withCompany`.
 */
export async function pushFailureOf(row: ListingRow): Promise<{ action: ListingAction; patch: ListingPatch }> {
  const entry = (await lastEntries(ENTITY, [row.id], 'pushing')).get(row.id);
  if (entry?.action === 'take_over_content' && entry.from === 'live') {
    return { action: 'take_over_failed', patch: { stockSync: 'pending', priceSync: 'pending' } };
  }
  return { action: 'fail', patch: {} };
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
 * `category_unmapped`, `dimensions_missing`, `images_missing`, `size_chart_missing`. Dòng hợp lệ: mỗi dòng một giao dịch chuyển `pushing`,
 * ghi lịch sử, xếp việc; hai request đua cùng SKU thì dòng thua ra `push_in_progress` (unique của bảng, `version`).
 * Listing đã gỡ thì tạo bản ghi mới trỏ bản cũ (`replaces_listing_id`), chép mã sàn, SellerSku, ảnh của bản cũ: gỡ chỉ
 * tắt sản phẩm trên sàn nên đẩy lại là bật lại đúng sản phẩm đó.
 * Ảnh (#303): lấy ảnh catalog **lúc bấm** (tối đa 8 ảnh đầu, một lần cho cả request) và đặt vào dữ liệu việc; listing
 * đã có ảnh trên sàn thì việc nền dùng ảnh đó.
 */
export async function pushListings(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { variantIds: string[] },
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
  const { variants, prices, maps, current, images, sizeCharts } = await inCompany(async () => {
    const variants = new Map((await port.variants(ids)).map((v) => [v.id, v]));
    const categoryIds = [...new Set([...variants.values()].map((v) => v.categoryId))];
    const productIds = [...new Set([...variants.values()].map((v) => v.productId))];
    return {
      variants,
      prices: await port.standardPrices(ids),
      maps: new Map((await listCategoryMaps(shop.platform, categoryIds)).map((m) => [m.categoryId, m])),
      current: new Map(await Promise.all(ids.map(async (id) => [id, await findListingRow(shop.id, id)] as const))),
      images: await port.productImageUrls(productIds, PUSH_IMAGE_MAX),
      sizeCharts: (await port.productSizeChartUrls?.(productIds)) ?? new Map<string, string>(),
    };
  });
  // Lần đẩy đầu dùng giá bộ lọc của gian hàng (#225 phần 2); listing đã có giá ghi đè hay giá gian hàng giữ giá đó.
  const firstPush = ids.filter((id) => {
    const l = current.get(id);
    return !l || l.status === 'delisted' || (l.manualPrice === null && l.priceCalcId === null);
  });
  const calcs = await inCompany(() => firstPushCalculations(shop.id, firstPush));
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
    // CHECK `listings_pending_external`: SKU sàn chờ ghép chỉ nằm trên listing `push_failed` (#346).
    if (existing?.pendingExternalSkuId) {
      results.push(blocked(variantId, existing, 'mapping_pending', 'Listing đang chờ CEO duyệt ghép SKU sàn có sẵn; duyệt hoặc từ chối trước khi đẩy lại'));
      continue;
    }
    if (existing && LISTED.includes(existing.status)) {
      results.push(blocked(variantId, existing, 'already_listed', 'Đã có trên sàn: giá và tồn cập nhật bằng Đồng bộ'));
      continue;
    }
    const imageUrls = images.get(v.productId) ?? [];
    const sizeChartUrl = sizeCharts.get(v.productId) ?? null;
    const calc = calcs.get(v.id);
    const block = pushBlock(
      v,
      calc ? new Decimal(calc.roundedPrice) : (prices.get(v.id) ?? null),
      maps.get(v.categoryId),
      Boolean(existing?.externalImageUrls?.length || imageUrls.length),
      Boolean(sizeChartUrl),
    );
    if (block) {
      results.push(blocked(variantId, existing, block.code, block.message));
      continue;
    }
    if (calc?.belowFloor) {
      results.push(blocked(variantId, existing, 'below_floor', 'Giá theo bộ lọc giá của gian hàng có thực nhận dưới giá thấp nhất; sửa giá muốn bán hoặc cấu hình phí'));
      continue;
    }
    results.push(await enqueue(actor, shop.id, v.id, v.sku, existing, imageUrls, sizeChartUrl, calc));
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
  sizeChartUrl: string | null,
  calc?: NewPriceCalculation,
): Promise<PushResult> {
  const pushStartedAt = new Date();
  try {
    const row = await withCompany(actor.companyId, async () => {
      let row: ListingRow;
      const priceCalcId = calc ? (await insertConfirmed(calc, actor.accountId, pushStartedAt)).id : undefined;
      if (existing && existing.status !== 'delisted') {
        // Lượt mới: đếm lại số lần thử, xoá lỗi và lý do từ chối của lượt trước.
        row = await moveListing(existing, 'push', actor, { pushStartedAt, pushAttempts: 0, pushError: null, rejectReason: null, ...(priceCalcId && { priceCalcId }) });
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
          priceCalcId: priceCalcId ?? null,
          // #399: bản gỡ còn mã sàn thì đẩy lại đúng sản phẩm đó, chủ nội dung giữ như cũ; không có thì app tạo mới.
          contentSource: existing?.externalSkuId ? existing.contentSource : 'app',
        });
        await recordTransition({ entityType: ENTITY, entityId: row.id, from: null, to: 'pushing', action: 'push', actorId: actor.accountId });
      }
      await sendListingPush({ companyId: actor.companyId, shopId, listingId: row.id, imageUrls, ...(sizeChartUrl && { sizeChartUrl }) });
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

/**
 * `update_content` (§18.3, #293): đưa tên, mô tả, thuộc tính của catalog lên sản phẩm đang bán. Gọi sàn ngoài giao dịch;
 * sàn nhận rồi mới ghi, đọc lại dòng (đồng bộ tồn tăng `version` liên tục): sàn vẫn bán bản cũ thì giữ `live` kèm bản sửa
 * `auditing`, sàn ngừng bán để duyệt thì hệ thống chuyển tiếp `request_review`.
 */
export async function updateListingContent(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  listingId: string,
  version: number,
): Promise<ChannelListing> {
  const { shop, adapter, accessToken, row, productId, v, map, responsible } = await withCompany(actor.companyId, async () => {
    const session = await shopSession(shopId);
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== session.shop.id) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    if (row.version !== version) {
      throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', { current: toListing(row) });
    }
    assertTransition(listingMachine, row.status, 'update_content', { actor, view: toListing(row) });
    if (!row.variantId || !row.externalProductId) {
      throw new AppError(409, 'listing_unmanaged', 'Listing không gắn sản phẩm Commerio, không có nội dung để đưa lên');
    }
    // Sản phẩm của người bán: chỉ CEO ghi nội dung Commerio lên bằng `take-over-content` (hộp xác nhận, nhật ký), không
    // đi đường `update-content`. Kiểm trước khi gọi sàn (#399).
    if (row.contentSource === 'platform') {
      throw new AppError(409, 'invalid_transition', 'Nội dung sản phẩm này là của người bán trên sàn; CEO dùng Ghi nội dung Commerio lên sàn', {
        current: toListing(row),
      });
    }
    const [v] = await port.variants([row.variantId]);
    if (!v || v.archived) throw new AppError(404, 'not_found', 'Biến thể không còn bán');
    const [map] = await listCategoryMaps(session.shop.platform, [v.categoryId]);
    if (!map) throw new AppError(409, 'category_unmapped', 'Danh mục chưa ghép với danh mục của sàn');
    return { ...session, row, productId: row.externalProductId, v, map, responsible: await responsibleOrgOf(session.shop.companyId) };
  });
  const update = adapter.updateContent;
  if (!update) throw new AppError(422, 'marketplace_unsupported', 'Sàn này chưa hỗ trợ sửa nội dung sản phẩm đang bán');
  const { underReview } = await onMarketplace(async () => {
    try {
      return await update(accessToken, productId, { externalCategoryId: map.externalCategoryId, ...listingText(v), attributes: map.attributes, responsible });
    } catch (err) {
      // Sản phẩm sàn nhiều SKU: mã riêng của route (§18.5), không phải lỗi chung của sàn.
      if (err instanceof MarketplaceError && err.platformCode === 'shared_remote_product') {
        throw new AppError(409, 'shared_remote_product', err.platformMessage ?? 'Sản phẩm trên sàn có nhiều SKU');
      }
      throw err;
    }
  });
  return withCompany(actor.companyId, async () => {
    const fresh = await findListingById(row.id);
    if (!fresh || fresh.shopId !== shop.id) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    const revision = underReview ? {} : { revisionStatus: 'auditing' as const, revisionRejectReason: null, revisionAt: new Date() };
    let updated = await moveListing(fresh, 'update_content', actor, revision);
    if (underReview) updated = await moveListing(updated, 'request_review', null);
    return toListing(updated, await requesterNames([updated]));
  });
}

/**
 * `take-over-content` (#399): CEO ghi tên, mô tả, ảnh, danh mục của Commerio lên sản phẩm người bán đã ghép
 * (`content_source = 'platform'`). Route đã kiểm quyền và vai trò CEO. Thứ tự: 404 → 409 `invalid_transition` (listing
 * `app`, chưa có mã sàn, `hidden` (hiện lại trước), trạng thái khác `TAKE_OVER_FROM`, đang chờ CEO quyết thay đổi ngoài app) → 409 `mapping_pending`
 * → 409 `version_conflict` → 409 `shared_remote_product` (sản phẩm sàn nhiều SKU theo bản sao: ghi đè cả sản phẩm) →
 * mã chặn của `pushBlock`. Hợp lệ: chuyển `pushing`, ghi lịch sử, nhật ký, xếp `channel.listing_push` có `takeOver` cùng
 * giao dịch. Việc nền ghi nội dung (`updateProduct`) như đẩy lại, xong thì `content_source = 'app'`; sàn lỗi thì
 * `push_failed` kèm `pushError` (xuất phát từ `live` thì về `live`, `pushFailureOf`), giữ `platform`. Kiểm gian hàng trước
 * (`assertPushable`, token) như `pushListings`.
 */
export async function takeOverContent(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  listingId: string,
  version: number,
): Promise<ChannelListing> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    // Kiểm gian hàng như `pushListings`, cùng mã và thứ tự: việc nền gọi sàn nên gian hàng phải đẩy được và còn token.
    assertPushable(shop);
    if (!shop.accessTokenEnc) {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
    }
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== shop.id) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    const current = { current: toListing(row, await requesterNames([row])) };
    const { externalProductId, variantId } = row;
    if (row.contentSource === 'platform' && row.status === 'hidden' && externalProductId && row.externalSkuId && variantId) {
      throw new AppError(409, 'invalid_transition', 'Hiện lại listing trước khi ghi nội dung Commerio lên sàn', current);
    }
    if (row.contentSource !== 'platform' || !externalProductId || !row.externalSkuId || !variantId || !(TAKE_OVER_FROM as readonly ListingStatus[]).includes(row.status)) {
      throw new AppError(409, 'invalid_transition', 'Chỉ ghi nội dung Commerio lên sản phẩm người bán đang có trên sàn', current);
    }
    if (row.outsideChangeKind) throw new AppError(409, 'invalid_transition', 'Quyết thay đổi ngoài app của listing trước', current);
    if (row.pendingRequestedBy) throw new AppError(409, 'mapping_pending', 'Listing đang chờ CEO duyệt ghép', current);
    if (row.version !== version) throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', current);
    if ((await countRemoteSkusOfProduct(shop.id, externalProductId)) > 1) {
      throw new AppError(409, 'shared_remote_product', 'Sản phẩm trên sàn có nhiều SKU; ghi nội dung sẽ đổi mọi SKU của sản phẩm');
    }
    const [v] = await port.variants([variantId]);
    if (!v || v.archived) throw new AppError(404, 'not_found', 'Biến thể không còn bán');
    const imageUrls = (await port.productImageUrls([v.productId], PUSH_IMAGE_MAX)).get(v.productId) ?? [];
    const sizeChartUrl = (await port.productSizeChartUrls?.([v.productId]))?.get(v.productId) ?? null;
    const [map] = await listCategoryMaps(shop.platform, [v.categoryId]);
    const own = (await currentPrices([variantId], [row], await port.standardPrices([variantId]))).get(variantId)!;
    const block = pushBlock(v, own.price === null ? null : new Decimal(own.price), map, imageUrls.length > 0, Boolean(sizeChartUrl));
    if (block) throw new AppError(409, block.code, block.message, current);
    const updated = await moveListing(row, 'take_over_content', actor, {
      pushStartedAt: new Date(),
      pushAttempts: 0,
      pushError: null,
      rejectReason: null,
    });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'channel.listings',
      entityId: row.id,
      before: { code: row.sellerSku, status: row.status, contentSource: row.contentSource },
      after: { code: row.sellerSku, status: updated.status, action: 'take_over_content', contentSource: 'app' },
    });
    await sendListingPush({ companyId: actor.companyId, shopId: shop.id, listingId: row.id, imageUrls, ...(sizeChartUrl && { sizeChartUrl }), takeOver: true });
    return toListing(updated, await requesterNames([updated]));
  });
}
