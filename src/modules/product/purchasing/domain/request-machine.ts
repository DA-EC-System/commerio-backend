// Bảng chuyển của đề nghị nhập (Documents/21 mục 16.3, sơ đồ A1). Chép từ FE `src/lib/machines/purchasing.ts`, thêm
// `allowSelfApproval` cho ba bước của CEO: bảng `purchase_requests` có cột `self_approved` (Documents/25 §11).
import { defineMachine } from '../../../core/index.ts';

export const PURCHASE_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'changes_requested',
  'rejected',
  'approved',
  'ordered',
  'partially_received',
  'received',
  'closed_short',
  'cancelled',
] as const;
export type PurchaseRequestStatus = (typeof PURCHASE_REQUEST_STATUSES)[number];

/** Thao tác người dùng gọi qua `POST /requests/:id/:action`; `receive_partial`, `receive_all` chỉ hệ thống làm (#109). */
export const REQUEST_USER_ACTIONS = [
  'submit',
  'withdraw',
  'resubmit',
  'approve',
  'request_changes',
  'reject',
  'order',
  'close_short',
  'cancel',
] as const;
export type PurchaseRequestAction = (typeof REQUEST_USER_ACTIONS)[number] | 'receive_partial' | 'receive_all';

export interface PurchaseRequestRecord {
  createdBy: string | null;
  /** Dòng chưa bị loại. */
  lineCount: number;
  activeLines: number;
  /** Phiếu nhận chưa huỷ. */
  receiptCount: number;
  countingReceipts: number;
}

const MANAGE = 'purchasing.request.manage';
const APPROVE = 'purchasing.request.approve';
const notEmpty = (r: PurchaseRequestRecord) => (r.lineCount ? null : 'empty_document');

export const purchaseRequestMachine = defineMachine<PurchaseRequestStatus, PurchaseRequestAction, PurchaseRequestRecord>([
  { from: 'draft', to: 'pending_approval', action: 'submit', label: 'Gửi duyệt', permission: MANAGE, guard: notEmpty },
  { from: 'pending_approval', to: 'draft', action: 'withdraw', label: 'Rút lại', permission: MANAGE },
  { from: 'changes_requested', to: 'pending_approval', action: 'resubmit', label: 'Gửi lại', permission: MANAGE, guard: notEmpty },
  {
    from: 'pending_approval',
    to: 'approved',
    action: 'approve',
    label: 'Duyệt',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    guard: (r) => (r.activeLines ? null : 'all_lines_excluded'),
  },
  {
    from: 'pending_approval',
    to: 'changes_requested',
    action: 'request_changes',
    label: 'Trả về',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
  {
    from: 'pending_approval',
    to: 'rejected',
    action: 'reject',
    label: 'Từ chối',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
  { from: 'approved', to: 'ordered', action: 'order', label: 'Đã đặt NCC', permission: MANAGE },
  { from: ['ordered', 'partially_received'], to: 'partially_received', action: 'receive_partial', label: 'Nhận một phần', system: true },
  { from: ['ordered', 'partially_received'], to: 'received', action: 'receive_all', label: 'Nhận xong', system: true },
  {
    from: ['ordered', 'partially_received'],
    to: 'closed_short',
    action: 'close_short',
    label: 'Đóng thiếu',
    permission: APPROVE,
    needsReason: true,
    guard: (r) => (r.countingReceipts ? 'receipt_counting' : null),
  },
  {
    from: ['draft', 'changes_requested', 'pending_approval'],
    to: 'cancelled',
    action: 'cancel',
    label: 'Huỷ đề nghị',
    permission: MANAGE,
  },
  {
    // Đã duyệt, đã đặt: chỉ CEO huỷ, kèm lý do; có phiếu nhận (chưa huỷ) thì không huỷ được.
    from: ['approved', 'ordered'],
    to: 'cancelled',
    action: 'cancel',
    label: 'Huỷ đề nghị',
    permission: APPROVE,
    needsReason: true,
    guard: (r) => (r.receiptCount ? 'has_receipts' : null),
  },
]);
