// Ghép SKU tay (#220; Documents/21 §18.3, §18.6.5; 25 §6.4 "Ghép listing có sẵn", §8.1, §11). Bảng ghép là `listings`:
// SKU sàn chưa ghép thì tạo listing `live`, không đẩy lại. Ghép sang "không quản tồn" hoặc đổi ghép đã có đơn: người không
// được tự duyệt (không phải CEO, công ty nhiều người) thì lưu ghép chờ (`pending_*`), CEO duyệt hoặc từ chối; CEO làm thì áp
// luôn, ghi tự duyệt. Ghép có hiệu lực (áp ngay, CEO duyệt, bấm lại ghép đã đúng) thì áp lên dòng **chưa ghép** của đơn
// đã nhận cùng gian hàng, cùng giao dịch (#237: `applySkuMapping` của `order` giữ hàng, trừ tồn bù); dòng đã ghép giữ ghép
// cũ (đổi ghép đơn đã về là PR 2 của #237), đơn kéo về sau tra `seller_sku` theo ghép mới.
// Biến thể có listing lỗi đẩy chưa có mã sàn (#346): ghép SKU sàn chưa có listing thì dùng lại listing đó; ghép SKU sàn đã có
// listing thì listing lỗi tự gỡ.
import { canSelfApprove, findMembership, memberRolesOf, recordTransition } from '../../../core/index.ts';
import { applySkuMapping } from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import {
  deleteListing,
  findListingById,
  findListingByExternalSku,
  findListingByPendingExternalSku,
  findListingRow,
  type ListingPatch,
  type ListingRow,
  liveListingRows,
} from '../repository/listings.ts';
import { hasOrdersWithSellerSku, variantsBySellerSku } from '../repository/raw-orders.ts';
import { findRemoteSkuRow, listRemoteSkuRows, type RemoteSkuRow } from '../repository/remote-skus.ts';
import { lockShopRow, type ShopRow } from '../repository/shops.ts';
import { insertListing, updateListing } from './listing-writes.ts';
import { REFRESH_COOLDOWN_MS, RemoteSkusRetryLater, requestRemoteSkusRefresh } from './remote-skus.ts';
import { type RefreshState, refreshState } from '../domain/remote-skus-refresh.ts';
import { NO_PENDING } from '../domain/listing.ts';
import { type RemoteTitleChanged, remoteTitleChanged, snapshotBaseline } from '../domain/remote-title.ts';
import { type ChannelListing, moveListing, requesterNames, toListing } from './listings.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, ownShop } from './shops.ts';
import { sendSpecFromMatch } from './spec-from-match.ts';

const ENTITY = 'listings';
/** Dòng nhật ký của lần tự duyệt ghép SKU: nhãn là SKU người bán, thiếu thì mã SKU sàn (#352). */
const auditOf = (row: { sellerSku: string | null; externalSkuId: string | null }) => ({
  entityType: 'channel.listings',
  label: row.sellerSku ?? row.externalSkuId ?? 'Listing chưa có SKU',
});

export interface RemoteSkuItem {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  titleEn: string | null;
  matchedVariantId: string | null;
  mode: 'mapped' | 'unmanaged' | null;
  listingId: string | null;
  listingVersion: number | null;
  pendingMapping: ChannelListing['pendingMapping'];
  /** Tên trên sàn khác tên lúc ghép (#396), chỉ với listing đang ghép SKU này. */
  remoteTitleChanged: RemoteTitleChanged | null;
}

/** Ghép đang có hiệu lực: dòng tạo ra chỉ để chờ duyệt "không quản tồn" (chưa ai duyệt) là chưa ghép. */
const effectiveMode = (r: ListingRow): RemoteSkuItem['mode'] => (r.mode === 'unmanaged' && !r.approvedBy ? null : r.mode);

const invalid = (field: string, message: string) =>
  new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { [field]: message } });

