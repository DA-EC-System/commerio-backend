// Số có thể bán chưa tin được (#223; Documents/21 §18.6.6, 25 E28). Số có thể bán là một con số chung của công ty (một
// kho): gian hàng "đơn chưa cập nhật" (`ordersStale`) có thể đã bán mà app chưa trừ, nên số app của SKU có listing trên
// gian hàng đó chỉ có thể CAO HƠN số thật. Vì vậy không được đẩy TĂNG tồn của SKU đó lên bất kỳ gian hàng nào của công ty;
// đẩy giảm hoặc bằng số sàn vừa đọc thật thì vẫn an toàn và vẫn đi (`raisesStock`, chỉ ở lượt có đọc sàn). Mọi đường đẩy
// tồn hỏi `untrustedVariants` ngay trước khi gọi sàn: `pushDue` (đồng bộ 15 phút và `pushPending`), đối chiếu, đẩy sản phẩm.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { ordersStale } from '../domain/shop.ts';
import { variantsListedOn } from '../repository/listings.ts';
import type { SyncError } from '../repository/schema.ts';
import { listShopRows, type ShopRow } from '../repository/shops.ts';
import { getAdapter, type MarketplaceAdapter } from './marketplaces/index.ts';

/** Sàn kéo đơn được (cùng điều kiện với `pullShopOrders`); sàn không kéo đơn thì không có gì để chờ. */
export function pullsOrders(adapter: MarketplaceAdapter | undefined): boolean {
  return Boolean(adapter?.listOrders && (adapter.getOrder || adapter.getOrders));
}

/** Gian hàng `shop` đang "đơn chưa cập nhật". */
export function shopOrdersStale(shop: ShopRow, now: Date = new Date()): boolean {
  return ordersStale(shop, pullsOrders(getAdapter(shop.platform)), now);
}

/**
 * Biến thể có số có thể bán chưa tin được lúc này, kèm các gian hàng "đơn chưa cập nhật" đang bán nó (để báo lý do).
 * Gọi trong `withCompany`.
 */
export async function untrustedVariants(): Promise<Map<string, ShopRow[]>> {
  requireCompanyId('untrustedVariants');
  const now = new Date();
  const stale = (await listShopRows()).filter((s) => shopOrdersStale(s, now));
  const byId = new Map(stale.map((s) => [s.id, s]));
  const result = new Map<string, ShopRow[]>();
  for (const { variantId, shopId } of await variantsListedOn(stale.map((s) => s.id))) {
    result.set(variantId, [...(result.get(variantId) ?? []), byId.get(shopId)!]);
  }
  return result;
}

/**
 * Lần đẩy `quantity` có làm tồn trên sàn tăng không, so với số sàn ĐỌC THẬT trong lượt (`level`, `RemoteSku.sellableQuantity`).
 * Không có số đọc thật thì coi là tăng: `platform_stock` là số app gửi lần trước, sàn có thể đã bán bớt mà app chưa biết.
 */
export function raisesStock(quantity: number, level: number | null | undefined): boolean {
  return level === null || level === undefined || quantity > level;
}

/** Lý do giữ tồn của listing (`stockSyncError.code = 'orders_stale'`) để FE hiện: tên gian hàng và mốc lấy đơn xong gần nhất. */
export function ordersStaleError(shops: readonly ShopRow[], at: Date): SyncError {
  const names = shops
    .map((s) => {
      const since = s.ordersPulledOkAt ? ` (lấy đơn xong gần nhất ${s.ordersPulledOkAt.toISOString()})` : '';
      return s.status === 'needs_reauth' ? `${s.shopName}: cần kết nối lại${since}` : `${s.shopName}${since}`;
    })
    .join('; ');
  return {
    code: 'orders_stale',
    message: `Đơn của gian hàng chưa cập nhật nên tạm không đẩy tăng tồn (đẩy giảm vẫn chạy). ${names}`,
    at: at.toISOString(),
  };
}
