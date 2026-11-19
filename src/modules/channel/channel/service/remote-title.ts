// CEO xác nhận tên trên sàn đã đổi (#396; Documents/21 §18.3 `acknowledge-title`): mốc tên = tên hiện tại trong bản sao.
import { recordAudit } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { remoteTitleChanged, snapshotBaseline } from '../domain/remote-title.ts';
import { findListingById, updateListing } from '../repository/listings.ts';
import { findRemoteSkuRow } from '../repository/remote-skus.ts';
import { type ChannelListing, requesterNames, toListing } from './listings.ts';
import { type Actor, ownShop } from './shops.ts';

/**
 * Thứ tự kiểm như `outside-change`: gian hàng, listing (404) → `version` (409 `version_conflict` kèm `current`) → có cờ (409
 * `invalid_transition`; listing đang `pushing` cũng vậy; SKU đã rời bản sao tính là không có cờ, không có tên hiện tại để làm mốc). Thành công: mốc = tên
 * hiện tại, xoá cờ, tăng `version`, ghi nhật ký cùng giao dịch.
 */
export async function acknowledgeRemoteTitle(actor: Actor, shopId: string, listingId: string, version: number): Promise<ChannelListing> {
  return withCompany(actor.companyId, async () => {
    const shop = await ownShop(shopId);
    const row = isUuid(listingId) ? await findListingById(listingId) : undefined;
    if (!row || row.shopId !== shop.id) throw new AppError(404, 'not_found', 'Không có listing này trên gian hàng');
    const conflict = async () => {
      const fresh = await findListingById(row.id);
      return new AppError(409, 'version_conflict', 'Listing vừa được người khác cập nhật', {
        current: fresh ? toListing(fresh, await requesterNames([fresh])) : null,
      });
    };
    if (row.version !== version) throw await conflict();
    // Đang đẩy: tăng `version` làm việc đẩy bỏ kết quả, listing kẹt `pushing` (review diff #396).
    if (row.status === 'pushing') throw new AppError(409, 'invalid_transition', 'Listing đang đẩy lên sàn, xác nhận tên sau', { current: toListing(row) });
    const remote = row.externalSkuId ? await findRemoteSkuRow(shop.id, row.externalSkuId) : undefined;
    const changed = remoteTitleChanged(row, remote);
    if (!changed) throw new AppError(409, 'invalid_transition', 'Tên trên sàn không đổi so với lúc ghép', { current: toListing(row) });
    const updated = await updateListing(row.id, { version }, snapshotBaseline(remote));
    if (!updated) throw await conflict();
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'channel.listings',
      entityId: row.id,
      // Nhãn như các dòng nhật ký listing khác (#352): SKU người bán, thiếu thì mã SKU sàn.
      label: row.sellerSku ?? row.externalSkuId ?? 'Listing chưa có SKU',
      before: { remoteTitleAtMatch: changed.from, remoteTitleEnAtMatch: changed.fromEn },
      after: { remoteTitleAtMatch: changed.to, remoteTitleEnAtMatch: changed.toEn },
    });
    return toListing(updated, await requesterNames([updated]));
  });
}
