// Đồng bộ listing với sàn (#104; Documents/21 §18.3, §18.4, §18.5): đọc trạng thái sàn theo SellerSku của mình (#104 A4),
// đối chiếu tồn (#223, 25 §6.5), đẩy giá và tồn của listing chờ đồng bộ theo lô. Gọi sàn ngoài giao dịch như
// `listings.ts`. Bấm tay ở route `sync`; #102 gọi lại `syncListings` theo lịch. Đẩy ngay khi số có thể bán đổi:
// `pushPending` (việc `channel.stock_push`).
import { Decimal } from 'decimal.js';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { type EventPayload, lastEntryActions } from '../../../core/index.ts';
import {
  DELETABLE,
  type ListingAction,
  type ListingStatus,
  NO_REASON,
  NO_REVISION,
  STALE_PUSH_MS,
  STOCK_RECONCILED,
  type StockDecision,
  stockDecision,
  syncAction,
  visibilityAction,
} from '../domain/listing.ts';
import { platformPriceChanged } from '../domain/outside-price.ts';
import { holdsStock } from '../domain/shop.ts';
import {
  clearResolvedCategoryChange,
  failStaleCategoryChanges,
  findListingById,
  type ListingPatch,
  type ListingRow,
  listListingRows,
  setListingCategory,
} from '../repository/listings.ts';
import { markPushed } from '../repository/price-calculations.ts';
import { markSpecCategory } from '../repository/product-specs.ts';
import { markStockPushed, type ShopRow } from '../repository/shops.ts';
import type { SyncError } from '../repository/schema.ts';
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type PartResult,
  type PerSkuResult,
  PROMOTION_LOCKED,
  type PriceQuantity,
  type RemoteSku,
} from './marketplaces/index.ts';
import { markStockPendingIds, markStockPendingRows, updateListing } from './listing-writes.ts';
import { currentPrices } from './listing-prices.ts';
import { moveListing, pushFailureOf } from './listings.ts';
import { pullShopOrders } from './order-pull.ts';
import type { ProductPort } from './product-port.ts';
import { sendListingSync, sendOrderPull, sendStockPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, ownShop, shopSession, shopStopped } from './shops.ts';
import { ordersStaleError, raisesStock, shopOrdersStale, untrustedVariants } from './stock-trust.ts';

/**
 * Listing đọc trạng thái từ sàn (có mã sàn): duyệt, từ chối, khoá, gỡ khoá; `rejected`, `push_failed` còn sản phẩm trên
 * sàn thì chỉ để bắt sàn xoá (#219, 25 §6.4).
 */
const WATCHED = DELETABLE;
/** Listing có sản phẩm trên sàn để đẩy giá, tồn. */
const PUSHABLE: readonly ListingStatus[] = ['under_review', 'live', 'hidden', 'platform_hold', 'rejected'];

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

type InCompany = <T>(fn: () => Promise<T>) => Promise<T>;
export interface Session {
  shop: ShopRow;
  adapter: MarketplaceAdapter;
  accessToken: string;
}

/**
 * Số có thể bán của các biến thể vừa đổi: listing còn trên sàn chờ đẩy tồn (Lệch tồn giữ `error`). Trả id gian hàng có
 * listing đổi. Gọi trong `withCompany`.
 */
export async function markStockPending(variantIds: readonly string[]): Promise<string[]> {
  requireCompanyId('markStockPending');
  return markStockPendingRows(variantIds, PUSHABLE);
}

/**
 * `fulfillment.allocation_done` (21 §11.2, §18.5; #223): chia hàng xong mới đẩy. Đánh dấu chờ đẩy tồn rồi xếp
 * `channel.stock_push` cho từng gian hàng có listing đổi, cùng giao dịch của consumer; việc đọc số mới nhất lúc chạy.
 */
export async function onAvailableChanged(event: EventPayload<'fulfillment.allocation_done'>): Promise<void> {
  const companyId = requireCompanyId('onAvailableChanged');
  for (const shopId of await markStockPending(event.variantIds)) await sendStockPush(companyId, shopId);
}

/**
 * Đẩy tồn, giá đang chờ của gian hàng, không đọc sàn (việc `channel.stock_push`). Gian hàng giữ tồn (#198) thì chỉ đẩy giá;
 * SKU chưa tin được (`untrustedVariants`, #223) không gửi tồn. Đơn của chính gian hàng chưa cập nhật thì xếp thêm một lượt
 * lấy đơn để mở lại sớm (lấy đơn xong trọn tự xếp lại việc này).
 */
export async function pushPending(port: ProductPort, companyId: string, shopId: string): Promise<SyncSummary> {
  const inCompany: InCompany = (fn) => withCompany(companyId, fn);
  const session = await inCompany(() => shopSession(shopId));
  const summary: SyncSummary = { checked: 0, changed: 0, pushed: 0, errors: 0 };
  let rows = await inCompany(() => listListingRows(session.shop.id));
  rows = await applyVisibility(port, inCompany, session, rows, summary);
  await pushDue(port, inCompany, session, rows, holdsStock(session.shop), new Map(), summary);
  if (shopOrdersStale(session.shop)) await inCompany(() => sendOrderPull(companyId, shopId));
  return summary;
}

/** Listing ẩn bằng tồn 0 (`hideBy = 'zero_stock'`): số nên có trên sàn là 0, không phải số có thể bán (#224). */
const zeroHidden = (row: ListingRow) => row.status === 'hidden' && row.hiddenBy === 'zero_stock';

/**
 * Sàn tắt, bật theo cả sản phẩm và bật lại phải duyệt lại (TikTok; #224 phần 2, 25 §6.4 "Sàn không ẩn riêng được một
 * phân loại"): listing app ẩn luôn để tồn 0 trên sàn (`zero_stock`); mọi listing chưa gỡ của sản phẩm đều `hidden` thì tắt
 * thêm cả sản phẩm; hiện lại khi sản phẩm đang tắt thì bật sản phẩm.
 */
export const hidesByProduct = (adapter: MarketplaceAdapter): boolean => adapter.togglesByProduct === true;
/**
 * Lần vào `hidden` mà app được tự hiện lại: `hide` (tạm ngừng SKU), hoặc `outside_hold` đã được CEO `restore` lúc SKU
 * đang tạm ngừng (dòng chờ quyết lọc trước theo `outsideChangeKind`). `relist` (nối lại gian hàng) không.
 */
