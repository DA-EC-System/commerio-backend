// Phiếu kho của gian hàng bị xoá (#398, chờ Bình duyệt): channel gọi trong giao dịch xoá, `withCompany` của nó.
import { AppError } from '../../../../shared/errors/app-error.ts';
import { deleteDocuments, detachDocuments, documentsWithMoves, lockShopDocuments, type ShopDocumentRefs } from '../repository/documents.ts';

export interface ShopDocumentScope extends ShopDocumentRefs {
  /** Tên gian hàng lúc xoá, ghi vào ghi chú phiếu giữ lại. */
  shopName: string;
}

/**
 * Phiếu nháp, chờ duyệt của gian hàng thì xoá (cả dòng). Phiếu đã ghi sổ, từ chối, huỷ thì giữ để tồn thực khớp hàng
 * trong kho: `shop_id` null, thêm ghi chú "Gian hàng <tên> đã xoá"; `source_id`, `order_id` trỏ tới chứng từ đã xoá vẫn
 * giữ. Không đụng `stock_levels`, `stock_moves`.
 *
 * Phiếu nháp, chờ duyệt mà đã có thẻ kho trỏ tới (phiếu kiểm hàng hoàn: `receiveBack` cộng chờ xử lý theo số quét ngay
 * lúc nhận) thì không xoá được: thẻ kho chỉ thêm, xoá phiếu để lại dòng thẻ kho trỏ chứng từ không còn (API thẻ kho 500)
 * và số chờ xử lý không còn phiếu để chia. Ném 409 `shop_has_open_inspection` kèm `documents`; kho ghi sổ phiếu rồi xoá lại.
 */
export async function detachShopStockDocuments(scope: ShopDocumentScope): Promise<{ deleted: number; detached: number }> {
  const docs = await lockShopDocuments(scope);
  const openDocs = docs.filter((d) => d.status === 'draft' || d.status === 'pending');
  const moved = await documentsWithMoves(openDocs.map((d) => d.id));
  if (moved.size) {
    throw new AppError(409, 'shop_has_open_inspection', 'Gian hàng còn phiếu kiểm hàng hoàn chưa ghi sổ, ghi sổ xong mới xoá được', {
      documents: openDocs.filter((d) => moved.has(d.id)).map((d) => ({ id: d.id, number: d.number })),
    });
  }
  const open = openDocs.map((d) => d.id);
  const kept = docs.filter((d) => d.status !== 'draft' && d.status !== 'pending').map((d) => d.id);
  const deleted = await deleteDocuments(open);
  const detached = await detachDocuments(kept, `Gian hàng ${scope.shopName} đã xoá`);
  return { deleted, detached };
}
