// Ghép SKU tay (#220; Documents/21 §18.3, §18.6.5; 25 §6.4 "Ghép listing có sẵn", §8.1, §11). Bảng ghép là `listings`:
// SKU sàn chưa ghép thì tạo listing `live`, không đẩy lại. Ghép sang "không quản tồn" hoặc đổi ghép đã có đơn: người không
// được tự duyệt (không phải CEO, công ty nhiều người) thì lưu ghép chờ (`pending_*`), CEO duyệt hoặc từ chối; CEO làm thì áp
// luôn, ghi tự duyệt. Đơn đã nhận giữ ghép cũ: chỉ đơn kéo về sau theo ghép mới (vòng kéo đơn tra `seller_sku`).
import { canSelfApprove, findMembership, memberRolesOf, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { pgError } from '../../../../shared/db/pg-error.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import {
  deleteListing,
  findListingById,
  findListingByExternalSku,
  findListingRow,
  insertListing,
  type ListingPatch,
  type ListingRow,
  liveListingRows,
  updateListing,
} from '../repository/listings.ts';
import { hasOrdersWithSellerSku } from '../repository/raw-orders.ts';
import { findRemoteSkuRow, listRemoteSkuRows, type RemoteSkuRow } from '../repository/remote-skus.ts';
import { findShopRow, lockShopRow } from '../repository/shops.ts';
import { refreshRemoteSkusNow } from './remote-skus.ts';
import { type ChannelListing, requesterNames, toListing } from './listings.ts';
import type { ProductPort } from './product-port.ts';
import { type Actor, ownShop } from './shops.ts';

const ENTITY = 'listings';
const AUDIT = { entityType: 'channel.listings' };

export interface RemoteSkuItem {
  externalProductId: string;
  externalSkuId: string;
  sellerSku: string;
  title: string;
  matchedVariantId: string | null;
  mode: 'mapped' | 'unmanaged' | null;
  listingId: string | null;
  listingVersion: number | null;
  pendingMapping: ChannelListing['pendingMapping'];
}

/** Ghép đang có hiệu lực: dòng tạo ra chỉ để chờ duyệt "không quản tồn" (chưa ai duyệt) là chưa ghép. */
const effectiveMode = (r: ListingRow): RemoteSkuItem['mode'] => (r.mode === 'unmanaged' && !r.approvedBy ? null : r.mode);

const invalid = (field: string, message: string) =>
  new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors: { [field]: message } });

/**
 * SKU đang có trên sàn kèm ghép hiện hành (§18.3 `remote-skus`), đọc từ bản sao `remote_skus` (lần đồng bộ gần nhất,
 * `syncedAt` là lần đọc trọn). Chưa có bản sao thì đọc trọn sàn một lần rồi lưu; `refresh` (nút Tải lại) đọc trọn lại,
 * trừ khi lần trước còn trong `REFRESH_COOLDOWN_MS`. Ghép theo `external_sku_id` của listing chưa gỡ. `unmatched`: chỉ
 * SKU chưa có ghép hiệu lực.
 */
