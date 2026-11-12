// Đồng bộ listing với sàn (#104; Documents/21 §18.3, §18.4, §18.5): đọc trạng thái sàn theo SellerSku của mình (#104 A4),
// đối chiếu tồn (#223, 25 §6.5), đẩy giá và tồn của listing chờ đồng bộ theo lô. Gọi sàn ngoài giao dịch như
// `listings.ts`. Bấm tay ở route `sync`; #102 gọi lại `syncListings` theo lịch. Đẩy ngay khi số có thể bán đổi:
// `pushPending` (việc `channel.stock_push`).
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import type { EventPayload } from '../../../core/index.ts';
import {
  DELETABLE,
  type ListingAction,
  type ListingStatus,
  STALE_PUSH_MS,
  STOCK_RECONCILED,
  type StockDecision,
  stockDecision,
  syncAction,
} from '../domain/listing.ts';
import { holdsStock } from '../domain/shop.ts';
import {
  type ListingPatch,
  type ListingRow,
  listListingRows,
  markStockPendingIds,
  markStockPendingRows,
  updateListing,
} from '../repository/listings.ts';
import { markStockPushed, type ShopRow } from '../repository/shops.ts';
import type { SyncError } from '../repository/schema.ts';
import {
  type MarketplaceAdapter,
  MarketplaceError,
  type PerSkuResult,
  PROMOTION_LOCKED,
  type PriceQuantity,
  type RemoteSku,
} from './marketplaces/index.ts';
import { moveListing } from './listings.ts';
import { pullShopOrders } from './order-pull.ts';
import type { ProductPort } from './product-port.ts';
import { sendListingSync, sendOrderPull, sendStockPush } from './shop-jobs.ts';
import { type Actor, onMarketplace, ownShop, shopSession } from './shops.ts';
import { shopOrdersStale, untrustedVariants } from './stock-trust.ts';

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
interface Session {
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
  const rows = await inCompany(() => listListingRows(session.shop.id));
  await pushDue(port, inCompany, session, rows, holdsStock(session.shop), new Map(), summary);
  if (shopOrdersStale(session.shop)) await inCompany(() => sendOrderPull(companyId, shopId));
  return summary;
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
    const message = 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại';
    const pushError: SyncError = { code: 'marketplace_unavailable', message, at: new Date().toISOString() };
    await inCompany(() => moveListing(row, 'fail', null, { pushError }, message));
    summary.changed++;
  }

  const watched = rows.filter((r) => WATCHED.includes(r.status) && r.sellerSku && r.externalSkuId);
  summary.checked = watched.length;
  let bySku = new Map<string, RemoteSku>();
  if (watched.length) {
    const remote = await onMarketplace(() => adapter.getSkus(accessToken, watched.map((r) => r.sellerSku!)));
    bySku = new Map(remote.map((s) => [s.externalSkuId, s]));
    for (const row of watched) {
      const r = bySku.get(row.externalSkuId!);
      const action = r && syncAction(row.status, r.state);
      if (!action) continue;
      const { patch, reason } = remoteChange(action, r.rejectReason);
      // Listing sang `live` thì đẩy tồn ngay trong lượt này (25 §6.5).
      const toLive = (action === 'approve' || action === 'release') && row.stockSync === 'synced';
      await inCompany(() => moveListing(row, action, null, toLive ? { ...patch, stockSync: 'pending' } : patch, reason));
      summary.changed++;
    }
    rows = await inCompany(() => listListingRows(shop.id));
  }

  const { changed, waiting } = reconcile
    ? await reconcileStock(port, inCompany, rows, bySku)
    : { changed: false, waiting: new Set<string>() };
  if (changed) rows = await inCompany(() => listListingRows(shop.id));
  await pushDue(port, inCompany, session, rows, holdStock, bySku, summary, waiting);
  // Lượt đẩy tồn đầu tiên sau thiết lập xong khi lượt này chạy hết (sàn lỗi cả lô thì ném trước, lượt sau đánh dấu).
  if (!holdStock && !shop.stockPushedAt) await inCompany(() => markStockPushed(shop.id));
  return summary;
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
    if (err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected')) throw err;
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
    // SKU chưa tin được (#223): số app chưa trừ đơn bán ở gian hàng khác, so với sàn sẽ ra "sàn thấp hơn" rồi đẩy tăng.
    const untrusted = await untrustedVariants();
    for (const row of candidates) {
      const app = available.get(row.variantId!);
      if (app === undefined || untrusted.has(row.variantId!)) continue;
      const remote = bySku.get(row.externalSkuId!)!.sellableQuantity!;
      const decision = stockDecision(row, remote, app);
      if (decision === 'wait') waiting.add(row.id);
      const patch = reconcilePatch(row, decision, remote);
      if (!patch) continue;
      if (decision === 'drift') logger.warn({ listingId: row.id, remote, available: app }, 'Lệch tồn: sàn thấp hơn số có thể bán hai lượt liền');
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
 * Đẩy giá chuẩn và số có thể bán của listing `mapped` có `stock_sync`/`price_sync` khác `synced`, lỗi ghi theo từng SKU.
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
  const due = rows.filter(
    (r) =>
      r.mode === 'mapped' &&
      PUSHABLE.includes(r.status) &&
      r.externalSkuId &&
      ((!holdStock && r.stockSync !== 'synced') || r.priceSync !== 'synced'),
  );
  if (!due.length) return;
  const ids = due.map((r) => r.variantId!);
  const { prices, available, untrusted } = await inCompany(async () => ({
    prices: await port.standardPrices(ids),
    available: holdStock ? new Map<string, number>() : await port.availableOf(ids),
    untrusted: holdStock ? new Set<string>() : await untrustedVariants(),
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
    const price = r?.priceLocked ? undefined : prices.get(row.variantId!);
    // Chỉ gửi tồn khi listing chờ đẩy tồn: dòng chỉ chờ đẩy giá không kéo theo đẩy tồn (luật chờ một lượt, 25 §6.5).
    // SKU chưa tin được (#223, 21 §18.6.6): không gửi tồn, giữ chờ, không ghi lỗi; lấy đơn xong trọn thì việc đẩy chạy lại.
    const stockDue = !holdStock && row.stockSync !== 'synced' && !waiting.has(row.id) && !untrusted.has(row.variantId!);
    const quantity = !stockDue || r?.stockLocked ? undefined : available.get(row.variantId!);
    const item: PriceQuantity | null =
      !price && quantity === undefined
        ? null
        : {
            externalProductId: row.externalProductId!,
            externalSkuId: row.externalSkuId!,
            ...(price && { price: price.toFixed(0) }),
            ...(quantity !== undefined && { quantity }),
          };
    return { row, item, stockDue, locked: lockPatch(r, at) };
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
      const { row, item, locked } = p;
      let patch: ListingPatch = isMissing(p) ? { stockSyncError: variantMissing } : {};
      if (item) {
        const result = results.get(row.externalSkuId!);
        summary.pushed++;
        if (result?.ok) {
          patch = { ...patch, ...synced(row, item, at) };
        } else {
          summary.errors++;
          const error: SyncError = {
            code: result?.code ?? 'no_result',
            message: result?.message ?? 'Sàn không trả kết quả cho SKU này',
            at: at.toISOString(),
          };
          patch = { ...patch, ...failed(row, error, item) };
        }
      }
      patch = { ...patch, ...locked };
      // Lệch `version` (tồn vừa đổi, đánh dấu lại pending giữa lúc đọc và lúc ghi): bỏ kết quả lượt này, giữ dòng
      // như đang có để lượt sau đẩy số mới; không tính là lỗi.
      await updateListing(row.id, { version: row.version }, patch);
    }
  });
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
    new AppError(422, 'zero_stock_unavailable', 'Không đẩy được tồn 0 lên sàn lúc này; ngắt không kèm đẩy tồn 0, hoặc thử lại');
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
 * Dữ liệu ghi kèm khi áp thao tác của sàn. Sàn xoá sản phẩm (`delist`, hệ thống): bỏ mã sản phẩm, mã SKU, ảnh trên sàn
 * vì sản phẩm không còn, giữ SellerSku; đẩy lại sẽ tạo sản phẩm mới (#219).
 */
function remoteChange(action: ListingAction, rejectReason: string | null | undefined): { patch: ListingPatch; reason: string | null } {
  if (action === 'reject') {
    const reason = rejectReason ?? 'Sàn từ chối, không ghi lý do';
    return { patch: { rejectReason: reason }, reason };
  }
  if (action === 'delist') {
    return { patch: { externalProductId: null, externalSkuId: null, externalImageUrls: null }, reason: 'Sàn báo đã xoá sản phẩm' };
  }
  return { patch: {}, reason: null };
}

/** Đẩy được: listing đang Lệch tồn giữ `error` tới khi lượt đối chiếu sau thấy khớp (#223). */
function synced(row: ListingRow, item: PriceQuantity, at: Date): ListingPatch {
  return {
    ...(item.quantity !== undefined && {
      stockSync: row.stockSync === 'error' ? 'error' : 'synced',
      stockSyncError: null,
      platformStock: item.quantity,
    }),
    ...(item.price === undefined
      ? { priceSync: 'error', priceSyncError: { code: 'price_missing', message: 'Chưa có giá chuẩn', at: at.toISOString() } }
      : { priceSync: 'synced', priceSyncError: null, listedPrice: item.price }),
    lastPushedAt: at,
  };
}

/**
 * Kết quả theo SKU gộp giá và tồn (adapter giữ lỗi đầu tiên): lỗi của SKU là lỗi của cả hai. Tồn đẩy lỗi giữ `pending`
 * kèm `stockSyncError` (Documents/21 mục 18.5, 18.6.6); `error` dành cho nhãn Lệch tồn (giữ nguyên nếu đang Lệch tồn).
 * Sàn từ chối giảm tồn vì khuyến mãi (`promotion_locked`): sàn đang cao hơn số có thể bán, app không ép được, nên ghi câu
 * rõ cho người dùng xử lý trên trang sàn, vẫn `pending` để lượt sau gửi lại, không bật Lệch tồn. Giá bị khoá giữ giá cũ.
 */
function failed(row: ListingRow, error: SyncError, item: PriceQuantity): ListingPatch {
  const stockError: SyncError =
    error.code === PROMOTION_LOCKED
      ? {
          ...error,
          message: `Sàn đang khoá giảm tồn do khuyến mãi; sàn đang cao hơn số có thể bán, cần xử lý trên trang sàn. Sàn báo: ${error.message}`,
        }
      : error;
  return {
    ...(item.quantity !== undefined && { stockSync: row.stockSync === 'error' ? 'error' : 'pending', stockSyncError: stockError }),
    ...(item.price !== undefined && { priceSync: 'error', priceSyncError: error }),
  };
}
