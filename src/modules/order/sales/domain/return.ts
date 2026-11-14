// Máy trạng thái yêu cầu trả và các luật thuần (Documents/21 §20, 25 §9), cùng bảng FE `src/lib/machines/returns.ts`.
import { Decimal } from 'decimal.js';
import { defineMachine } from '../../../core/index.ts';

export type ReturnStatus = 'requested' | 'rejected' | 'refund_only' | 'awaiting_return' | 'received' | 'closed';
export type ReturnAction =
  | 'accept'
  | 'reject'
  | 'refund_only'
  | 'platform_reopen'
  | 'platform_refund'
  | 'receive'
  | 'no_show'
  | 'close'
  | 'buyer_cancel';
export type ReturnCloseResult = 'inspected' | 'no_show' | 'buyer_cancelled';

export const RETURN_STATUSES = ['requested', 'rejected', 'refund_only', 'awaiting_return', 'received', 'closed'] as const;
/** Yêu cầu còn mở (§19.1, §20): `refund_only`, `rejected`, `closed` không chặn hoàn tất đơn. */
export const OPEN_RETURN_STATUSES = ['requested', 'awaiting_return', 'received'] as const satisfies readonly ReturnStatus[];

export interface ReturnRecord {
  source: 'marketplace' | 'inbox' | 'manual';
  /** Thiếu là `return`. */
  kind?: 'return' | 'refund';
}

const marketplaceOnly = (r: ReturnRecord) => (r.source === 'marketplace' ? null : 'not_marketplace');
/** Yêu cầu chỉ hoàn tiền không có hàng gửi trả nên không có bước đồng ý trả hàng. */
const returnsGoods = (r: ReturnRecord) => (r.kind === 'refund' ? 'refund_only_request' : null);

/** Bảng §20. Actor null là sàn hay hệ thống: làm được mọi bước, kể cả bước người làm (sàn chấp nhận thay người bán). */
export const returnMachine = defineMachine<ReturnStatus, ReturnAction, ReturnRecord>([
  { from: 'requested', to: 'awaiting_return', action: 'accept', permission: 'sales.return.process', guard: returnsGoods },
  { from: 'requested', to: 'rejected', action: 'reject', permission: 'sales.return.process', needsReason: true },
  { from: 'requested', to: 'refund_only', action: 'refund_only', permission: 'sales.return.process' },
  { from: 'rejected', to: 'awaiting_return', action: 'platform_reopen', permission: 'sales.return.process', guard: marketplaceOnly },
  { from: 'rejected', to: 'refund_only', action: 'platform_refund', permission: 'sales.return.process', guard: marketplaceOnly },
  { from: 'awaiting_return', to: 'received', action: 'receive', permission: 'fulfillment.order.process' },
  { from: 'awaiting_return', to: 'closed', action: 'no_show', permission: 'sales.return.process', needsReason: true },
  { from: 'received', to: 'closed', action: 'close', system: true },
  { from: ['requested', 'awaiting_return'], to: 'closed', action: 'buyer_cancel', system: true },
]);

/** Kết quả đóng theo thao tác đưa yêu cầu vào `closed`. */
export const CLOSE_RESULT: Partial<Record<ReturnAction, ReturnCloseResult>> = {
  close: 'inspected',
  no_show: 'no_show',
  buyer_cancel: 'buyer_cancelled',
};

/** Thao tác đổi tiền hoàn cho khách (§11.2 `sales.return_refunded`): chỉ hoàn tiền, hoặc đóng sau kiểm hàng hoàn. */
export const REFUNDING_ACTIONS: readonly ReturnAction[] = ['refund_only', 'platform_refund', 'close'];

/**
 * Bước máy trạng thái ứng với trạng thái sàn báo (25 §9). null: không đổi (trùng, hoặc `received` chờ kho quét).
 * `'conflict'`: sàn tới trạng thái app không có mũi tên tới (vd đã `closed` mà sàn mở lại), bật cờ Cần xử lý.
 */
