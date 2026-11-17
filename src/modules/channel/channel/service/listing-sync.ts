// Đồng bộ listing với sàn (#104; Documents/21 §18.3, §18.4, §18.5): đọc trạng thái sàn theo SellerSku của mình (#104 A4),
// đối chiếu tồn (#223, 25 §6.5), đẩy giá và tồn của listing chờ đồng bộ theo lô. Gọi sàn ngoài giao dịch như
// `listings.ts`. Bấm tay ở route `sync`; #102 gọi lại `syncListings` theo lịch. Đẩy ngay khi số có thể bán đổi:
// `pushPending` (việc `channel.stock_push`).
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
  findListingById,
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
  type PartResult,
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
  let rows = await inCompany(() => listListingRows(session.shop.id));
  rows = await applyVisibility(port, inCompany, session, rows, summary);
  await pushDue(port, inCompany, session, rows, holdsStock(session.shop), new Map(), summary);
  if (shopOrdersStale(session.shop)) await inCompany(() => sendOrderPull(companyId, shopId));
  return summary;
}

/** Listing ẩn bằng tồn 0 (`hideBy = 'zero_stock'`): số nên có trên sàn là 0, không phải số có thể bán (#224). */
const zeroHidden = (row: ListingRow) => row.status === 'hidden' && row.hiddenBy === 'zero_stock';

/**
 * Sàn tắt theo cả sản phẩm và bật lại phải duyệt lại (TikTok): chưa ẩn, hiện theo SKU tới phần 2 của #224, vì tắt một
 * SKU tạm ngừng sẽ ẩn cả các SKU còn bán cùng sản phẩm.
 */
const VISIBILITY_LATER: ReadonlySet<string> = new Set(['tiktok']);
/** App tự ẩn, hiện listing theo trạng thái SKU trên sàn này chưa (`applyVisibility`; TikTok tới phần 2 của #224). */
export const appHidesOn = (platform: string): boolean => !VISIBILITY_LATER.has(platform);
/**
 * Lần vào `hidden` mà app được tự hiện lại: `hide` (tạm ngừng SKU), hoặc `outside_hold` đã được CEO `restore` lúc SKU
 * đang tạm ngừng (dòng chờ quyết lọc trước theo `outsideChangeKind`). `relist` (nối lại gian hàng) không.
 */
const APP_HIDDEN = new Set(['hide', 'outside_hold']);

/**
 * Bật lại SKU trên sàn (#224 hiện lại, #360 CEO bật lại). Adapter không có `activate`, hoặc sàn bật theo cả sản phẩm mà
 * app chưa tự ẩn, hiện (TikTok tới phần 2 của #224: bật một listing sẽ bật mọi SKU cùng sản phẩm) thì `unsupported`.
 */
export async function activateOnMarketplace(
  { shop, adapter, accessToken }: Pick<Session, 'shop' | 'adapter' | 'accessToken'>,
  productId: string,
  skuId: string,
): Promise<void> {
  if (!adapter.activate || !appHidesOn(shop.platform)) throw new MarketplaceError('unsupported', 'activate_missing', 'Sàn chưa hỗ trợ bật lại sản phẩm từ app');
  await adapter.activate(accessToken, productId, skuId);
}

export async function pausedVariants(port: ProductPort, variantIds: string[]): Promise<Set<string>> {
  const variants = await port.variants([...new Set(variantIds)]);
  return new Set(variants.filter((v) => v.businessStatus === 'paused').map((v) => v.id));
}

/**
 * Ẩn, hiện listing theo trạng thái SKU (#224, 25 §6.4, `visibilityAction`). `hideBy = 'deactivate'`: gọi sàn tắt, bật
 * (`hiddenBy = 'platform'`); `zero_stock`: không gọi sàn ở đây, `hiddenBy = 'zero_stock'` và chờ đẩy tồn để `pushDue` gửi 0
 * (hiện lại thì gửi số có thể bán). Gọi sàn ngoài giao dịch, ghi DB sau khi sàn nhận. Lỗi của một listing chỉ ghi log và
 * giữ nguyên trạng thái để lượt sau làm lại (mất uỷ quyền, gian hàng ngắt thì ném như mọi lời gọi sàn). Có dòng đổi thì
 * trả danh sách listing đọc lại.
 */
