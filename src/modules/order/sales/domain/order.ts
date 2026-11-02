// Máy trạng thái đơn và các luật suy ra (Documents/21 §19.1, sơ đồ D1), cùng bảng với FE `src/lib/machines/order.ts`.
import { defineMachine } from '../../../core/index.ts';
import { isHandedOver, isSealed, isStopped, holdsStock, type PackageStatus } from '../../fulfillment/index.ts';

export type OrderStatus = 'unpaid' | 'processing' | 'completed' | 'cancelled';
export type OrderAction = 'confirm' | 'pay' | 'complete' | 'cancel' | 'platform_cancel' | 'cancel_on_platform';
export type OrderSource = 'marketplace' | 'inbox' | 'manual';
export type PaymentMethod = 'prepaid' | 'cod';
export type OrderOutcome = 'full' | 'partial' | 'none';
export type OrderFlag =
  | 'needs_attention'
  | 'unmapped_sku'
  | 'cancel_requested'
  | 'cancelling'
  | 'platform_cancelled'
  | 'due_soon'
  | 'return_requested'
  | 'cod_mismatch'
  | 'shop_disconnected';
export type OrderStage =
  | 'awaiting_payment'
  | 'awaiting_confirmation'
  | 'unmapped'
  | 'cancelling'
  | 'awaiting_completion'
  | 'completed'
  | 'cancelled'
  | Exclude<PackageStatus, 'cancelled'>;

export interface OrderRecord {
  source: OrderSource;
  paymentMethod: PaymentMethod | null;
  packages: readonly PackageStatus[];
}

const cancelGuard = (r: OrderRecord) =>
  r.source === 'marketplace' ? 'not_allowed_for_source' : r.packages.some(isHandedOver) ? 'already_handed_over' : null;

export const orderMachine = defineMachine<OrderStatus, OrderAction, OrderRecord>([
  {
    from: 'unpaid',
    to: 'processing',
    action: 'confirm',
    permission: 'sales.order.create',
    guard: (r) => (r.source === 'marketplace' ? 'not_allowed_for_source' : r.paymentMethod !== 'cod' ? 'payment_required' : null),
  },
  { from: 'unpaid', to: 'processing', action: 'pay', system: true },
  { from: 'processing', to: 'completed', action: 'complete', system: true },
  { from: ['unpaid', 'processing'], to: 'cancelled', action: 'cancel', permission: 'sales.order.cancel', needsReason: true, guard: cancelGuard },
  { from: ['unpaid', 'processing'], to: 'cancelled', action: 'platform_cancel', system: true },
  {
    from: ['unpaid', 'processing'],
    to: 'cancelled',
    action: 'cancel_on_platform',
    permission: 'sales.order.cancel',
    guard: (r) =>
      r.source !== 'marketplace' ? 'not_allowed_for_source' : r.packages.some(isHandedOver) ? 'already_handed_over' : null,
  },
]);

/** Huỷ ngay, hay còn kiện đã đóng gói phải mở trước (cờ Đang huỷ). */
export function cancelPlan(packages: readonly PackageStatus[]): 'now' | 'after_open' {
  return packages.some(isSealed) ? 'after_open' : 'now';
}

export const RETURN_WINDOW_DAYS = 7;
export const DUE_SOON_HOURS = 24;

export interface CompletionInput {
  packages: readonly PackageStatus[];
  lastDeliveredAt: string | null;
  openReturnRequests: number;
  /** Đơn COD của người bán đã giao mà kế toán chưa xác nhận tiền. */
  codUnconfirmed: boolean;
  now: number;
}

/** Lý do chưa hoàn tất; null là hoàn tất được. */
export function completionBlocker(i: CompletionInput): string | null {
  if (!i.packages.length || !i.packages.every(isStopped)) return 'packages_open';
  if (i.lastDeliveredAt && Date.parse(i.lastDeliveredAt) + RETURN_WINDOW_DAYS * 24 * 3600_000 > i.now) return 'return_window';
  if (i.openReturnRequests > 0) return 'return_requested';
  if (i.codUnconfirmed) return 'cod_unconfirmed';
  return null;
}

/** Kết quả khi hoàn tất, tính trên kiện chưa huỷ. */
export function outcomeOf(packages: readonly PackageStatus[]): OrderOutcome {
  const live = packages.filter((s) => s !== 'cancelled');
  const delivered = live.filter((s) => s === 'delivered').length;
  if (!delivered) return 'none';
  return delivered === live.length ? 'full' : 'partial';
}

const PROGRESS: Partial<Record<PackageStatus, number>> = {
  backordered: 0,
  reserved: 1,
  packed: 2,
  awaiting_pickup: 3,
  in_transit: 4,
  self_delivering: 4,
  delivered: 5,
  returned: 5,
};

const ERROR_FIRST: readonly PackageStatus[] = ['lost', 'delivery_failed', 'returning'];

export interface StageInput {
  status: OrderStatus;
  source: OrderSource;
  paymentMethod: PaymentMethod | null;
  flags: readonly OrderFlag[];
  packages: readonly PackageStatus[];
}

/** Giai đoạn hiển thị: nhánh lỗi trước, rồi kiện chậm nhất. */
export function stageOf(o: StageInput): OrderStage {
  if (o.status === 'cancelled' || o.status === 'completed') return o.status;
  if (o.flags.includes('unmapped_sku')) return 'unmapped';
  if (o.status === 'unpaid') return o.source !== 'marketplace' && o.paymentMethod === 'cod' ? 'awaiting_confirmation' : 'awaiting_payment';
  if (o.flags.includes('cancelling')) return 'cancelling';
  const live: PackageStatus[] = o.packages.filter((s) => s !== 'cancelled');
  for (const s of ERROR_FIRST) if (live.includes(s)) return s as OrderStage;
  if (!live.length || live.every(isStopped)) return 'awaiting_completion';
  return live.filter((s) => !isStopped(s)).reduce((a, b) => ((PROGRESS[b] ?? 9) < (PROGRESS[a] ?? 9) ? b : a)) as OrderStage;
}

/** Sắp trễ hạn: còn kiện chưa rời kho và dưới 24 giờ tới hạn bàn giao. */
export function isDueSoon(shipBy: string | null, packages: readonly PackageStatus[], now: number): boolean {
  if (!shipBy) return false;
  const waiting = packages.some((s) => s === 'backordered' || holdsStock(s));
  return waiting && Date.parse(shipBy) - now < DUE_SOON_HOURS * 3600_000;
}