const APP_HIDDEN = new Set(['hide', 'outside_hold']);

/** Bật lại SKU trên sàn (#224 hiện lại, #360 CEO bật lại); adapter không có `activate` thì `unsupported`. */
export async function activateOnMarketplace(
  { adapter, accessToken }: Pick<Session, 'adapter' | 'accessToken'>,
  productId: string,
  skuId: string,
): Promise<void> {
  if (!adapter.activate) throw new MarketplaceError('unsupported', 'activate_missing', 'Sàn chưa hỗ trợ bật lại sản phẩm từ app');
  await adapter.activate(accessToken, productId, skuId);
}

export async function pausedVariants(port: ProductPort, variantIds: string[]): Promise<Set<string>> {
  const variants = await port.variants([...new Set(variantIds)]);
  return new Set(variants.filter((v) => v.businessStatus === 'paused').map((v) => v.id));
}

/**
 * Ẩn, hiện listing theo trạng thái SKU (#224, 25 §6.4, `visibilityAction`). `hideBy = 'deactivate'`: gọi sàn tắt, bật
 * (`hiddenBy = 'platform'`); `zero_stock`: không gọi sàn ở đây, `hiddenBy = 'zero_stock'` và chờ đẩy tồn để `pushDue` gửi 0
 * (hiện lại thì gửi số có thể bán). Sàn ẩn theo sản phẩm (`hidesByProduct`): ẩn bằng tồn 0, tắt, bật cả sản phẩm theo
 * nhóm mã sản phẩm sàn (`hideProducts`, `productBlocksUnhide`). Gọi sàn ngoài giao dịch, ghi DB sau khi sàn nhận. Lỗi của
 * một listing chỉ ghi log và giữ nguyên trạng thái để lượt sau làm lại (mất uỷ quyền, gian hàng ngắt thì ném như mọi lời
 * gọi sàn). Có dòng đổi thì trả danh sách listing đọc lại.
 */
async function applyVisibility(
  port: ProductPort,
  inCompany: InCompany,
  session: Session,
  rows: ListingRow[],
  summary: SyncSummary,
  remote: ReadonlyMap<string, RemoteSku> = new Map(),
): Promise<ListingRow[]> {
  const { shop, adapter, accessToken } = session;
  const byProduct = hidesByProduct(adapter);
  const candidates = rows.filter((r) => r.mode === 'mapped' && r.externalSkuId && (r.status === 'live' || r.status === 'hidden'));
  if (!candidates.length) return rows;
  const { paused, entered } = await inCompany(async () => {
    const paused = await pausedVariants(port, candidates.map((r) => r.variantId!));
    // Lịch sử chỉ cần cho dòng có thể hiện lại; dòng chờ CEO quyết sàn đổi ngoài app không tự hiện lại (#360).
    const unhidable = candidates.filter((r) => r.status === 'hidden' && !r.outsideChangeKind && !paused.has(r.variantId!)).map((r) => r.id);
    return { paused, entered: await lastEntryActions('listings', unhidable, 'hidden') };
  });
  const byPlatform = adapter.capabilities.hideBy === 'deactivate';
  // Lệch tồn (`error`) giữ qua lần hiện lại; ẩn bằng tồn 0 thì chờ đẩy 0.
  const patchFor = (action: ListingAction, row: ListingRow): ListingPatch => {
    if (action === 'unhide') return { hiddenBy: null, stockSync: row.stockSync === 'error' ? 'error' : 'pending' };
    if (byPlatform) return { hiddenBy: 'platform' };
    return { hiddenBy: 'zero_stock', stockSync: 'pending' };
  };
  let changed = false;
  const hidden = new Set<string>();
  const products = new Map<string, RemoteSku['state'] | undefined>();
  for (const row of candidates) {
    const action = visibilityAction(row.status, paused.has(row.variantId!), APP_HIDDEN.has(entered.get(row.id) ?? ''));
    if (!action) continue;
    try {
      if (byPlatform) {
        await onMarketplace(async () => {
          if (action === 'hide') return adapter.deactivate(accessToken, row.externalProductId!, row.externalSkuId!);
          return activateOnMarketplace(session, row.externalProductId!, row.externalSkuId!);
        });
      } else if (byProduct && action === 'unhide' && (await onMarketplace(() => productBlocksUnhide(session, rows, row, remote, paused, products)))) {
        continue;
      }
    } catch (err) {
      if (shopStopped(err)) throw err;
      logger.warn({ err, listingId: row.id, action }, 'Ẩn, hiện listing theo trạng thái SKU lỗi, lượt sau thử lại');
      summary.errors++;
      continue;
    }
    const reason = action === 'hide' ? 'SKU tạm ngừng bán' : 'SKU bỏ tạm ngừng bán';
    if (await inCompany(() => moveAfterMarketplace(row, action, (r) => patchFor(action, r), reason))) {
      changed = true;
      summary.changed++;
      if (action === 'hide') hidden.add(row.externalProductId!);
    }
  }
  const fresh = changed ? await inCompany(() => listListingRows(shop.id)) : rows;
  if (byProduct) await hideProducts(session, fresh, hidden, remote, summary);
  return fresh;
}

/** Listing chưa gỡ cùng mã sản phẩm sàn trên gian hàng (kể cả ghép không quản tồn). */
export const productGroup = (rows: readonly ListingRow[], productId: string) =>
  rows.filter((r) => r.externalProductId === productId && r.status !== 'delisted');

/**
 * Hiện lại một listing của sàn ẩn theo sản phẩm. Sản phẩm đang tắt trên sàn thì bật sản phẩm, nhưng chỉ khi mọi listing
 * khác còn ẩn của sản phẩm đã có tồn 0 trên sàn (`zero_stock` đã đồng bộ): chưa thì trả `true` (chờ lượt sau, `pushDue`
 * đẩy 0 trước). Sản phẩm có listing chờ CEO quyết sàn đổi ngoài app (người bán tắt) thì không bật (21 §18.3).
 */