export function syncAction(current: ReturnStatus, target: ReturnStatus): ReturnAction | null | 'conflict' {
  if (current === target) return null;
  // Sàn báo hàng đã về người bán: app chờ kho quét (`receive` chỉ qua quét nhận, §20). Chưa đồng ý thì sàn đã đồng ý
  // thay người bán: đi tới `awaiting_return` (`syncTarget`) bằng bước hệ thống, không gọi lại sàn.
  if (target === 'received') {
    if (current === 'requested') return 'accept';
    if (current === 'rejected') return 'platform_reopen';
    return current === 'awaiting_return' || current === 'closed' ? null : 'conflict';
  }
  const byPair: Partial<Record<`${ReturnStatus}>${ReturnStatus}`, ReturnAction>> = {
    'requested>awaiting_return': 'accept',
    'requested>rejected': 'reject',
    'requested>refund_only': 'refund_only',
    'rejected>awaiting_return': 'platform_reopen',
    'rejected>refund_only': 'platform_refund',
    'requested>closed': 'buyer_cancel',
    'awaiting_return>closed': 'buyer_cancel',
  };
  const action = byPair[`${current}>${target}`];
  if (action) return action;
  // Đã từ chối rồi sàn báo khách huỷ (người bán thắng): giữ `rejected`, như ánh xạ TikTok (#227); không phải mâu thuẫn.
  if (current === 'rejected' && target === 'closed') return null;
  // Đã nhận hàng hay đã đóng, sàn báo hoàn tiền xong: tiền đi theo kiểm hàng hoàn của app, không đổi trạng thái.
  if (target === 'refund_only' && (current === 'received' || current === 'closed')) return null;
  return 'conflict';
}

/** Trạng thái app đi tới khi sàn báo `target`: `received` chỉ tới được bằng quét nên dừng ở `awaiting_return`. */
export const syncTarget = (target: ReturnStatus): ReturnStatus => (target === 'received' ? 'awaiting_return' : target);

/** Giá vốn một món của dòng trả: bình quân gia quyền các dòng kiện đã giao có giá vốn (25 §9); không dòng nào có thì null. */
export function weightedUnitCost(lines: readonly { quantity: number; unitCost: string | null }[]): string | null {
  const costed = lines.filter((l) => l.unitCost !== null && l.quantity > 0);
  const qty = costed.reduce((n, l) => n + l.quantity, 0);
  if (!qty) return null;
  const total = costed.reduce((s, l) => s.plus(new Decimal(l.unitCost!).times(l.quantity)), new Decimal(0));
  return total.dividedBy(qty).toFixed(2, Decimal.ROUND_HALF_UP);
}

/** Tiền hoàn = Σ số trả × đơn giá (§20). */
export function refundAmountOf(lines: readonly { quantity: number; unitPrice: string }[]): string {
  return lines.reduce((s, l) => s.plus(new Decimal(l.unitPrice).times(l.quantity)), new Decimal(0)).toFixed(2);
}

/**
 * Chia số bán lại được theo SKU (từ `inventory.return_inspected`) về các dòng trả theo thứ tự dòng; `resellCost` =
 * Σ min(bán lại, số trả) × giá vốn dòng (§20), bỏ dòng không có giá vốn.
 */
export function distributeResell<L extends { id: string; variantId: string | null; quantity: number; unitCost: string | null }>(
  lines: readonly L[],
  resellable: ReadonlyMap<string, number>,
): { perLine: Map<string, number>; resellCost: string } {
  const left = new Map(resellable);
  const perLine = new Map<string, number>();
  let cost = new Decimal(0);
  for (const l of lines) {
    const take = l.variantId ? Math.min(left.get(l.variantId) ?? 0, l.quantity) : 0;
    if (l.variantId) left.set(l.variantId, (left.get(l.variantId) ?? 0) - take);
    perLine.set(l.id, take);
    if (l.unitCost !== null) cost = cost.plus(new Decimal(l.unitCost).times(take));
  }
  return { perLine, resellCost: cost.toFixed(2) };
}