/**
 * SKU đang có trên sàn kèm ghép hiện hành (§18.3 `remote-skus`), đọc từ bản sao `remote_skus` (lần đồng bộ gần nhất,
 * `syncedAt` là lần đọc trọn), kèm `refresh` (trạng thái lượt Tải lại, `refreshState`). Không gọi sàn trong request (#361):
 * - `refresh` (nút Tải lại): lần đọc trọn trước còn trong `REFRESH_COOLDOWN_MS` thì trả bản sao (`accepted: false`, 200);
 *   lần đọc trọn lỗi chưa quá 10 phút thì 429 `remote_skus_retry_later`; đang có lượt chạy thì không xếp thêm; còn lại
 *   (kể cả lượt kẹt `refresh_stale`) xếp lượt tải nền. Hai nhánh sau trả `accepted: true` (202).
 * - Chưa có bản sao: xếp lượt tải nền như Tải lại, trừ khi đang chạy hoặc lần lỗi gần nhất chưa quá 10 phút (lỗi trả ở
 *   `refresh.error`, không 429) hoặc lượt chờ kẹt `refresh_stale` (chỉ Tải lại xếp lại, review #361).
 * Ghép theo `external_sku_id` của listing chưa gỡ. `unmatched`: chỉ SKU chưa có ghép hiệu lực.
 */
export async function remoteSkus(
  actor: Actor,
  shopId: string,
  unmatched: boolean,
  refresh = false,
): Promise<{ items: RemoteSkuItem[]; syncedAt: Date | null; refresh: RefreshState; accepted: boolean }> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const now = new Date();
    const state = refreshState(shop, now);
    let accepted = false;
    let requestedAt: Date | undefined;
    if (refresh) {
      const synced = shop.remoteSkusSyncedAt?.getTime();
      if (synced === undefined || now.getTime() - synced >= REFRESH_COOLDOWN_MS) {
        if (state.status === 'failed' && state.retryAfterSeconds !== null) throw new RemoteSkusRetryLater(state.retryAfterSeconds);
        if (state.status !== 'running') requestedAt = await requestRemoteSkusRefresh(shop);
        accepted = true;
      }
    } else if (!shop.remoteSkusSyncedAt && state.status === 'idle') {
      requestedAt = await requestRemoteSkusRefresh(shop);
    }
    const remote = await listRemoteSkuRows(shop.id);
    const rows = await liveListingRows(shop.id);
    const names = await requesterNames(rows);
    const byExternal = new Map(rows.flatMap((r) => (r.externalSkuId ? [[r.externalSkuId, r] as const] : [])));
    const byPending = new Map(rows.flatMap((r) => (r.pendingExternalSkuId ? [[r.pendingExternalSkuId, r] as const] : [])));
    const items = remote.map((r): RemoteSkuItem => {
      // SKU sàn chờ CEO duyệt ghép vào listing lỗi đẩy (#346): chưa ghép, CEO duyệt qua listing đó.
      const listing = byExternal.get(r.externalSkuId) ?? byPending.get(r.externalSkuId);
      const mode = listing?.externalSkuId === r.externalSkuId ? effectiveMode(listing) : null;
      return {
        externalProductId: r.externalProductId,
        externalSkuId: r.externalSkuId,
        sellerSku: r.sellerSku,
        title: r.title,
        titleEn: r.titleEn,
        matchedVariantId: mode === 'mapped' ? listing!.variantId : null,
        mode,
        // CEO tìm yêu cầu ghép chờ duyệt ở đây, kể cả "không quản tồn" của SKU chưa ghép (dòng `variant_id` null không có
        // trong `GET /listings`) (review #309).
        listingId: listing?.id ?? null,
        listingVersion: listing?.version ?? null,
        pendingMapping: listing ? toListing(listing, names).pendingMapping : null,
        remoteTitleChanged: listing?.externalSkuId === r.externalSkuId ? remoteTitleChanged(listing, r) : null,
      };
    });
    return {
      items: unmatched ? items.filter((i) => i.mode === null) : items,
      syncedAt: shop.remoteSkusSyncedAt,
      // Chỉ lượt vừa xếp đổi trạng thái so với dòng đã đọc: không đọc lại `shops` (FE hỏi lại GET liên tục).
      refresh: requestedAt ? refreshState({ ...shop, remoteSkusRefreshRequestedAt: requestedAt }, now) : state,
      accepted,
    };
  });
}

/** Người làm có vai trò CEO (route duyệt ghép, §18.3 "`listing.manage` + vai trò CEO"). */
export async function isCeo(actor: Actor): Promise<boolean> {
  return withCompany(actor.companyId, async () => {
    const member = await findMembership(actor.accountId, actor.companyId);
    if (!member || member.status !== 'active') return false;
    return ((await memberRolesOf([member.id])).get(member.id) ?? []).some((r) => r.isCeo);
  });
}

