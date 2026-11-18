// Sửa thuộc tính gian hàng sau thiết lập: `PATCH /channel/shops/:id` (Documents/21 §18.4, commerio-backend#362).
import { recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { updateShop } from '../repository/shops.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import { type Actor, lockShopOr404, type Shop, shopView, versionConflict } from './shops.ts';

/** Dưới khoá dòng: 404 → 409 → 422 sàn không tính hạn theo ngày; mọi trạng thái; nhật ký cùng giao dịch. Gọi trong `withCompany`. */
export async function updateShopSettings(actor: Actor, id: string, input: { version: number; returnWindowDays: number }): Promise<Shop> {
  requireCompanyId('updateShopSettings');
  const row = await lockShopOr404(id);
  if (row.version !== input.version) throw await versionConflict(row);
  if (capabilitiesOf(row.platform).returnWindow !== 'days') {
    throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
      errors: { returnWindowDays: 'Sàn này tính hạn trả theo trạng thái sàn, không nhập số ngày' },
    });
  }
  // Đã khoá dòng và khớp version ở trên nên cập nhật luôn có dòng.
  const updated = (await updateShop(id, { version: row.version }, { returnWindowDays: input.returnWindowDays }))!;
  await recordAudit({
    companyId: actor.companyId,
    actorId: actor.accountId,
    action: 'update',
    entityType: 'channel.shops',
    entityId: id,
    label: row.shopName,
    before: { returnWindowDays: row.returnWindowDays },
    after: { returnWindowDays: input.returnWindowDays },
  });
  return shopView(updated);
}
