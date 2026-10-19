// Hàm cho module khác (report #29, plan #29 A6). Gọi trong `withCompany` của bên gọi.
import { currentCompanyId } from '../../../shared/db/client.ts';
import { findShops } from '../repository/shops-lookup.ts';

export interface ShopRef {
  id: string;
  shopName: string;
  platform: string;
}

/** Tên, sàn của các gian hàng theo id, kể cả gian hàng đã ngắt; id không thấy (công ty khác, đã xoá) vắng mặt. */
export async function getShops(ids: readonly string[]): Promise<Map<string, ShopRef>> {
  if (!currentCompanyId()) throw new Error('getShops phải gọi trong withCompany: số liệu thuộc một công ty');
  return new Map((await findShops(ids)).map((s) => [s.id, s]));
}