const TAKEN = 'Biến thể đã ghép SKU sàn khác của gian hàng này';
/** Lý do gỡ listing lỗi đẩy khi biến thể của nó ghép SKU sàn đã có listing (#346). */
const SUPERSEDED = 'Thay bằng ghép SKU sàn có sẵn';

/**
 * Biến thể của công ty, chưa lưu trữ; trả listing lỗi đẩy chưa có mã sàn của nó trên gian hàng (bên gọi dùng lại hoặc gỡ,
 * #346), không có thì `undefined`. Listing khác của biến thể đang đẩy: 409 `invalid_transition`; listing lỗi đang chờ duyệt
 * ghép: 409 `mapping_pending`; còn lại (đã có mã sàn): 422. Gọi trong `withCompany`.
 */
async function variantSlot(port: ProductPort, shopId: string, variantId: string, listingId: string | null): Promise<ListingRow | undefined> {
  const [v] = await port.variants([variantId]);
  if (!v) throw invalid('variantId', 'Biến thể không thuộc công ty');
  if (v.archived) throw invalid('variantId', 'Biến thể đã lưu trữ');
  const other = await findListingRow(shopId, variantId);
  if (!other || other.status === 'delisted' || other.id === listingId) return undefined;
  if (other.status === 'pushing') {
    throw new AppError(409, 'invalid_transition', 'Biến thể đang đẩy lên sàn, ghép sau khi có kết quả', { current: toListing(other) });
  }
  if (other.status !== 'push_failed' || other.externalSkuId) throw invalid('variantId', TAKEN);
  if (other.pendingRequestedBy) {
    throw new AppError(409, 'mapping_pending', 'Listing lỗi đẩy của biến thể đang chờ CEO duyệt ghép', { current: toListing(other) });
  }
  return other;
}

/** Ghi SKU sàn vào listing lỗi đẩy: `live`, xoá lỗi; tồn, giá đẩy ở lượt đồng bộ (`applyPatch` đặt `pending`). */
const attach = (sku: { externalSkuId: string; externalProductId: string; sellerSku: string }, platformStock: number | null): ListingPatch => ({
  ...sku,
  status: 'live',
  // #399: SKU sàn có sẵn, nội dung là của người bán (kể cả dùng lại listing lỗi đẩy).
  contentSource: 'platform',
  pushError: null,
  hiddenBy: null,
  platformStock,
});

/** Ghép mới chép vào cột hiện hành; tồn, giá của SKU sàn đẩy lại theo biến thể mới ở lượt đồng bộ sau. */
const applyPatch = (variantId: string | null, requestedBy: string, approvedBy: string | null, selfApproved: boolean): ListingPatch => ({
  mode: variantId ? 'mapped' : 'unmanaged',
  variantId,
  mappingRequestedBy: requestedBy,
  approvedBy,
  mappingSelfApproved: selfApproved,
  ...NO_PENDING,
  stockSync: 'pending',
  priceSync: 'pending',
  stockSyncError: null,
  priceSyncError: null,
});

/**
 * Áp ghép có hiệu lực lên đơn đã về (spec 237 §5.3). Gọi trong giao dịch đã khoá dòng gian hàng, sau khi ghi listing.
 * Ghép là của **dòng thắng** theo SKU người bán (D12: gian hàng có thể có hai listing trùng `seller_sku`; lượt kéo đơn cũng
 * tra theo dòng thắng); dòng thắng chưa ghép (chỉ chờ duyệt "không quản tồn") thì không áp. Lỗi nào cũng ném: cả giao dịch
 * ghép rollback, người bấm bấm lại.
 */
async function applyToOrders(shop: ShopRow, sellerSku: string | null, actorId: string): Promise<void> {
  if (!sellerSku) return;
  const to = (await variantsBySellerSku(shop.id, [sellerSku])).get(sellerSku);
  if (!to || to.kind === 'unmapped') return;
  await applySkuMapping({
    shopId: shop.id,
    sellerSku,
    to,
    actorId,
    holdStock: shop.openingStocktakeId === null,
    orderCutoffAt: shop.orderCutoffAt,
  });
}