async function productBlocksUnhide(
  session: Session,
  rows: readonly ListingRow[],
  row: ListingRow,
  remote: ReadonlyMap<string, RemoteSku>,
  paused: ReadonlySet<string>,
  products: Map<string, RemoteSku['state'] | undefined>,
): Promise<boolean> {
  const productId = row.externalProductId!;
  // Trạng thái sàn theo sản phẩm, đọc một lần mỗi lượt: lượt đồng bộ đã có `remote`, lượt đẩy tồn thì đọc một SKU.
  if (!products.has(productId)) products.set(productId, (remote.get(row.externalSkuId!) ?? (await remoteSkuOf(session, row)))?.state);
  if (products.get(productId) !== 'inactive') return false;
  // Anh em còn ẩn hay SKU tạm ngừng (kể cả chưa kịp ẩn trong lượt này) phải đã có tồn 0 trên sàn.
  const others = productGroup(rows, productId).filter((r) => r.id !== row.id);
  const zeroed = (r: ListingRow) => r.hiddenBy === 'zero_stock' && r.stockSync === 'synced';
  const unsafe = (r: ListingRow) => (r.status === 'hidden' || (!!r.variantId && paused.has(r.variantId))) && !zeroed(r);
  if (others.some((r) => r.outsideChangeKind || unsafe(r))) return true;
  await activateOnMarketplace(session, productId, row.externalSkuId!);
  products.set(productId, 'review');
  return false;
}

/** Trạng thái trên sàn của SKU của một listing (một lời gọi đọc). */
export async function remoteSkuOf({ adapter, accessToken }: Session, row: ListingRow): Promise<RemoteSku | undefined> {
  return (await adapter.getSkus(accessToken, [row.sellerSku!])).find((s) => s.externalSkuId === row.externalSkuId);
}

/**
 * Tắt cả sản phẩm khi mọi listing chưa gỡ của nó đều do app ẩn (`zero_stock`, không chờ CEO quyết): sản phẩm vừa có listing ẩn trong lượt, hoặc lượt đồng bộ
 * thấy sàn còn bán (lần tắt trước lỗi). Lượt đồng bộ thấy mọi SKU của sản phẩm đã tắt trên sàn thì không gọi.
 */
async function hideProducts(
  { adapter, accessToken }: Session,
  rows: readonly ListingRow[],
  hidden: ReadonlySet<string>,
  remote: ReadonlyMap<string, RemoteSku>,
  summary: SyncSummary,
): Promise<void> {
  const stillSold = rows.filter((r) => r.status === 'hidden' && remote.get(r.externalSkuId ?? '')?.state === 'live');
  for (const productId of new Set([...hidden, ...stillSold.map((r) => r.externalProductId!)])) {
    const group = productGroup(rows, productId);
    // Chỉ tắt khi mọi listing do app ẩn: listing chờ CEO quyết hay ẩn do nối lại gian hàng thì không đè quyết định của người bán.
    if (!group.length || !group.every((r) => r.status === 'hidden' && r.hiddenBy === 'zero_stock' && !r.outsideChangeKind)) continue;
    if (group.every((r) => (remote.get(r.externalSkuId ?? '')?.state ?? 'live') !== 'live')) continue;
    try {
      await onMarketplace(() => adapter.deactivate(accessToken, productId, group[0]!.externalSkuId!));
    } catch (err) {
      if (shopStopped(err)) throw err;
      logger.warn({ err, productId }, 'Tắt sản phẩm khi mọi phân loại đều ẩn lỗi, lượt sau thử lại');
      summary.errors++;
    }
  }
}

/**
 * Giá gốc trên sàn khác giá app đẩy lần cuối (#360, 21 §18.3, 25 §6.5): không tự đẩy đè. Listing `live` → `outside_hold`
 * kèm `outsideChange` `price_changed`, app tắt SKU trên sàn (`hideBy = 'deactivate'`) hoặc
 * đưa tồn sàn về 0 (`hidden_by = 'zero_stock'`, `pushDue` gửi 0). Listing `hidden` sẵn chỉ ghi `outsideChange`, giữ cách ẩn.
 * Lỗi sàn của một listing chỉ log, lượt sau so lại; mất uỷ quyền, gian hàng ngắt thì ném.
 */
