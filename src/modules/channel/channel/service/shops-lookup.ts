// Hàm cho module khác (report #29, plan #29 A6). Gọi trong `withCompany` của bên gọi.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { findShops } from '../repository/shops-lookup.ts';

export interface ShopRef {
  id: string;
  shopName: string;
  platform: string;
}

/** Tên, sàn của các gian hàng theo id, kể cả gian hàng đã ngắt; id không thấy (công ty khác, đã xoá) vắng mặt. */
export async function getShops(ids: readonly string[]): Promise<Map<string, ShopRef>> {
  requireCompanyId('getShops');
  return new Map((await findShops(ids)).map((s) => [s.id, s]));
}