/** 409 `version_conflict` kèm `current` là listing mới nhất (null khi không còn), như mọi route sửa có `version`. */
const conflict = (current: ListingRow | undefined, names?: Map<string, string>) =>
  new AppError(409, 'version_conflict', 'Listing vừa được cập nhật, thử lại', { current: current ? toListing(current, names) : null });
/** Đọc lại listing chưa gỡ của SKU sàn rồi báo 409. Gọi trong `withCompany`. */
const conflictAt = async (shopId: string, externalSkuId: string) => {
  const row = await findListingByExternalSku(shopId, externalSkuId);
  return conflict(row, row ? await requesterNames([row]) : undefined);
};
/** Đọc lại listing theo id rồi báo 409. Gọi trong `withCompany`. */
const conflictById = async (id: string) => {
  const row = await findListingById(id);
  return conflict(row, row ? await requesterNames([row]) : undefined);
};

/**
 * `POST /shops/:id/listings/match` (§18.3, §18.6.5). `pending: true` (202) khi ghép chờ CEO duyệt. Thứ tự kiểm: gian hàng
 * `active` (409 `shop_not_active`; ghép lúc `connecting` là bước thiết lập), listing chưa gỡ của SKU sàn đang chờ duyệt
 * (409 `mapping_pending`) hay đang đẩy (409 `invalid_transition`), biến thể (422 `errors.variantId`), SKU sàn còn trên sàn
 * và có SKU người bán (422 `errors.externalSkuId`; chỉ đọc sàn khi SKU chưa có listing).
 */