async function applyVisibility(
  port: ProductPort,
  inCompany: InCompany,
  { shop, adapter, accessToken }: Session,
  rows: ListingRow[],
  summary: SyncSummary,
): Promise<ListingRow[]> {
  if (VISIBILITY_LATER.has(shop.platform)) return rows;
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
  for (const row of candidates) {
    const action = visibilityAction(row.status, paused.has(row.variantId!), APP_HIDDEN.has(entered.get(row.id) ?? ''));
    if (!action) continue;
    try {
      if (byPlatform) {
        await onMarketplace(async () => {
          if (action === 'hide') return adapter.deactivate(accessToken, row.externalProductId!, row.externalSkuId!);
          return activateOnMarketplace({ shop, adapter, accessToken }, row.externalProductId!, row.externalSkuId!);
        });
      }
    } catch (err) {
      if (err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected')) throw err;
      logger.warn({ err, listingId: row.id, action }, 'Ẩn, hiện listing theo trạng thái SKU lỗi, lượt sau thử lại');
      summary.errors++;
      continue;
    }
    const reason = action === 'hide' ? 'SKU tạm ngừng bán' : 'SKU bỏ tạm ngừng bán';
    if (await inCompany(() => moveAfterMarketplace(row, action, (r) => patchFor(action, r), reason))) {
      changed = true;
      summary.changed++;
    }
  }
  return changed ? inCompany(() => listListingRows(shop.id)) : rows;
}

/**
 * Giá gốc trên sàn khác giá app đẩy lần cuối (#360, 21 §18.3, 25 §6.5): không tự đẩy đè. Listing `live` → `outside_hold`
 * kèm `outsideChange` `price_changed`, app tắt SKU trên sàn (`hideBy = 'deactivate'` và app tự ẩn được trên sàn này) hoặc
 * đưa tồn sàn về 0 (`hidden_by = 'zero_stock'`, `pushDue` gửi 0). Listing `hidden` sẵn chỉ ghi `outsideChange`, giữ cách ẩn.
 * Lỗi sàn của một listing chỉ log, lượt sau so lại; mất uỷ quyền, gian hàng ngắt thì ném.
 */
async function holdChangedPrices(
  inCompany: InCompany,
  { shop, adapter, accessToken }: Session,
  rows: ListingRow[],
  bySku: Map<string, RemoteSku>,
  summary: SyncSummary,
): Promise<void> {
  const now = Date.now();
  const byPlatform = adapter.capabilities.hideBy === 'deactivate' && appHidesOn(shop.platform);
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
    const actions = watched.flatMap((row) => {
      const r = bySku.get(row.externalSkuId!);
      const action = r && syncAction(row.status, r.state);
      return action ? [{ row, r, action }] : [];
    });
    // SKU đang tạm ngừng mà sàn tắt: app tắt (#224, việc đẩy tồn chạy song song chưa kịp ghi), không phải người bán (#360).
    const outside = actions.filter((a) => a.action === 'outside_hold').map((a) => a.row.variantId!);
    const paused = outside.length && appHidesOn(shop.platform) ? await inCompany(() => pausedVariants(port, outside)) : new Set<string>();
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
    rows = await inCompany(() => listListingRows(shop.id));
  }
  if (await checkRevisions(inCompany, adapter, accessToken, rows, summary)) rows = await inCompany(() => listListingRows(shop.id));
  // Ẩn, hiện theo trạng thái SKU sau khi áp trạng thái sàn: listing vừa được duyệt mà SKU đang tạm ngừng thì ẩn ngay (E25).
  rows = await applyVisibility(port, inCompany, session, rows, summary);

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
    for (const row of candidates) {
      const app = zeroHidden(row) ? 0 : available.get(row.variantId!);
      if (app === undefined) continue;
      const remote = bySku.get(row.externalSkuId!)!.sellableQuantity!;
      const decision = stockDecision(row, remote, app);
      if (untrusted.has(row.variantId!) && (decision === 'wait' || decision === 'drift')) continue;
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
  // Gian hàng giữ tồn không gửi tồn, trừ listing ẩn bằng tồn 0 (gửi 0 không bao giờ làm bán quá).
  const stockPending = (r: ListingRow) => (!holdStock || zeroHidden(r)) && r.stockSync !== 'synced';
  const due = rows.filter(
    (r) =>
      r.mode === 'mapped' &&
      PUSHABLE.includes(r.status) &&
      r.externalSkuId &&
      // Sàn đổi ngoài app: thôi đẩy cả tồn lẫn giá tới khi CEO quyết, không tự đẩy đè (25 §6.5, #360); riêng dòng ẩn
      // bằng tồn 0 vẫn gửi 0 (giá thì không, xem `priceDue`).
      (!r.outsideChangeKind ? stockPending(r) || r.priceSync !== 'synced' : zeroHidden(r) && stockPending(r)),
  );
  if (!due.length) return;
  const ids = due.map((r) => r.variantId!);
  const { prices, available, untrusted } = await inCompany(async () => ({
    prices: await port.standardPrices(ids),
    available: holdStock ? new Map<string, number>() : await port.availableOf(ids),
    untrusted: holdStock ? new Map<string, ShopRow[]>() : await untrustedVariants(),
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
    const standard = prices.get(row.variantId!) ?? undefined;
    // Giá chỉ gửi khi cần (#223 review 3): chờ đẩy giá, hoặc giá chuẩn khác giá đang trên sàn. Không gửi kèm mỗi lần đẩy tồn.
    const priceDue =
      !row.outsideChangeKind &&
      (row.priceSync !== 'synced' || (standard !== undefined && (row.listedPrice === null || !standard.eq(row.listedPrice))));
    const price = priceDue && !r?.priceLocked ? standard : undefined;
    // Chỉ gửi tồn khi listing chờ đẩy tồn: dòng chỉ chờ đẩy giá không kéo theo đẩy tồn (luật chờ một lượt, 25 §6.5).
    const zero = zeroHidden(row);
    const stockDue = stockPending(row) && !waiting.has(row.id);
    const wanted = !stockDue || r?.stockLocked ? undefined : zero ? 0 : available.get(row.variantId!);
    // SKU chưa tin được (#223, 21 §18.6.6): số app chỉ có thể cao hơn thật, nên chỉ đẩy khi không làm tồn trên sàn tăng,
    // so với số sàn ĐỌC THẬT trong lượt này (`sellableQuantity`). Không so với `platform_stock`: đó là số app gửi lần trước,
    // sàn có thể đã bán bớt mà app chưa biết (review R2-1). Đường không đọc sàn (`pushPending`) vì thế không đẩy tồn SKU
    // này. Bị giữ thì `pending` kèm `orders_stale`; lượt đồng bộ 15 phút hoặc lấy đơn xong trọn thì đẩy lại.
    const staleShops = untrusted.get(row.variantId!);
    const blocked = staleShops !== undefined && wanted !== undefined && !zero && raisesStock(wanted, r?.sellableQuantity);
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
    const held: ListingPatch = blocked ? { stockSyncError: ordersStaleError(staleShops, at) } : {};
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
        if (stock?.ok || price?.ok) patch = { ...patch, lastPushedAt: at };
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
    return { patch: { rejectReason: reason }, reason };
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
