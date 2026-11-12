// Số có thể bán chưa tin được (#223; Documents/21 §18.6.6, 25 E28). Số có thể bán là một con số chung của công ty (một
// kho): gian hàng "đơn chưa cập nhật" (`ordersStale`) có thể đã bán mà app chưa trừ, nên SKU có listing trên gian hàng đó
// không được cập nhật tồn lên BẤT KỲ gian hàng nào của công ty. Mọi đường đẩy tồn hỏi `untrustedVariants` ngay trước khi
// gọi sàn: `pushDue`, đối chiếu tồn, đẩy sản phẩm mới, đẩy lại Lazada.
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { ordersStale } from '../domain/shop.ts';
import { variantIdsListedOn } from '../repository/listings.ts';
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

/** Biến thể không được cập nhật tồn lên sàn lúc này (mọi gian hàng của công ty). Gọi trong `withCompany`. */
export async function untrustedVariants(): Promise<Set<string>> {
  requireCompanyId('untrustedVariants');
  const now = new Date();
  const stale = (await listShopRows()).filter((s) => shopOrdersStale(s, now));
  return new Set(await variantIdsListedOn(stale.map((s) => s.id)));
}