async function holdChangedPrices(
  inCompany: InCompany,
  { adapter, accessToken }: Session,
  rows: ListingRow[],
  bySku: Map<string, RemoteSku>,
  summary: SyncSummary,
): Promise<void> {
  const now = Date.now();
  const byPlatform = adapter.capabilities.hideBy === 'deactivate';
  for (const row of rows) {
    const remote = bySku.get(row.externalSkuId!);
    if (!remote || !platformPriceChanged(row, remote, now)) continue;
    const change = { outsideChangeKind: 'price_changed', outsideChangePrice: remote.price!, outsideChangeAt: new Date() } as const;
    if (row.status === 'hidden') {
      if (await inCompany(() => updateListing(row.id, { version: row.version, status: 'hidden' }, change))) summary.changed++;
      continue;
    }
    if (byPlatform) {
      try {
        await onMarketplace(() => adapter.deactivate(accessToken, row.externalProductId!, row.externalSkuId!));
      } catch (err) {
        if (err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected')) throw err;
        logger.warn({ err, listingId: row.id }, 'Tắt SKU bị sửa giá ngoài app lỗi, lượt sau thử lại');
        summary.errors++;
        continue;
      }
    }
    const hide: ListingPatch = byPlatform ? { hiddenBy: 'platform' } : { hiddenBy: 'zero_stock', stockSync: 'pending' };
    if (await inCompany(() => moveAfterMarketplace(row, 'outside_hold', () => ({ ...change, ...hide }), 'Giá trên sàn bị sửa'))) summary.changed++;
  }
}

/**
 * Ghi thao tác sau khi sàn đã nhận. Lệch `version` (tồn vừa đánh dấu chờ đẩy) thì đọc lại và ghi trên dòng mới nếu trạng
 * thái chưa đổi, để app không lệch sàn; trạng thái đã đổi (gỡ, sàn khoá) thì bỏ, lượt sau so lại.
 */
async function moveAfterMarketplace(
  row: ListingRow,
  action: ListingAction,
  patchFor: (row: ListingRow) => ListingPatch,
  reason: string,
): Promise<boolean> {
  try {
    await moveListing(row, action, null, patchFor(row), reason);
    return true;
  } catch (err) {
    if (!(err instanceof AppError) || err.code !== 'version_conflict') throw err;
  }
  const fresh = await findListingById(row.id);
  if (fresh?.status !== row.status) return false;
  await moveListing(fresh, action, null, patchFor(fresh), reason);
  return true;
}

/**
 * Nút "Đồng bộ" (Documents/21 §18.5): chỉ xếp một lượt `channel.listing_sync` cho gian hàng, không gọi sàn trong request.
 * Gian hàng không `active` hoặc mất token: 409 `shop_not_connected`. `queued = false` khi đã có lượt chờ (bấm hai lần).
 */
export async function requestListingSync(companyId: string, shopId: string): Promise<{ queued: boolean }> {
  return withCompany(companyId, async () => {
    const shop = await ownShop(shopId);
    if (shop.status !== 'active' || !shop.accessTokenEnc) {
      throw new AppError(409, 'shop_not_connected', 'Gian hàng chưa kết nối hoặc cần kết nối lại', { current: shop.status });
    }
    return { queued: await sendListingSync(companyId, shop.id) };
  });
}

export async function syncListings(port: ProductPort, companyId: string, shopId: string): Promise<SyncSummary> {
  const inCompany: InCompany = (fn) => withCompany(companyId, fn);
  const session = await inCompany(() => shopSession(shopId));
  const { shop, adapter, accessToken } = session;
  const summary: SyncSummary = { checked: 0, changed: 0, pushed: 0, errors: 0 };
  // Giữ tồn (#198, `holdsStock`): chỉ đẩy giá, không đối chiếu; tồn giữ `stock_sync = pending`, không ghi lỗi.
  const holdStock = holdsStock(shop);
  // Đối chiếu tồn, bước 1 (25 §6.5): lấy đơn mới trước, để không đẩy tăng số đã bán (E35).
  const reconcile = !holdStock && (await pullOrdersFirst(companyId, shop, adapter));
  let rows = await inCompany(() => listListingRows(shop.id));

  // Kẹt `pushing` (server chết giữa lúc gọi sàn): quá 30 phút thì báo lỗi đẩy (§18.3).
  const staleBefore = Date.now() - STALE_PUSH_MS;
  for (const row of rows.filter((r) => r.status === 'pushing' && (r.pushStartedAt?.getTime() ?? 0) < staleBefore)) {
    const message = 'Quá 30 phút chưa có kết quả từ sàn, đồng bộ lại';
    const pushError: SyncError = { code: 'marketplace_unavailable', message, at: new Date().toISOString() };
    // Lượt take-over xuất phát từ `live` kẹt quá 30 phút: về `live` như lỗi sàn, không `push_failed` (#399).
    await inCompany(async () => {
      const failure = await pushFailureOf(row);
      await moveListing(row, failure.action, null, { pushError, ...failure.patch }, message);
    });
    summary.changed++;
  }

  // Kẹt `category_change = queued` (việc đổi category rơi): quá 30 phút thì `failed`, để người dùng đổi lại (#467).
  await inCompany(() =>
    failStaleCategoryChanges(new Date(staleBefore), 'Quá 30 phút chưa có kết quả từ sàn, thử lại', rows.filter((r) => r.categoryChange?.status === 'queued').map((r) => r.id)),
  );

  const watched = rows.filter((r) => WATCHED.includes(r.status) && r.sellerSku && r.externalSkuId);
  summary.checked = watched.length;
  let bySku = new Map<string, RemoteSku>();
  if (watched.length) {
    const remote = await onMarketplace(() => adapter.getSkus(accessToken, watched.map((r) => r.sellerSku!)));
    bySku = new Map(remote.map((s) => [s.externalSkuId, s]));
    const actions = watched.flatMap((row) => {
      const r = bySku.get(row.externalSkuId!);
      const action = r && syncAction(row.status, r.state);
      return action ? [{ row, r, action }] : [];
    });
    // SKU đang tạm ngừng mà sàn tắt: app tắt (#224, việc đẩy tồn chạy song song chưa kịp ghi), không phải người bán (#360).
    const outside = actions.filter((a) => a.action === 'outside_hold').map((a) => a.row.variantId!);
    const paused = outside.length ? await inCompany(() => pausedVariants(port, outside)) : new Set<string>();
    for (const { row, r, action } of actions) {
      if (action === 'outside_hold' && paused.has(row.variantId!)) continue;
      const { patch, reason } = remoteChange(action, r.rejectReason);
      // Listing sang `live` thì đẩy tồn ngay trong lượt này (25 §6.5).
      const toLive = (action === 'approve' || action === 'release') && row.stockSync === 'synced';
      await inCompany(() => moveListing(row, action, null, toLive ? { ...patch, stockSync: 'pending' } : patch, reason));
      summary.changed++;
    }
    const acted = new Set(actions.map((a) => a.row.id));
    await holdChangedPrices(inCompany, session, watched.filter((r) => !acted.has(r.id)), bySku, summary);
    await syncCategories(port, inCompany, shop.platform, watched, bySku);
    rows = await inCompany(() => listListingRows(shop.id));
  }
  if (await checkRevisions(inCompany, adapter, accessToken, rows, summary)) rows = await inCompany(() => listListingRows(shop.id));
  // Ẩn, hiện theo trạng thái SKU sau khi áp trạng thái sàn: listing vừa được duyệt mà SKU đang tạm ngừng thì ẩn ngay (E25).
  rows = await applyVisibility(port, inCompany, session, rows, summary, bySku);

  const { changed, waiting } = reconcile
    ? await reconcileStock(port, inCompany, rows, bySku)
    : { changed: false, waiting: new Set<string>() };
  if (changed) rows = await inCompany(() => listListingRows(shop.id));
  await pushDue(port, inCompany, session, rows, holdStock, bySku, summary, waiting);
  // Lượt đẩy tồn đầu tiên sau thiết lập xong khi lượt này chạy hết (sàn lỗi cả lô thì ném trước, lượt sau đánh dấu).
  if (!holdStock && !shop.stockPushedAt) await inCompany(() => markStockPushed(shop.id));
  return summary;
}

/** Mã sản phẩm sàn của listing đang theo dõi (cần category, review BE2 P2-1). Gọi trong `withCompany`. */
export async function watchedProductIds(shopId: string): Promise<Set<string>> {
  const rows = await listListingRows(shopId);
  return new Set(rows.flatMap((r) => (WATCHED.includes(r.status) && r.externalProductId ? [r.externalProductId] : [])));
}

/**
 * Category của SKU sàn vừa sửa (#400 lát 13, TikTok, Thành chốt cách 2 ngày 19/11/2026): Search Products không trả category
 * nên lượt đồng bộ không biết; lần đọc theo giờ sửa (`listSkusChanged`, lọc `update_time_ge`) đã gọi Get Product cho sản phẩm
 * vừa sửa và adapter điền `externalCategoryId`. Áp lên listing đang theo dõi của gian hàng như nhánh Lazada (`syncCategories`).
 * Gọi ngoài giao dịch, sau khi đã gọi sàn.
 */
export async function syncChangedCategories(
  port: ProductPort,
  companyId: string,
  shop: Pick<ShopRow, 'id' | 'platform'>,
  skus: readonly RemoteSku[],
): Promise<void> {
  const bySku = new Map(skus.filter((s) => s.externalCategoryId).map((s) => [s.externalSkuId, s]));
  if (!bySku.size) return;
  const inCompany: InCompany = (fn) => withCompany(companyId, fn);
  const rows = (await inCompany(() => listListingRows(shop.id))).filter(
    (r) => WATCHED.includes(r.status) && r.externalSkuId !== null && bySku.has(r.externalSkuId),
  );
  await syncCategories(port, inCompany, shop.platform, rows, bySku);
}

/**
 * Category thật của listing trên sàn (#400 lát 13, Documents/19 mục 3.3): sàn trả category kèm SKU (`externalCategoryId`)
 * khác cột thì ghi cột (không tăng `version`); giá trị cũ trùng category của spec sản phẩm thì spec `changed` (`markSpecCategory`
 * chỉ đổi khi spec còn ở category cũ): người bán đổi category trên sàn, người dùng chọn lại trước lần đẩy sau. Cột còn trống
 * (listing trước #400) thì chỉ ghi, không đoán spec.
 */
async function syncCategories(
  port: ProductPort,
  inCompany: InCompany,
  platform: ShopRow['platform'],
  watched: readonly ListingRow[],
  bySku: ReadonlyMap<string, RemoteSku>,
): Promise<void> {
  const changes = watched.flatMap((row) => {
    const category = bySku.get(row.externalSkuId!)?.externalCategoryId;
    return category && category !== row.externalCategoryId ? [{ row, category }] : [];
  });
  // Sàn đã ở đúng category đích của lượt đổi: lượt `failed`/`mismatch` không còn đúng, xoá (#467).
  const resolved = watched.filter((row) => {
    const change = row.categoryChange;
    return change && change.status !== 'queued' && bySku.get(row.externalSkuId!)?.externalCategoryId === change.toCategoryId;
  });
  if (resolved.length) await inCompany(() => clearResolvedCategoryChange(resolved.map((r) => r.id)));
  if (!changes.length) return;
  await inCompany(async () => {
    const variantIds = changes.flatMap((c) => (c.row.externalCategoryId && c.row.variantId ? [c.row.variantId] : []));
    const productOf = new Map((variantIds.length ? await port.variants(variantIds) : []).map((v) => [v.id, v.productId]));
    for (const { row, category } of changes) {
      await setListingCategory([row.id], category);
      const productId = row.variantId ? productOf.get(row.variantId) : undefined;
      if (row.externalCategoryId && productId) await markSpecCategory(productId, platform, row.externalCategoryId, 'changed');
    }
  });
}

/**
 * Lấy đơn của gian hàng trước khi đối chiếu (25 §6.5 bước 1). Sàn chưa kéo đơn được, gian hàng chưa có mốc: không đối
 * chiếu. Lấy đơn lỗi (trừ mất uỷ quyền, gian hàng ngắt: ném như mọi lời gọi sàn) thì bỏ đối chiếu lượt này, vẫn đọc trạng
 * thái và đẩy phần đang chờ; vòng `channel.order_pull` tự thử lại.
 */
async function pullOrdersFirst(companyId: string, shop: ShopRow, adapter: MarketplaceAdapter): Promise<boolean> {
  if (!adapter.listOrders || !shop.orderCutoffAt) return false;
  try {
    await pullShopOrders(companyId, shop.id);
    return true;
  } catch (err) {
    if (shopStopped(err)) throw err;
    logger.warn({ shopId: shop.id, err }, 'Lấy đơn trước đối chiếu tồn lỗi, bỏ đối chiếu lượt này');
    return false;
  }
}

/**
 * Đối chiếu tồn (25 §6.5 bước 2) cho listing còn trên sàn không chờ đẩy (`synced`, hoặc `error` đang Lệch tồn), dùng số
 * sàn của lần đọc trạng thái vừa rồi (`sellableQuantity`; sàn không trả thì không đối chiếu). Listing sàn đang khoá tồn
 * do khuyến mãi bỏ qua (bước 3). Trả có dòng đổi không, và listing phải chờ lượt sau (`wait`): lượt này không đẩy tồn
 * cho chúng, kể cả listing đang Lệch tồn.
 */
async function reconcileStock(
  port: ProductPort,
  inCompany: InCompany,
  rows: ListingRow[],
  bySku: Map<string, RemoteSku>,
): Promise<{ changed: boolean; waiting: Set<string> }> {
  const candidates = rows.filter((r) => {
    const remote = r.externalSkuId ? bySku.get(r.externalSkuId) : undefined;
    return (
      r.mode === 'mapped' &&
      STOCK_RECONCILED.includes(r.status) &&
      !r.outsideChangeKind &&
      r.stockSync !== 'pending' &&
      remote?.sellableQuantity !== undefined &&
      !remote.stockLocked
    );
  });
  const waiting = new Set<string>();
  if (!candidates.length) return { changed: false, waiting };
  let changed = false;
  await inCompany(async () => {
    const available = await port.availableOf(candidates.map((r) => r.variantId!));
    // SKU chưa tin được (#223): số app có thể chưa trừ đơn bán ở gian hàng khác, nên chỉ cao hơn số thật. Khớp, hoặc sàn
    // cao hơn (đẩy giảm) vẫn làm; sàn thấp hơn (sẽ đẩy tăng, bật Lệch tồn) thì bỏ lượt này.
    const untrusted = await untrustedVariants();
    // SKU kho chưa có số (#460): không đối chiếu, không ghi `platform_stock`, không bật Lệch tồn.
    const counted = await countedOf(port, candidates.map((r) => r.variantId!));
    for (const row of candidates) {
      if (!zeroHidden(row) && !counted.has(row.variantId!)) continue;
      const app = zeroHidden(row) ? 0 : available.get(row.variantId!);
      if (app === undefined) continue;
      const remote = bySku.get(row.externalSkuId!)!.sellableQuantity!;
      const decision = stockDecision(row, remote, app);
      if (untrusted.has(row.variantId!) && remote < app) continue;
      if (decision === 'wait') waiting.add(row.id);
      const patch = reconcilePatch(row, decision, remote);
      if (!patch) continue;
      if (decision === 'drift') {
        const why = remote > app ? 'Lệch tồn: đã đẩy đúng số mà sàn vẫn cao hơn' : 'Lệch tồn: sàn thấp hơn số có thể bán hai lượt liền';
        logger.warn({ listingId: row.id, remote, available: app }, why);
      }
      // Lệch `version` (tồn vừa đổi): bỏ, dòng đã chờ đẩy số mới.
      if (await updateListing(row.id, { version: row.version }, patch)) changed = true;
    }
  });
  return { changed, waiting };
}

/** `platform_stock` giữ số sàn vừa đọc, để lượt sau biết sàn đã thấp hơn chưa. */
function reconcilePatch(row: ListingRow, decision: StockDecision, remote: number): ListingPatch | null {
  switch (decision) {
    case 'match':
      return row.stockSync === 'error' || row.platformStock !== remote ? { stockSync: 'synced', platformStock: remote } : null;
    case 'push':
      return { stockSync: row.stockSync === 'error' ? 'error' : 'pending', platformStock: remote };
    case 'drift':
      return { stockSync: 'error', platformStock: remote };
    case 'wait':
      return row.platformStock !== remote ? { platformStock: remote } : null;
  }
}

/**
 * Đẩy giá đang bán (ghi đè tay > giá theo gian hàng đã xác nhận > giá chuẩn, #225 phần 2) và số có thể bán của listing `mapped` có `stock_sync`/`price_sync` khác `synced`, lỗi ghi theo từng SKU.
 * `remote` (lần đọc trạng thái của lượt, rỗng ở `pushPending`): phần sàn khoá do khuyến mãi không gửi, chỉ báo (25 §6.5
 * bước 3, E32).
 */
async function pushDue(
  port: ProductPort,
  inCompany: InCompany,
  { adapter, accessToken, shop }: Session,
  rows: ListingRow[],
  holdStock: boolean,
  remote: Map<string, RemoteSku>,
  summary: SyncSummary,
  waiting: ReadonlySet<string> = new Set(),
): Promise<void> {
  // Gian hàng giữ tồn không gửi tồn, trừ listing ẩn bằng tồn 0 (gửi 0 không bao giờ làm bán quá).
  const stockPending = (r: ListingRow) => (!holdStock || zeroHidden(r)) && r.stockSync !== 'synced';
  // Sàn ẩn theo sản phẩm chỉ nhận giá khi sản phẩm đang bán (TikTok `prices/update`): listing ẩn giữ giá chờ, gửi khi hiện lại.
  const byProduct = hidesByProduct(adapter);
  const priceHeld = (r: ListingRow) => byProduct && r.status === 'hidden';
  const onPlatform = rows.filter((r) => r.mode === 'mapped' && PUSHABLE.includes(r.status) && r.externalSkuId);
  if (!onPlatform.length) return;
  // Giá đang bán của mọi listing trên sàn: đổi giá chuẩn hay xác nhận giá gian hàng không đánh dấu dòng, nên so ở đây (#360).
  const prices = await inCompany(async () => {
    const ids = onPlatform.map((r) => r.variantId!);
    return currentPrices(ids, onPlatform, await port.standardPrices(ids));
  });
  const priceOf = (r: ListingRow) => {
    const p = prices.get(r.variantId!)?.price;
    return p == null ? undefined : new Decimal(p);
  };
  // Giá chỉ gửi khi cần (#223 review 3): chờ đẩy giá, hoặc giá đang bán khác giá đang trên sàn. Không gửi kèm mỗi lần đẩy tồn.
  // Sàn đổi ngoài app: thôi đẩy giá tới khi CEO quyết, không tự đẩy đè (25 §6.5, #360).
  const priceDueOf = (r: ListingRow) => {
    const p = priceOf(r);
    return !r.outsideChangeKind && !priceHeld(r) && (r.priceSync !== 'synced' || (p !== undefined && (r.listedPrice === null || !p.eq(r.listedPrice))));
  };
  // Tồn cũng thôi đẩy khi có `outsideChange`, trừ dòng ẩn bằng tồn 0 (vẫn gửi 0).
  const due = onPlatform.filter((r) => (r.outsideChangeKind ? zeroHidden(r) && stockPending(r) : stockPending(r) || priceDueOf(r)));
  if (!due.length) return;
  const ids = due.map((r) => r.variantId!);
  const { available, untrusted, counted } = await inCompany(async () => ({
    available: holdStock ? new Map<string, number>() : await port.availableOf(ids),
    untrusted: holdStock ? new Map<string, ShopRow[]>() : await untrustedVariants(),
    counted: holdStock ? null : await countedOf(port, ids),
  }));
  const at = new Date();
  // Biến thể không có trong Map (đã xoá, công ty khác): không đẩy tồn, giữ `stock_sync = pending`, ghi `variant_missing`.
  const variantMissing: SyncError = {
    code: 'variant_missing',
    message: 'Không đọc được số có thể bán của SKU này',
    at: at.toISOString(),
  };
  const plan = due.map((row) => {
    const r = remote.get(row.externalSkuId!);
    const priceDue = priceDueOf(row);
    const price = priceDue && !r?.priceLocked ? priceOf(row) : undefined;
    // Chỉ gửi tồn khi listing chờ đẩy tồn: dòng chỉ chờ đẩy giá không kéo theo đẩy tồn (luật chờ một lượt, 25 §6.5).
    const zero = zeroHidden(row);
    const stockDue = stockPending(row) && !waiting.has(row.id);
    const wanted = !stockDue || r?.stockLocked ? undefined : zero ? 0 : available.get(row.variantId!);
    // SKU chưa tin được (#223, 21 §18.6.6): số app chỉ có thể cao hơn thật, nên chỉ đẩy khi không làm tồn trên sàn tăng,
    // so với số sàn ĐỌC THẬT trong lượt này (`sellableQuantity`). Không so với `platform_stock`: đó là số app gửi lần trước,
    // sàn có thể đã bán bớt mà app chưa biết (review R2-1). Đường không đọc sàn (`pushPending`) vì thế không đẩy tồn SKU
    // này. Bị giữ thì `pending` kèm `orders_stale`; lượt đồng bộ 15 phút hoặc lấy đơn xong trọn thì đẩy lại.
    // SKU kho chưa có số (#460, 25 §6.4 "Ghép listing có sẵn"): không đẩy số có thể bán (0) đè tồn trên sàn, thắng
    // `orders_stale`. Listing ẩn bằng tồn 0 vẫn gửi 0: đó là lệnh ngừng bán, không phải số tồn.
    const uncounted = wanted !== undefined && !zero && counted !== null && !counted.has(row.variantId!);
    const staleShops = untrusted.get(row.variantId!);
    const stale = !uncounted && staleShops !== undefined && wanted !== undefined && !zero && raisesStock(wanted, r?.sellableQuantity);
    const blocked = uncounted || stale;
    const quantity = blocked ? undefined : wanted;
    const item: PriceQuantity | null =
      !price && quantity === undefined
        ? null
        : {
            externalProductId: row.externalProductId!,
            externalSkuId: row.externalSkuId!,
            ...(price && { price: price.toFixed(0) }),
            ...(quantity !== undefined && { quantity }),
          };
    const held: ListingPatch = uncounted ? { stockSyncError: notCountedError(at) } : stale ? { stockSyncError: ordersStaleError(staleShops!, at) } : {};
    return { row, item, stockDue: stockDue && !blocked, priceDue, locked: { ...lockPatch(r, at), ...held } };
  });
  const isMissing = (p: (typeof plan)[number]) => p.stockDue && !p.locked.stockSyncError && p.item?.quantity === undefined;
  const missing = plan.filter(isMissing).length;
  if (missing) logger.warn({ shopId: shop.id, missing }, 'Đồng bộ listing bỏ qua SKU không đọc được số có thể bán');
  const items = plan.flatMap((p) => (p.item ? [p.item] : []));
  const results = new Map(
    items.length
      ? (await onMarketplace(() => adapter.updatePriceQuantity(accessToken, items))).map((x) => [x.externalSkuId, x])
      : [],
  );
  await inCompany(async () => {
    for (const p of plan) {
      const { row, item, locked, priceDue } = p;
      let patch: ListingPatch = isMissing(p) ? { stockSyncError: variantMissing } : {};
      // Chờ đẩy giá mà không có giá chuẩn (giá bị khoá thì `locked` báo).
      if (priceDue && item?.price === undefined && !locked.priceSyncError) {
        patch = { ...patch, priceSync: 'error', priceSyncError: { code: 'price_missing', message: 'Chưa có giá chuẩn', at: at.toISOString() } };
      }
      if (item) {
        summary.pushed++;
        // Sàn trả kết quả riêng cho tồn và giá (`stock`, `price`) thì áp riêng; không thì một kết quả chung cho cả hai.
        const result = results.get(row.externalSkuId!);
        const whole: PartResult = result ?? { ok: false, code: 'no_result', message: 'Sàn không trả kết quả cho SKU này' };
        const stock = item.quantity === undefined ? undefined : (result?.stock ?? whole);
        const price = item.price === undefined ? undefined : (result?.price ?? whole);
        if ((stock && !stock.ok) || (price && !price.ok)) summary.errors++;
        if (stock) patch = { ...patch, ...(stock.ok ? stockSynced(row, item.quantity!) : stockFailed(row, syncError(stock, at))) };
        if (price) patch = { ...patch, ...(price.ok ? { priceSync: 'synced', priceSyncError: null, listedPrice: item.price! } : { priceSync: 'error', priceSyncError: syncError(price, at) }) };
        // Giá theo gian hàng đã lên sàn: lần tính `confirmed` → `pushed` (Documents/19 `price_calculations`).
        if (price?.ok && row.priceCalcId && row.manualPrice === null) await markPushed(row.priceCalcId);
        if (stock?.ok || price?.ok) patch = { ...patch, lastPushedAt: at };
      }
      patch = { ...patch, ...locked };
      // Lệch `version` (tồn vừa đổi, đánh dấu lại pending giữa lúc đọc và lúc ghi): bỏ kết quả lượt này, giữ dòng
      // như đang có để lượt sau đẩy số mới; không tính là lỗi.
      await updateListing(row.id, { version: row.version }, patch);
    }
  });
}

/** Mã lỗi giữ tồn của SKU kho chưa có số (#460). */
export const STOCK_NOT_COUNTED = 'stock_not_counted';

/** SKU có số trong kho; cổng giả của test không có `countedOf` thì coi mọi SKU đã có số. */
export async function countedOf(port: ProductPort, ids: readonly string[]): Promise<Set<string>> {
  return port.countedOf ? port.countedOf(ids) : new Set(ids);
}

/** Lý do giữ tồn của SKU kho chưa có số (`stockSyncError.code = 'stock_not_counted'`, 21 §18.6.6). */
function notCountedError(at: Date): SyncError {
  return {
    code: STOCK_NOT_COUNTED,
    message: 'Chưa có số tồn: SKU chưa nhập kho, chưa kiểm kê nên app chưa đẩy tồn lên sàn',
    at: at.toISOString(),
  };
}

/** Sàn khoá tồn hoặc giá do khuyến mãi (`RemoteSku.stockLocked`, `priceLocked`): giữ số cũ trên sàn, ghi lỗi để báo. */
function lockPatch(remote: RemoteSku | undefined, at: Date): ListingPatch {
  const error = (what: string): SyncError => ({
    code: PROMOTION_LOCKED,
    message: `Sàn đang khoá ${what} do khuyến mãi, không ghi đè`,
    at: at.toISOString(),
  });
  return {
    ...(remote?.stockLocked && { stockSyncError: error('tồn') }),
    ...(remote?.priceLocked && { priceSync: 'error' as const, priceSyncError: error('giá') }),
  };
}

/**
 * Ngắt kèm `zeroStock` (§18.1): đẩy tồn 0 cho listing còn trên sàn trước khi ngắt. Không gọi được sàn (gian hàng cần
 * nối lại, sàn lỗi) thì 422 `zero_stock_unavailable` và chưa ngắt; lỗi riêng từng SKU thì vẫn ngắt. Trả id listing mà sàn
 * nhận tồn 0, để route trả lại tồn thật nếu ngắt bị chặn sau đó (`restoreAfterZeroStock`).
 */
export async function pushZeroStock(actor: Actor, shopId: string): Promise<string[]> {
  const unavailable = () =>
    new AppError(422, 'zero_stock_unavailable', 'Không đồng bộ được tồn 0 lên sàn lúc này; ngắt kết nối không kèm đồng bộ tồn 0, hoặc thử lại');
  const session = await withCompany(actor.companyId, () => shopSession(shopId)).catch((err: unknown) => {
    throw err instanceof AppError && err.code === 'shop_not_connected' ? unavailable() : err;
  });
  const rows = await withCompany(actor.companyId, () => listListingRows(session.shop.id));
  const pushed = rows.filter((r) => PUSHABLE.includes(r.status) && r.externalSkuId);
  if (!pushed.length) return [];
  const items = pushed.map((r) => ({ externalProductId: r.externalProductId!, externalSkuId: r.externalSkuId!, quantity: 0 }));
  let results: PerSkuResult[];
  try {
    results = await session.adapter.updatePriceQuantity(session.accessToken, items);
  } catch (err) {
    if (err instanceof MarketplaceError) throw unavailable();
    throw err;
  }
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.externalSkuId));
  return pushed.filter((r) => ok.has(r.externalSkuId!)).map((r) => r.id);
}