export async function remoteSkus(
  actor: Actor,
  shopId: string,
  unmatched: boolean,
  refresh = false,
): Promise<{ items: RemoteSkuItem[]; syncedAt: Date | null }> {
  const inCompany = <T>(fn: () => Promise<T>) => withCompany(actor.companyId, fn);
  const shop = await inCompany(() => ownShop(shopId));
  if (refresh || !shop.remoteSkusSyncedAt) await refreshRemoteSkusNow(actor.companyId, shop.id, { cooldown: refresh });
  return inCompany(async () => {
    const remote = await listRemoteSkuRows(shop.id);
    const rows = await liveListingRows(shop.id);
    const names = await requesterNames(rows);
    const byExternal = new Map(rows.flatMap((r) => (r.externalSkuId ? [[r.externalSkuId, r] as const] : [])));
    const items = remote.map((r): RemoteSkuItem => {
      const listing = byExternal.get(r.externalSkuId);
      const mode = listing ? effectiveMode(listing) : null;
      return {
        externalProductId: r.externalProductId,
        externalSkuId: r.externalSkuId,
        sellerSku: r.sellerSku,
        title: r.title,
        matchedVariantId: mode === 'mapped' ? listing!.variantId : null,
        mode,
        // CEO tìm yêu cầu ghép chờ duyệt ở đây, kể cả "không quản tồn" của SKU chưa ghép (dòng `variant_id` null không có
        // trong `GET /listings`) (review #309).
        listingId: listing?.id ?? null,
        listingVersion: listing?.version ?? null,
        pendingMapping: listing ? toListing(listing, names).pendingMapping : null,
      };
    });
    const syncedAt = (await findShopRow(shop.id))?.remoteSkusSyncedAt ?? null;
    return { items: unmatched ? items.filter((i) => i.mode === null) : items, syncedAt };
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

/** Biến thể của công ty, chưa lưu trữ, chưa ghép listing khác (chưa gỡ) của gian hàng. Gọi trong `withCompany`. */
async function assertVariantFree(port: ProductPort, shopId: string, variantId: string, listingId: string | null): Promise<void> {
  const [v] = await port.variants([variantId]);
  if (!v) throw invalid('variantId', 'Biến thể không thuộc công ty');
  if (v.archived) throw invalid('variantId', 'Biến thể đã lưu trữ');
  const other = await findListingRow(shopId, variantId);
  if (other && other.status !== 'delisted' && other.id !== listingId) {
    throw invalid('variantId', 'Biến thể đã ghép SKU sàn khác của gian hàng này');
  }
}

/** Ghép mới chép vào cột hiện hành; tồn, giá của SKU sàn đẩy lại theo biến thể mới ở lượt đồng bộ sau. */
const applyPatch = (variantId: string | null, requestedBy: string, approvedBy: string | null, selfApproved: boolean): ListingPatch => ({
  mode: variantId ? 'mapped' : 'unmanaged',
  variantId,
  mappingRequestedBy: requestedBy,
  approvedBy,
  mappingSelfApproved: selfApproved,
  pendingVariantId: null,
  pendingMode: null,
  pendingRequestedBy: null,
  pendingRequestedAt: null,
  stockSync: 'pending',
  priceSync: 'pending',
  stockSyncError: null,
  priceSyncError: null,
});

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
  if (variantId) await inCompany(() => assertVariantFree(port, shop.id, variantId, before?.id ?? null));
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
      await lockShopRow(shop.id);
      const row = await findListingByExternalSku(shop.id, externalSkuId);
      // Request khác vừa ghép, đổi hay gỡ listing của SKU sàn này giữa hai lần đọc.
      if (row?.id !== before?.id || (row && row.version !== before!.version)) throw conflict(row, row ? await requesterNames([row]) : undefined);
      if (variantId) await assertVariantFree(port, shop.id, variantId, row?.id ?? null);
      if (row && effectiveMode(row) === (variantId ? 'mapped' : 'unmanaged') && row.variantId === variantId) {
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
              ...pending,
            });
        if (!saved) throw await conflictAt(shop.id, externalSkuId);
        await recordTransition({ entityType: ENTITY, entityId: saved.id, from: row?.status ?? null, to: saved.status, action: 'request_mapping', actorId: actor.accountId });
        return { row: saved, pending: true };
      }
      const patch = applyPatch(variantId, actor.accountId, needsCeo ? actor.accountId : null, needsCeo);
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
        audit: { ...AUDIT, label: saved.sellerSku },
      });
      return { row: saved, pending: false };
    });
    return { listing: toListing(result.row, await inCompany(() => requesterNames([result.row]))), pending: result.pending };
  } catch (err) {
    // Hai request ghép cùng lúc: unique của bảng chặn dòng thứ hai (lỗi 23505 làm hỏng giao dịch nên bắt ngoài).
    const constraint = pgError(err).constraint;
    if (constraint === 'listings_shop_variant_uq') throw invalid('variantId', 'Biến thể đã ghép SKU sàn khác của gian hàng này');
    if (constraint === 'listings_shop_external_sku_uq') throw await inCompany(() => conflictAt(shop.id, externalSkuId));
    throw err;
  }
}

/**
 * `POST /shops/:id/listings/:listingId/mapping/:action` (§18.3, §18.6.5): CEO duyệt hoặc từ chối ghép chờ. Route đã kiểm
 * quyền và vai trò CEO. Thứ tự: 404 → 409 `invalid_transition` (không có ghép chờ, listing đã gỡ hoặc đang đẩy) → 409 `version_conflict`; hai lần duyệt đua về cùng biến thể → 422 `errors.variantId`.
 * Duyệt: áp ghép mới (kiểm lại biến thể); đơn đã nhận giữ ghép cũ. Từ chối: bỏ ghép chờ; dòng tạo ra chỉ để chờ duyệt
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
    if (pgError(err).constraint === 'listings_shop_variant_uq') throw invalid('variantId', 'Biến thể đã ghép SKU sàn khác của gian hàng này');
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
      if (row.pendingVariantId) await assertVariantFree(port, shop.id, row.pendingVariantId, row.id);
      const saved = await updateListing(
        row.id,
        { version: row.version, status: row.status },
        applyPatch(row.pendingVariantId, row.pendingRequestedBy, actor.accountId, selfApproved),
      );
      if (!saved) throw await conflictById(row.id);
      await recordTransition({ ...transition, action: 'approve_mapping', selfApproved, audit: { ...AUDIT, label: row.sellerSku } });
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
      { pendingVariantId: null, pendingMode: null, pendingRequestedBy: null, pendingRequestedAt: null },
    );
    if (!saved) throw await conflictById(row.id);
    await recordTransition({ ...transition, action: 'reject_mapping', reason });
    return toListing(saved);
  });
}
