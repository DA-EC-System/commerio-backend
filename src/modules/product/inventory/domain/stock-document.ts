// Phiếu kho có duyệt (Documents/21 mục 15.3, sơ đồ B3, #208). Bảng chuyển chép từ FE `src/lib/machines/stockDocument.ts`,
// thêm người duyệt khác người lập kèm ngoại lệ tự duyệt (Documents/25 mục 11): bảng `stock_documents` có `self_approved`.
// Thuần, không I/O.
import { defineMachine } from '../../../core/index.ts';

/** Loại phiếu người dùng lập tay. */
export const MANUAL_DOC_TYPES = ['stocktake', 'write_off', 'to_quarantine'] as const;
export type ManualDocType = (typeof MANUAL_DOC_TYPES)[number];
/** Loại phiếu API trả (phiếu xuất theo kiện làm ở cổng `ship`, chưa có ở API). */
export const DOC_TYPES = [...MANUAL_DOC_TYPES, 'return_inspection'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_STATUSES = ['draft', 'pending', 'posted', 'rejected', 'cancelled'] as const;
export type DocStatus = (typeof DOC_STATUSES)[number];
export const DOC_ACTIONS = ['submit', 'approve', 'reject', 'post', 'cancel'] as const;
export type DocAction = (typeof DOC_ACTIONS)[number];

/** Tiền tố số phiếu (Documents/21 V32, như mock FE). */
export const DOC_PREFIX: Record<DocType, string> = {
  stocktake: 'KK',
  write_off: 'XH',
  to_quarantine: 'CXL',
  return_inspection: 'KHV',
};

export interface DocRecord {
  /** Người mà bước duyệt phải khác: người lập; kiểm hàng về là người quét (người gửi duyệt). */
  createdBy: string | null;
  lineCount: number;
  /** Kiểm hàng về: tổng (dự kiến − quét) của các dòng còn thiếu. */
  missing: number;
}

const MANAGE = 'inventory.receipt.create';
const APPROVE = 'inventory.document.approve';

/** Kiểm kê, xuất huỷ, chuyển chờ xử lý: kho lập, người có quyền duyệt (CEO) duyệt, khác người lập. */
export const adjustmentMachine = defineMachine<DocStatus, DocAction, DocRecord>([
  {
    from: 'draft',
    to: 'pending',
    action: 'submit',
    label: 'Gửi duyệt',
    permission: MANAGE,
    guard: (r) => (r.lineCount ? null : 'empty_document'),
  },
  {
    from: 'pending',
    to: 'posted',
    action: 'approve',
    label: 'Duyệt và ghi sổ',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'pending',
    to: 'rejected',
    action: 'reject',
    label: 'Từ chối',
    permission: APPROVE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
  { from: 'draft', to: 'cancelled', action: 'cancel', label: 'Huỷ phiếu', permission: MANAGE },
]);

/**
 * Kiểm hàng về: không thiếu thì ghi sổ thẳng bằng quyền nhận hàng (không cần CEO, §15.3); có thiếu thì người thứ hai
 * duyệt (khác người quét). Bị trả về thì kho kiểm lại trên chính phiếu.
 */
export const inspectionMachine = defineMachine<DocStatus, DocAction, DocRecord>([
  {
    from: 'draft',
    to: 'posted',
    action: 'post',
    label: 'Ghi sổ',
    permission: MANAGE,
    guard: (r) => (r.missing > 0 ? 'shortage_needs_review' : null),
  },
  {
    from: 'draft',
    to: 'pending',
    action: 'submit',
    label: 'Gửi duyệt phần thiếu',
    permission: MANAGE,
    guard: (r) => (r.missing > 0 ? null : 'no_shortage'),
  },
  {
    from: 'pending',
    to: 'posted',
    action: 'approve',
    label: 'Duyệt và ghi sổ',
    permission: MANAGE,
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'pending',
    to: 'draft',
    action: 'reject',
    label: 'Yêu cầu kiểm lại',
    permission: MANAGE,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
]);

export const machineOf = (type: DocType) => (type === 'return_inspection' ? inspectionMachine : adjustmentMachine);

export interface InspectionCounts {
  expected: number;
  scanned: number;
}

/** Phần thiếu của phiếu kiểm hàng về: dòng dự kiến mà quét ít hơn. */
export function missingOf(lines: readonly InspectionCounts[]): number {
  return lines.reduce((s, l) => s + Math.max(0, l.expected - l.scanned), 0);
}

/** Số giảm ở ngăn nguồn của một dòng phiếu giảm: kiểm kê lấy phần đếm thiếu, phiếu khác lấy số lượng. */
export function decreaseOf(type: ManualDocType, line: { quantity: number | null; bookQty: number | null; countedQty: number | null }): number {
  if (type === 'stocktake') return Math.max(0, (line.bookQty ?? 0) - (line.countedQty ?? 0));
  return line.quantity ?? 0;
}

/** Xuất huỷ hàng chờ xử lý bị từ chối: kho phải chọn nhập lại tồn hoặc trả NCC (§15.3). */
export function needsDecision(doc: { kind: string; area: string; status: string; rejectDecision: string | null }): boolean {
  return doc.kind === 'write_off' && doc.area === 'quarantine' && doc.status === 'rejected' && doc.rejectDecision === null;
}
