// Luật suy của thẻ kho (Documents/21 §15.2; spec #206 phần 2a mục 5.2): nhóm chứng từ để FE gắn nhãn, tên ngăn ở API.
// Không lưu: suy từ loại chứng từ lúc đọc.

/** Loại phiếu kho, cùng enum `product.stock_document_kind`. */
export type StockDocumentKind =
  | 'stocktake'
  | 'write_off'
  | 'to_quarantine'
  | 'return_inspection'
  | 'shipment'
  | 'shipment_reversal';

/** Chứng từ gốc của một dòng thẻ kho; phiếu kho kèm các cột quyết định nhóm. */
export type MoveSource =
  | { type: 'goods_receipt' | 'supplier_return' }
  | { type: 'stock_document'; kind: StockDocumentKind; isOpening: boolean; sourceType: string | null };

/** Nhóm chứng từ: người lập tay, mua hàng, đơn hàng, hệ thống tự sinh (FE `StockDocKind`). */
export type DocumentKind = 'manual' | 'purchase' | 'order' | 'auto';

/** Nhóm của chứng từ, xét theo thứ tự bảng 5.2 của spec. */
export function documentKind(source: MoveSource): DocumentKind {
  if (source.type !== 'stock_document') return 'purchase';
  if (source.kind === 'shipment' || source.kind === 'shipment_reversal') return 'order';
  if (source.kind === 'return_inspection' || source.isOpening || source.sourceType !== null) return 'auto';
  return 'manual';
}

/** Ngăn ở API: DB gọi tồn thực là `on_hand`, FE gọi là `stock` (`StockArea`). */
export function areaOf(bucket: 'on_hand' | 'quarantine'): 'stock' | 'quarantine' {
  return bucket === 'on_hand' ? 'stock' : 'quarantine';
}
