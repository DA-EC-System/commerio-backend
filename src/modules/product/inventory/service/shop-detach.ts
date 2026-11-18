// Phiếu kho của gian hàng bị xoá (#398, chờ Bình duyệt): channel gọi trong giao dịch xoá, `withCompany` của nó.
import { deleteDocuments, detachDocuments, lockShopDocuments, type ShopDocumentRefs } from '../repository/documents.ts';

export interface ShopDocumentScope extends ShopDocumentRefs {
  /** Tên gian hàng lúc xoá, ghi vào ghi chú phiếu giữ lại. */
  shopName: string;
}

/**
 * Phiếu nháp, chờ duyệt của gian hàng thì xoá (cả dòng). Phiếu đã ghi sổ, từ chối, huỷ thì giữ để tồn thực khớp hàng
 * trong kho: `shop_id` null, thêm ghi chú "Gian hàng <tên> đã xoá"; `source_id`, `order_id` trỏ tới chứng từ đã xoá vẫn
 * giữ. Không đụng `stock_levels`, `stock_moves`.
 */
export async function detachShopStockDocuments(scope: ShopDocumentScope): Promise<{ deleted: number; detached: number }> {
  const docs = await lockShopDocuments(scope);
  const open = docs.filter((d) => d.status === 'draft' || d.status === 'pending').map((d) => d.id);
  const kept = docs.filter((d) => d.status !== 'draft' && d.status !== 'pending').map((d) => d.id);
  const deleted = await deleteDocuments(open);
  const detached = await detachDocuments(kept, `Gian hàng ${scope.shopName} đã xoá`);
  return { deleted, detached };
}
