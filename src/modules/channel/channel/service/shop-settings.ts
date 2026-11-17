// Sửa thuộc tính gian hàng sau thiết lập: `PATCH /channel/shops/:id` (Documents/21 §18.4, commerio-backend#362).
import { recordAudit } from '../../../core/index.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { lockShopRow, updateShop } from '../repository/shops.ts';
import { capabilitiesOf } from './marketplaces/index.ts';
import { type Actor, type Shop, shopView } from './shops.ts';

/**
 * Dưới khoá dòng gian hàng: 404 → 409 `version_conflict` kèm `current` → 422 sàn không tính hạn theo ngày; ghi nhật ký
 * cùng giao dịch. Không chặn theo trạng thái gian hàng. Gọi trong `withCompany`.
 */
export async function updateShopSettings(actor: Actor, id: string, input: { version: number; returnWindowDays: number }): Promise<Shop> {
  requireCompanyId('updateShopSettings');
  const row = isUuid(id) ? await lockShopRow(id) : undefined;
  if (!row) throw new AppError(404, 'not_found', 'Không tìm thấy gian hàng');
  if (row.version !== input.version) {
    throw new AppError(409, 'version_conflict', `Gian hàng "${row.shopName}" vừa được người khác cập nhật`, { current: await shopView(row) });
  }
  if (capabilitiesOf(row.platform).returnWindow !== 'days') {
    throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', {
      errors: { returnWindowDays: 'Sàn này tính hạn trả theo trạng thái sàn, không nhập số ngày' },
    });
  }
  const updated = (await updateShop(id, { version: row.version }, { returnWindowDays: input.returnWindowDays }))!;
  await recordAudit({
    companyId: actor.companyId,
    actorId: actor.accountId,
    action: 'update',
    entityType: 'channel.shops',
    entityId: id,
    before: { returnWindowDays: row.returnWindowDays },
    after: { returnWindowDays: input.returnWindowDays },
  });
  return shopView(updated);
}