export async function matchListing(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  input: { externalSkuId: string; variantId: string | null },
): Promise<{ listing: ChannelListing; pending: boolean }> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  const shop = await inCompany(() => ownShop(shopId));
  if (shop.status !== 'active') {
    throw new AppError(409, 'shop_not_active', 'Hoàn tất thiết lập gian hàng trước khi ghép SKU', { current: shop.status });
  }
  const { variantId, externalSkuId } = input;
  const before = await inCompany(() => findListingByExternalSku(shop.id, externalSkuId));
  if (before?.pendingRequestedBy) {
    throw new AppError(409, 'mapping_pending', 'Listing này đang chờ CEO duyệt ghép', { current: toListing(before) });
  }
  if (before?.status === 'pushing') {
    throw new AppError(409, 'invalid_transition', 'Listing đang đẩy lên sàn, ghép sau khi có kết quả', { current: toListing(before) });
  }
  const waiting = await inCompany(() => findListingByPendingExternalSku(shop.id, externalSkuId));
  if (waiting) throw new AppError(409, 'mapping_pending', 'SKU sàn này đang chờ CEO duyệt ghép', { current: toListing(waiting) });
  if (variantId) await inCompany(() => variantSlot(port, shop.id, variantId, before?.id ?? null));
  let remote: RemoteSkuRow | undefined;
  if (!before) {
    // SKU người bán (vòng kéo đơn tra biến thể theo đây) và mã sản phẩm lấy từ bản sao SKU sàn, không gọi sàn (#220 đợt 2).
    remote = await inCompany(() => findRemoteSkuRow(shop.id, externalSkuId));
    if (!remote) throw invalid('externalSkuId', 'SKU sàn chưa có trong lần đồng bộ gần nhất, bấm Tải lại rồi ghép');
    if (!remote.sellerSku) throw invalid('externalSkuId', 'SKU sàn chưa có SKU người bán, đặt trên sàn trước rồi ghép');
  }
  const selfOk = await inCompany(() => canSelfApprove(actor.accountId));

  try {
    const result = await inCompany(async () => {
      // Khoá dòng gian hàng chặn khoá chia sẻ của lượt nhận đơn (`lockShopForOrders`): đơn mang SellerSku này về giữa
      // lúc kiểm "đã có đơn" và lúc ghi thì không lọt bước CEO duyệt; lượt nhận đơn sau đó tra ra ghép mới (review #309 N1).
      const locked = (await lockShopRow(shop.id))!;
      const row = await findListingByExternalSku(shop.id, externalSkuId);
      // Request khác vừa ghép, đổi hay gỡ listing của SKU sàn này giữa hai lần đọc.
      if (row?.id !== before?.id || (row && row.version !== before!.version)) throw conflict(row, row ? await requesterNames([row]) : undefined);
      if (await findListingByPendingExternalSku(shop.id, externalSkuId)) throw new AppError(409, 'mapping_pending', 'SKU sàn này đang chờ CEO duyệt ghép');
      const failed = variantId ? await variantSlot(port, shop.id, variantId, row?.id ?? null) : undefined;
      if (!row && failed) {
        const reused = await reuseFailed(failed, remote!, actor, selfOk);
        if (!reused.pending) {
          await applyToOrders(locked, reused.row.sellerSku, actor.accountId);
          await sendSpecFromMatch(actor.companyId, shop.id, [reused.row.id]);
        }
        return reused;
      }
      if (row && effectiveMode(row) === (variantId ? 'mapped' : 'unmanaged') && row.variantId === variantId) {
        // Ghép đã đúng: vẫn áp, là cách chạy bù cho đơn về trước #237 và cho lần áp lỗi (spec 237 §5.3, §5.9).
        await applyToOrders(locked, row.sellerSku, actor.accountId);
        await sendSpecFromMatch(actor.companyId, shop.id, [row.id]);
        return { row, pending: false };
      }
      // 25 §8.1, §11: "không quản tồn" luôn cần CEO duyệt; đổi ghép cần khi đã có đơn mang SKU người bán này.
      const needsCeo = variantId === null || (row !== undefined && row.sellerSku !== null && (await hasOrdersWithSellerSku(shop.id, row.sellerSku)));
      const now = new Date();
      if (needsCeo && !selfOk) {
        const pending = { pendingVariantId: variantId, pendingMode: variantId ? 'mapped' : 'unmanaged', pendingRequestedBy: actor.accountId, pendingRequestedAt: now } as const;
        const saved = row
          ? await updateListing(row.id, { version: row.version, status: row.status }, pending)
          : await insertListing({
              companyId: actor.companyId,
              shopId: shop.id,
              mode: 'unmanaged',
              externalSkuId,
              externalProductId: remote!.externalProductId,
              sellerSku: remote!.sellerSku,
              status: 'live',
              platformStock: remote!.quantity,
              contentSource: 'platform',
              ...pending,
            });
        if (!saved) throw await conflictAt(shop.id, externalSkuId);
        await recordTransition({ entityType: ENTITY, entityId: saved.id, from: row?.status ?? null, to: saved.status, action: 'request_mapping', actorId: actor.accountId });
        return { row: saved, pending: true };
      }
      if (failed) await moveListing(failed, 'delist', actor, { hiddenBy: null }, SUPERSEDED);
      // Ghép có hiệu lực: mốc tên trên sàn là tên hiện tại trong bản sao, xoá cờ (#396).
      const patch = {
        ...applyPatch(variantId, actor.accountId, needsCeo ? actor.accountId : null, needsCeo),
        ...snapshotBaseline(row ? await findRemoteSkuRow(shop.id, externalSkuId) : remote),
      };
      const saved = row
        ? await updateListing(row.id, { version: row.version, status: row.status }, patch)
        : await insertListing({
            companyId: actor.companyId,
            shopId: shop.id,
            ...patch,
            externalSkuId,
            externalProductId: remote!.externalProductId,
            sellerSku: remote!.sellerSku,
            status: 'live',
            platformStock: remote!.quantity,
            contentSource: 'platform',
          });
      if (!saved) throw await conflictAt(shop.id, externalSkuId);
      await recordTransition({
        entityType: ENTITY,
        entityId: saved.id,
        from: row?.status ?? null,
        to: saved.status,
        action: 'match',
        actorId: actor.accountId,
        selfApproved: needsCeo,
        audit: auditOf(saved),
      });
      await applyToOrders(locked, saved.sellerSku, actor.accountId);
      // Spec của sản phẩm theo category trên sàn (#400 lát 12): việc nền, cùng giao dịch ghép.
      await sendSpecFromMatch(actor.companyId, shop.id, [saved.id]);
      return { row: saved, pending: false };
    });
    return { listing: toListing(result.row, await inCompany(() => requesterNames([result.row]))), pending: result.pending };
  } catch (err) {
    // Hai request ghép cùng lúc: unique của bảng chặn dòng thứ hai (lỗi 23505 làm hỏng giao dịch nên bắt ngoài).
    const constraint = pgError(err).constraint;
    if (constraint === 'listings_shop_variant_uq') throw invalid('variantId', TAKEN);
    if (constraint === 'listings_shop_external_sku_uq') throw await inCompany(() => conflictAt(shop.id, externalSkuId));
    if (constraint === 'listings_shop_pending_external_sku_uq') throw new AppError(409, 'mapping_pending', 'SKU sàn này đang chờ CEO duyệt ghép');
    throw err;
  }
}