/**
 * Ngắt bị chặn sau khi đã đẩy tồn 0 (đơn về, `version` đổi giữa hai lần kiểm; #207): listing về `stock_sync = pending`
 * để lượt đồng bộ đẩy lại tồn thật. Chỉ gọi khi ngắt thất bại, nên không đẩy lại tồn lên gian hàng sắp ngắt.
 */
export async function restoreAfterZeroStock(actor: Actor, listingIds: readonly string[]): Promise<void> {
  if (listingIds.length) await withCompany(actor.companyId, () => markStockPendingIds(listingIds));
}

/**
 * Bản sửa nội dung đang duyệt (#293, §18.3): qua duyệt thì xoá, trượt thì `failed` kèm lý do sàn ghi. Ghi theo dòng đọc
 * lại, không so `version` của lúc đọc đầu lượt. Lỗi của một listing ghi log rồi bỏ qua, lượt sau đọc lại; mất uỷ quyền thì
 * ném như mọi lời gọi sàn. Trả true khi có dòng đổi.
 */
async function checkRevisions(
  inCompany: InCompany,
  adapter: MarketplaceAdapter,
  accessToken: string,
  rows: readonly ListingRow[],
  summary: SyncSummary,
): Promise<boolean> {
  if (!adapter.contentRevision) return false;
  let changed = false;
  for (const row of rows.filter((r) => r.revisionStatus === 'auditing' && r.externalProductId)) {
    try {
      const rev = await onMarketplace(() => adapter.contentRevision!(accessToken, row.externalProductId!));
      if (rev.state === 'auditing') continue;
      const patch: ListingPatch = rev.state === 'failed' ? { revisionStatus: 'failed', revisionRejectReason: rev.reason ?? NO_REASON } : NO_REVISION;
      await inCompany(async () => {
        const fresh = await findListingById(row.id);
        if (fresh?.revisionStatus === 'auditing') await updateListing(fresh.id, { version: fresh.version, status: fresh.status }, patch);
      });
      changed = true;
      summary.changed++;
    } catch (err) {
      if (err instanceof AppError && err.code === 'marketplace_unauthorized') throw err;
      logger.warn({ err, listingId: row.id }, 'Đọc bản sửa nội dung đang duyệt lỗi, lượt sau đọc lại');
      summary.errors++;
    }
  }
  return changed;
}

