// Bảng chuyển của phiếu trả NCC (Documents/21 mục 16.3, sơ đồ B4). Chép từ FE `src/lib/machines/purchasing.ts`, thêm
// người duyệt khác cho duyệt và gửi, trả về (khác người lập), ghi kết quả (khác người gửi), kèm ngoại lệ tự duyệt
// (Documents/25 mục 11, #210). Thuần.
import { defineMachine } from '../../../core/index.ts';

export const SUPPLIER_RETURN_STATUSES = ['draft', 'pending_approval', 'sent', 'refunded', 'replaced', 'returned_to_us', 'cancelled'] as const;
export type SupplierReturnStatus = (typeof SUPPLIER_RETURN_STATUSES)[number];
export const SUPPLIER_RETURN_ACTIONS = [
  'submit',
  'send_back',
  'approve_send',
  'record_refund',
  'record_replaced',
  'record_rejected',
  'cancel',
] as const;
export type SupplierReturnAction = (typeof SUPPLIER_RETURN_ACTIONS)[number];

export interface SupplierReturnRecord {
  /** Người lập (duyệt và gửi, trả về phải khác) hoặc người gửi (ghi kết quả phải khác), bên gọi nạp theo bước. */
  createdBy: string | null;
  lineCount: number;
  hasSupplier: boolean;
}

const MANAGE = 'purchasing.return.manage';
const APPROVE = 'purchasing.request.approve';

export const supplierReturnMachine = defineMachine<SupplierReturnStatus, SupplierReturnAction, SupplierReturnRecord>([
  {
    from: 'draft',
    to: 'pending_approval',
    action: 'submit',
    label: 'Gửi duyệt',
    permission: MANAGE,
    guard: (r) => (!r.lineCount ? 'empty_document' : r.hasSupplier ? null : 'supplier_required'),
  },
  {
    from: 'pending_approval',
    to: 'draft',
    action: 'send_back',
    label: 'Trả về',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
  {
    from: 'pending_approval',
    to: 'sent',
    action: 'approve_send',
    label: 'Duyệt và gửi',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'sent',
    to: 'refunded',
    action: 'record_refund',
    label: 'NCC hoàn tiền',
    permission: MANAGE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'sent',
    to: 'replaced',
    action: 'record_replaced',
    label: 'NCC bù hàng',
    permission: MANAGE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'sent',
    to: 'returned_to_us',
    action: 'record_rejected',
    label: 'NCC không nhận',
    permission: MANAGE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: ['draft', 'pending_approval'],
    to: 'cancelled',
    action: 'cancel',
    label: 'Huỷ phiếu',
    permission: APPROVE,
    needsReason: true,
  },
]);

/** Bước ghi kết quả: người thứ hai so với người gửi, không phải người lập. */
export const isResultAction = (a: SupplierReturnAction) => a === 'record_refund' || a === 'record_replaced' || a === 'record_rejected';
