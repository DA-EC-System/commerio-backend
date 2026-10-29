// Bảng chuyển của phiếu nhận (Documents/21 mục 16.3, sơ đồ A2). Chép từ FE `src/lib/machines/purchasing.ts`, thêm
// `allowSelfApproval` cho hai bước ghi sổ (bảng `goods_receipts` có cột `self_approved`, spec #109 Q1) và bước `resolve`
// (ghi kết quả giao thiếu bằng tay, FE dùng route riêng `/short-resolution`, spec #109 Q7).
import { defineMachine } from '../../../core/index.ts';

export const GOODS_RECEIPT_STATUSES = ['counting', 'matched', 'short', 'resolved', 'cancelled'] as const;
export type GoodsReceiptStatus = (typeof GOODS_RECEIPT_STATUSES)[number];

/** Thao tác người dùng gọi qua `POST /goods-receipts/:id/:action`. */
export const RECEIPT_USER_ACTIONS = ['post', 'post_short', 'cancel'] as const;
export type GoodsReceiptAction = (typeof RECEIPT_USER_ACTIONS)[number] | 'resolve' | 'auto_resolve';

export interface GoodsReceiptRecord {
  /** Người lập đề nghị: người ghi sổ phải khác. */
  createdBy: string | null;
  /** Tổng thiếu của phiếu. */
  short: number;
}

const RECEIPT = 'purchasing.receipt.manage';

export const goodsReceiptMachine = defineMachine<GoodsReceiptStatus, GoodsReceiptAction, GoodsReceiptRecord>([
  {
    from: 'counting',
    to: 'matched',
    action: 'post',
    label: 'Ghi sổ',
    permission: RECEIPT,
    needsSecondPerson: true,
    allowSelfApproval: true,
    guard: (r) => (r.short > 0 ? 'has_shortage' : null),
  },
  {
    from: 'counting',
    to: 'short',
    action: 'post_short',
    label: 'Ghi sổ, báo giao thiếu',
    permission: RECEIPT,
    needsSecondPerson: true,
    allowSelfApproval: true,
    guard: (r) => (r.short > 0 ? null : 'no_shortage'),
  },
  { from: 'counting', to: 'cancelled', action: 'cancel', label: 'Huỷ phiếu', permission: RECEIPT, needsReason: true },
  { from: 'short', to: 'resolved', action: 'resolve', label: 'Ghi kết quả', permission: 'purchasing.request.manage' },
  // Đề nghị nhận đủ hoặc bị đóng thiếu
  { from: 'short', to: 'resolved', action: 'auto_resolve', label: 'Đã xử lý', system: true },
]);