/**
 * Ghép SKU sàn chưa có listing vào biến thể có listing lỗi đẩy chưa có mã sàn (#346, Documents/21 §18.3 `match`): dùng lại
 * listing đó. Đổi SKU người bán mà đã có đơn mang SKU người bán cũ là đổi ánh xạ đã dùng: người không được tự duyệt thì ghi
 * yêu cầu chờ (kèm SKU sàn) lên listing lỗi, giữ `push_failed`. Gọi trong giao dịch đã khoá gian hàng.
 */
async function reuseFailed(failed: ListingRow, remote: RemoteSkuRow, actor: Actor, selfOk: boolean): Promise<{ row: ListingRow; pending: boolean }> {
  const sku = { externalSkuId: remote.externalSkuId, externalProductId: remote.externalProductId, sellerSku: remote.sellerSku };
  const needsCeo =
    failed.sellerSku !== null && failed.sellerSku !== remote.sellerSku && (await hasOrdersWithSellerSku(failed.shopId, failed.sellerSku));
  const guard = { version: failed.version, status: failed.status };
  if (needsCeo && !selfOk) {
    const saved = await updateListing(failed.id, guard, {
      pendingVariantId: failed.variantId,
      pendingMode: 'mapped',
      pendingRequestedBy: actor.accountId,
      pendingRequestedAt: new Date(),
      pendingExternalSkuId: sku.externalSkuId,
      pendingExternalProductId: sku.externalProductId,
      pendingSellerSku: sku.sellerSku,
    });
    if (!saved) throw await conflictById(failed.id);
    await recordTransition({ entityType: ENTITY, entityId: saved.id, from: failed.status, to: saved.status, action: 'request_mapping', actorId: actor.accountId });
    return { row: saved, pending: true };
  }
  const saved = await updateListing(failed.id, guard, {
    ...applyPatch(failed.variantId, actor.accountId, needsCeo ? actor.accountId : null, needsCeo),
    ...attach(sku, remote.quantity),
    ...snapshotBaseline(remote),
  });
  if (!saved) throw await conflictById(failed.id);
  await recordTransition({
    entityType: ENTITY,
    entityId: saved.id,
    from: failed.status,
    to: saved.status,
    action: 'match',
    actorId: actor.accountId,
    selfApproved: needsCeo,
    audit: auditOf(saved),
  });
  return { row: saved, pending: false };
}

/**
 * `POST /shops/:id/listings/:listingId/mapping/:action` (§18.3, §18.6.5): CEO duyệt hoặc từ chối ghép chờ. Route đã kiểm
 * quyền và vai trò CEO. Thứ tự: 404 → 409 `invalid_transition` (không có ghép chờ, listing đã gỡ hoặc đang đẩy) → 409 `version_conflict`; hai lần duyệt đua về cùng biến thể → 422 `errors.variantId`.
 * Duyệt: áp ghép mới (kiểm lại biến thể), rồi áp lên dòng chưa ghép của đơn đã nhận (#237). Từ chối: bỏ ghép chờ; dòng tạo ra chỉ để chờ duyệt
 * "không quản tồn" thì xoá (CHECK `listings_unmanaged_approved`), body là listing lúc xoá.
 */
export function decideMapping(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  listingId: string,
  action: 'approve' | 'reject',
  input: { version: number; reason?: string | undefined },
): Promise<ChannelListing> {
  // Hai lần duyệt đua về cùng biến thể: unique chặn lần sau (23505 làm hỏng giao dịch nên bắt ngoài).
  return decide(port, actor, shopId, listingId, action, input).catch((err: unknown) => {
    const constraint = pgError(err).constraint;
    if (constraint === 'listings_shop_variant_uq') throw invalid('variantId', TAKEN);
    // SKU sàn chờ ghép vào listing lỗi đã có listing khác lúc duyệt (#346).
    if (constraint === 'listings_shop_external_sku_uq') throw invalid('externalSkuId', 'SKU sàn đã ghép listing khác, từ chối yêu cầu này');
    throw err;
  });
}

