// Lớp ghi listing (#216 cách A, spec 5.5, Documents/21 §13.2): mọi service ghi listing đi qua đây, không import thẳng
// `repository/listing-writes.ts` (dependency-cruiser `ghi-listing-qua-lop-phat`). Dòng có bộ ba `status`, `stockSync`,
// `priceSync` đổi (hoặc vừa chèn) thì phát `channel.listing_sync_changed` theo giá trị sau, cùng giao dịch, key = gian hàng.
// Không phát: `pending` đè lên `error` hay `pending` (bộ ba giữ), cập nhật không đổi bộ ba (D11), ngắt gian hàng (D12).
// Gọi trong `withCompany` (`publishEvent` ném nếu không).
import { publishEvent } from '../../../core/index.ts';
import type { ListingStatus } from '../domain/listing.ts';
import type { ListingPatch, ListingRow } from '../repository/listings.ts';
import * as writes from '../repository/listing-writes.ts';
import { findListingById } from '../repository/listings.ts';
import { ensureShopProduct } from '../repository/shop-products.ts';
import type { SyncChange, SyncTriple } from '../repository/listing-writes.ts';

const sameTriple = (a: SyncTriple, b: SyncTriple) => a.status === b.status && a.stockSync === b.stockSync && a.priceSync === b.priceSync;

async function publishSync(shopId: string, listingId: string, t: SyncTriple): Promise<void> {
  await publishEvent({
    type: 'channel.listing_sync_changed',
    aggregateId: shopId,
    payload: { shopId, listingId, stockSync: t.stockSync, priceSync: t.priceSync, status: t.status },
  });
}

/** Phát cho dòng có bộ ba đổi, lần lượt theo `listingId`. */
async function publishChanges(changes: readonly SyncChange[]): Promise<void> {
  const changed = changes.filter((c) => !sameTriple(c.before, c.after)).sort((a, b) => (a.listingId < b.listingId ? -1 : a.listingId > b.listingId ? 1 : 0));
  for (const c of changed) await publishSync(c.shopId, c.listingId, c.after);
}

// Listing có mã sản phẩm sàn luôn trỏ dòng `shop_products` cùng mã (#295, CHECK `listings_shop_product`, khoá ngoại ghép):
// bên ghi không truyền `shopProductId` thì lớp này lấy dòng `active` của mã đó, chưa có thì tạo dòng `match`. Xoá mã sàn
// (sàn xoá sản phẩm) thì bỏ luôn liên kết. Đường đẩy gom biến thể truyền thẳng dòng `app` của nó.
export async function insertListing(values: Parameters<typeof writes.insertListing>[0]): Promise<ListingRow> {
  if (values.externalProductId && !values.shopProductId) {
    values = { ...values, shopProductId: await ensureShopProduct(values.companyId, values.shopId, values.externalProductId) };
  }
  const row = await writes.insertListing(values);
  await publishSync(row.shopId, row.id, row);
  return row;
}

/** Sửa theo `version` (và `status` nếu có); không trúng dòng thì `undefined`, không phát. */
export async function updateListing(
  id: string,
  expected: { version: number; status?: ListingStatus },
  patch: ListingPatch,
): Promise<ListingRow | undefined> {
  if (patch.externalProductId === null && patch.shopProductId === undefined) patch = { ...patch, shopProductId: null };
  if (patch.externalProductId && patch.shopProductId === undefined) {
    const current = await findListingById(id);
    if (!current) return undefined;
    patch = { ...patch, shopProductId: await ensureShopProduct(current.companyId, current.shopId, patch.externalProductId) };
  }
  const result = await writes.updateListing(id, expected, patch);
  if (!result) return undefined;
  const { row, before } = result;
  if (!sameTriple(before, row)) await publishSync(row.shopId, row.id, row);
  return row;
}

/** Tồn trên sàn vừa bị đẩy về 0 mà ngắt bị chặn (#207): `stock_sync = pending`, `platform_stock = 0`. */
export async function markStockPendingIds(ids: readonly string[]): Promise<void> {
  await publishChanges(await writes.markStockPendingIds(ids));
}

/** Listing của các biến thể ở các trạng thái cho trước chờ đẩy tồn. Trả id các gian hàng có dòng đã ghi. */
export async function markStockPendingRows(variantIds: readonly string[], statuses: readonly ListingStatus[]): Promise<string[]> {
  const changes = await writes.markStockPendingRows(variantIds, statuses);
  await publishChanges(changes);
  return [...new Set(changes.map((c) => c.shopId))];
}

// Hai hàm của ngắt gian hàng không phát (D12): `channel.shop_status_changed` cùng giao dịch đã làm FE tải lại nhóm `shops`;
// phát thêm hàng trăm sự kiện listing chỉ làm FE gọi lại API hàng trăm lần. Nối lại thì `insertListing` phát mỗi dòng (D13).
export const delistForDisconnect = writes.delistForDisconnect;
export const failPushingForDisconnect = writes.failPushingForDisconnect;
