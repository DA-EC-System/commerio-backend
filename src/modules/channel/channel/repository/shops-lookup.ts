// Đọc tên gian hàng cho module khác (report #29, plan #29 A6). Chạy trong `withCompany` của bên gọi.
import { inArray } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { shops } from './schema.ts';

export async function findShops(ids: readonly string[]) {
  if (ids.length === 0) return [];
  return getDb()
    .select({ id: shops.id, shopName: shops.shopName, platform: shops.platform })
    .from(shops)
    .where(inArray(shops.id, [...ids]));
}