/**
 * Dữ liệu ghi kèm khi áp thao tác của sàn. Sàn xoá sản phẩm (`delist`, hệ thống): bỏ mã sản phẩm, mã SKU, ảnh trên sàn
 * vì sản phẩm không còn, giữ SellerSku; đẩy lại sẽ tạo sản phẩm mới (#219).
 */
function remoteChange(action: ListingAction, rejectReason: string | null | undefined): { patch: ListingPatch; reason: string | null } {
  if (action === 'reject') {
    const reason = rejectReason ?? NO_REASON;
    // `live`, `hidden` → `rejected` (#389): bỏ cách ẩn (CHECK `listings_hidden_by`).
    return { patch: { rejectReason: reason, hiddenBy: null }, reason };
  }
  // CHECK `listings_hidden_by`: chỉ `hidden`, `live` mang `hidden_by`.
  if (action === 'delist') {
    return { patch: { externalProductId: null, externalSkuId: null, externalImageUrls: null, hiddenBy: null }, reason: 'Sàn báo đã xoá sản phẩm' };
  }
  if (action === 'hold') return { patch: { hiddenBy: null }, reason: null };
  if (action === 'outside_hold') {
    return { patch: { hiddenBy: 'platform', outsideChangeKind: 'disabled', outsideChangeAt: new Date() }, reason: 'Sàn tắt ngoài app' };
  }
  return { patch: {}, reason: null };
}

