// Máy trạng thái đơn và các luật suy ra (Documents/21 §19.1, sơ đồ D1), cùng bảng với FE `src/lib/machines/order.ts`.
import { Decimal } from 'decimal.js';
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
  | 'shop_disconnected'
  | 'payment_mismatch';
/** Trạng thái thanh toán của đơn theo sổ tiền của finance (Documents/21 §21.2, #234); không chặn trạng thái đơn. */
export const PAYMENT_STATUSES = ['none', 'pending', 'settled', 'mismatch', 'resolved'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
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

/** Hạn trả khi gian hàng chưa nhập số ngày hay không tìm thấy gian hàng (#236 D5). */
export const DEFAULT_RETURN_WINDOW_DAYS = 7;
export const DUE_SOON_HOURS = 24;
const DAY_MS = 86_400_000;

/** Cách sàn tính hạn trả (`capabilities.returnWindow`) và số ngày của gian hàng. */
export interface ReturnPolicy {
  returnWindow: 'days' | 'platform_status';
  returnWindowDays: number | null;
}

/** Chính sách cho đơn không có gian hàng hay gian hàng không tìm thấy. */
export const DEFAULT_RETURN_POLICY: ReturnPolicy = { returnWindow: 'days', returnWindowDays: null };

/** Mốc giao của kiện giao cuối; null khi chưa kiện nào giao. */
export function lastDeliveredAt(packages: readonly { deliveredAt: Date | null }[]): Date | null {
  let last: Date | null = null;
  for (const p of packages) if (p.deliveredAt && (!last || p.deliveredAt > last)) last = p.deliveredAt;
  return last;
}

/**
 * Hết hạn trả của đơn đang xử lý; null khi chưa kiện nào giao (điều kiện hạn trả không áp).
 * PR 1 #236: sàn `platform_status` tạm tính như `days` 7 ngày (D13); `stored` chưa dùng,
 * PR 2 #236 đọc cột đã lưu cho nhánh `platform_status`.
 */
export function returnWindowEndsAt(policy: ReturnPolicy, lastDelivered: Date | null, stored: Date | null): Date | null {
  void stored;
  if (!lastDelivered) return null;
  const days = policy.returnWindow === 'days' ? (policy.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS) : DEFAULT_RETURN_WINDOW_DAYS;
  return new Date(lastDelivered.getTime() + days * DAY_MS);
}

export interface CodPackage {
  selfDelivery: boolean;
  status: PackageStatus;
  codExpected: string | null;
  codConfirmedAt: Date | null;
}

/** Có kiện tự giao đã giao, thu COD, mà chưa ai xác nhận số thực thu. */
export function codUnconfirmed(packages: readonly CodPackage[]): boolean {
  return packages.some(
    (p) => p.selfDelivery && p.status === 'delivered' && p.codExpected !== null && new Decimal(p.codExpected).gt(0) && !p.codConfirmedAt,
  );
}

export type CompletionBlocker = 'packages_open' | 'return_window' | 'return_requested' | 'cod_unconfirmed';

export interface CompletionInput {
  packages: readonly PackageStatus[];
  lastDeliveredAt: Date | null;
  /** Hạn trả đã tính theo chính sách gian hàng (`returnWindowEndsAt`). */
  returnWindowEndsAt: Date | null;
  openReturnRequests: number;
  /** Kiện tự giao thu COD đã giao mà chưa xác nhận số thực thu. */
  codUnconfirmed: boolean;
  now: number;
}

/** Lý do chưa hoàn tất; null là hoàn tất được. */
export function completionBlocker(i: CompletionInput): CompletionBlocker | null {
  if (!i.packages.length || !i.packages.every(isStopped)) return 'packages_open';
  if (i.lastDeliveredAt && (!i.returnWindowEndsAt || i.returnWindowEndsAt.getTime() > i.now)) return 'return_window';
  if (i.openReturnRequests > 0) return 'return_requested';
  if (i.codUnconfirmed) return 'cod_unconfirmed';
  return null;
}

export type CancelInitiator = 'buyer' | 'seller' | 'platform';
const CANCEL_INITIATOR_ORDER: readonly CancelInitiator[] = ['buyer', 'seller', 'platform'];
/** Lý do cấp đơn khi sàn tự huỷ mà không món nào ghi người, lý do. */
export const PLATFORM_CANCEL_REASON = 'Sàn huỷ đơn';

/**
 * Người đã huỷ món của đơn (Documents/21 §19.1 `cancelInitiators`): mỗi dòng đã huỷ (`cancelledQty > 0`) mang người huỷ
 * do adapter sàn chuẩn hoá; đơn chỉ tổng hợp, không lưu riêng. Không trùng, thứ tự cố định buyer, seller, platform.
 */
export function cancelInitiatorsOf(
  lines: readonly { cancelledQty: number; cancelInitiator: CancelInitiator | null }[],
): CancelInitiator[] {
  const seen = new Set(lines.filter((l) => l.cancelledQty > 0 && l.cancelInitiator).map((l) => l.cancelInitiator));
  return CANCEL_INITIATOR_ORDER.filter((c) => seen.has(c));
}

/**
 * Lý do huỷ cấp đơn khi sàn huỷ cả đơn mà đơn chưa có lý do (Sale huỷ, Sale đồng ý khách xin huỷ đã ghi trước): mọi món
 * đã huỷ cùng một lý do thì lấy lý do đó; không món nào có lý do lẫn người huỷ thì "Sàn huỷ đơn"; nhiều lý do, hay có
 * người huỷ mà không lý do, thì để trống (lý do ở từng dòng). Trả `undefined` khi không ghi.
 */
export function orderCancelReasonFromLines(
  lines: readonly { cancelledQty: number; cancelReason: string | null; cancelInitiator: CancelInitiator | null }[],
): string | undefined {
  const cancelled = lines.filter((l) => l.cancelledQty > 0);
  const reasons = [...new Set(cancelled.map((l) => l.cancelReason?.trim()).filter((r): r is string => !!r))];
  if (reasons.length === 1) return reasons[0];
  if (reasons.length === 0 && !cancelled.some((l) => l.cancelInitiator)) return PLATFORM_CANCEL_REASON;
  return undefined;
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