async function decide(
  port: ProductPort,
  actor: Actor,
  shopId: string,
  listingId: string,
  action: 'approve' | 'reject',
  input: { version: number; reason?: string | undefined },
): Promise<ChannelListing> {
  if (action === 'reject' && !input.reason) throw invalid('reason', 'Nhập lý do từ chối');
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    // Khoá dòng gian hàng như `matchListing`: lượt nhận đơn không chen giữa lúc duyệt và lúc áp lên đơn đã về (#237).
    const locked = (await lockShopRow(shop.id))!;
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== shop.id) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    const names = await requesterNames([row]);
    if (!row.pendingRequestedBy || row.status === 'delisted') {
      throw new AppError(409, 'invalid_transition', 'Listing không có ghép chờ duyệt', { current: toListing(row, names) });
    }
    // Đổi biến thể giữa lúc việc đẩy đang chạy thì việc đẩy nội dung biến thể mới lên sản phẩm cũ (review #220).
    if (row.status === 'pushing') {
      throw new AppError(409, 'invalid_transition', 'Listing đang đẩy lên sàn, duyệt sau khi có kết quả', { current: toListing(row, names) });
    }
    if (row.version !== input.version) {
      throw new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', { current: toListing(row, names) });
    }
    const transition = { entityType: ENTITY, entityId: row.id, from: row.status, to: row.status, actorId: actor.accountId };
    if (action === 'approve') {
      // Người duyệt khác người xin (25 §11); người xin tự duyệt chỉ khi được tự duyệt (CEO, công ty một người), ghi nhãn.
      // CSDL ép lại bằng CHECK `listings_mapping_second_person`.
      const selfApproved = actor.accountId === row.pendingRequestedBy;
      if (selfApproved && !(await canSelfApprove(actor.accountId))) {
        throw new AppError(409, 'second_person_required', 'Bước này cần người khác người lập thực hiện');
      }
      const patch = applyPatch(row.pendingVariantId, row.pendingRequestedBy, actor.accountId, selfApproved);
      const { pendingExternalSkuId, pendingExternalProductId, pendingSellerSku } = row;
      if (pendingExternalSkuId && pendingExternalProductId && pendingSellerSku) {
        // Yêu cầu ghép SKU sàn vào listing lỗi đẩy (#346): ghi mã sàn, listing thành `live`.
        const quantity = (await findRemoteSkuRow(shop.id, pendingExternalSkuId))?.quantity ?? null;
        Object.assign(patch, attach({ externalSkuId: pendingExternalSkuId, externalProductId: pendingExternalProductId, sellerSku: pendingSellerSku }, quantity));
      } else if (row.pendingVariantId) {
        const failed = await variantSlot(port, shop.id, row.pendingVariantId, row.id);
        if (failed) await moveListing(failed, 'delist', actor, { hiddenBy: null }, SUPERSEDED);
      }
      const externalSkuId = pendingExternalSkuId ?? row.externalSkuId;
      Object.assign(patch, snapshotBaseline(externalSkuId ? await findRemoteSkuRow(shop.id, externalSkuId) : undefined));
      const saved = await updateListing(row.id, { version: row.version, status: row.status }, patch);
      if (!saved) throw await conflictById(row.id);
      await recordTransition({ ...transition, to: saved.status, action: 'approve_mapping', selfApproved, audit: auditOf(saved) });
      await applyToOrders(locked, saved.sellerSku, actor.accountId);
      await sendSpecFromMatch(actor.companyId, shop.id, [saved.id]);
      return toListing(saved);
    }
    const reason = input.reason ?? null;
    if (effectiveMode(row) === null) {
      if (!(await deleteListing(row.id, row.version))) throw await conflictById(row.id);
      await recordTransition({ ...transition, action: 'reject_mapping', reason });
      return { ...toListing(row), pendingMapping: null };
    }
    const saved = await updateListing(
      row.id,
      { version: row.version, status: row.status },
      NO_PENDING,
    );
    if (!saved) throw await conflictById(row.id);
    await recordTransition({ ...transition, action: 'reject_mapping', reason });
    return toListing(saved);
  });
}