/** Tồn lên sàn: listing đang Lệch tồn giữ `error` tới khi lượt đối chiếu sau thấy khớp (#223). */
function stockSynced(row: ListingRow, quantity: number): ListingPatch {
  return { stockSync: row.stockSync === 'error' ? 'error' : 'synced', stockSyncError: null, platformStock: quantity };
}

/**
 * Tồn đẩy lỗi giữ `pending` kèm `stockSyncError` (Documents/21 mục 18.5, 18.6.6); `error` dành cho nhãn Lệch tồn (giữ
 * nguyên nếu đang Lệch tồn). Sàn từ chối giảm tồn vì khuyến mãi (`promotion_locked`): sàn đang cao hơn số có thể bán, app
 * không ép được, nên ghi câu rõ cho người dùng xử lý trên trang sàn, vẫn `pending` để lượt sau gửi lại, không bật Lệch tồn.
 */
function stockFailed(row: ListingRow, error: SyncError): ListingPatch {
  const stockError: SyncError =
    error.code === PROMOTION_LOCKED
      ? {
          ...error,
          message: `Sàn đang khoá giảm tồn do khuyến mãi; sàn đang cao hơn số có thể bán, cần xử lý trên trang sàn. Sàn báo: ${error.message}`,
        }
      : error;
  return { stockSync: row.stockSync === 'error' ? 'error' : 'pending', stockSyncError: stockError };
}

function syncError(part: PartResult & { ok: false }, at: Date): SyncError {
  return { code: part.code, message: part.message, at: at.toISOString() };
}
