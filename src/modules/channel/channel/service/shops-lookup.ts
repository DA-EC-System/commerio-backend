// Hàm cho module khác (report #29, plan #29 A6). Gọi trong `withCompany` của bên gọi.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import type { ShopCapabilities } from '../domain/shop.ts';
import { findShopReturnSettings, findShops } from '../repository/shops-lookup.ts';
import { capabilitiesOf } from './marketplaces/index.ts';

export interface ShopRef {
  id: string;
  shopName: string;
  platform: string;
  externalShopId: string;
}

/** Tên, sàn của các gian hàng theo id, kể cả gian hàng đã ngắt; id không thấy (công ty khác, đã xoá) vắng mặt. */
export async function getShops(ids: readonly string[]): Promise<Map<string, ShopRef>> {
  requireCompanyId('getShops');
  return new Map((await findShops(ids)).map((s) => [s.id, s]));
}

/** Hạn trả của gian hàng cho sales (#236): cách sàn tính và số ngày đã lưu. */
export interface ShopReturnPolicy {
  returnWindow: ShopCapabilities['returnWindow'];
  returnWindowDays: number | null;
}

/** Chính sách hạn trả theo id gian hàng, kể cả gian hàng đã ngắt; id không thấy (công ty khác, đã xoá) vắng mặt. */
export async function returnPoliciesOf(ids: readonly string[]): Promise<Map<string, ShopReturnPolicy>> {
  requireCompanyId('returnPoliciesOf');
  return new Map(
    (await findShopReturnSettings(ids)).map((s) => [
      s.id,
      { returnWindow: capabilitiesOf(s.platform).returnWindow, returnWindowDays: s.returnWindowDays },
    ]),
  );
}
