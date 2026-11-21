// Máy trạng thái đơn và các luật suy ra (Documents/21 §19.1, sơ đồ D1), cùng bảng với FE `src/lib/machines/order.ts`.
import { Decimal } from 'decimal.js';
import { defineMachine } from '../../../core/index.ts';
import { isHandedOver, isSealed, isStopped, PRE_HANDOVER, type PackageStatus } from '../../fulfillment/index.ts';

export type OrderStatus = 'unpaid' | 'processing' | 'completed' | 'cancelled';
export type OrderAction = 'confirm' | 'pay' | 'complete' | 'cancel' | 'platform_cancel' | 'cancel_on_platform' | 'auto_cancel';
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
  | 'overdue'
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

/** Đơn có kiện và mọi kiện đã huỷ (như FE `allCancelled`). */
export const allCancelled = (packages: readonly PackageStatus[]): boolean =>
  packages.length > 0 && packages.every((s) => s === 'cancelled');

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
  {
    from: 'processing',
    to: 'completed',
    action: 'complete',
    system: true,
    guard: (r) => (allCancelled(r.packages) ? 'all_packages_cancelled' : null),
  },
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
  // Mọi kiện đã huỷ, đơn không phải đơn sàn: hệ thống huỷ đơn (25 §8.2, #236 D2). Đơn sàn đi `platform_cancel`.
  {
    from: 'processing',
    to: 'cancelled',
    action: 'auto_cancel',
    system: true,
    guard: (r) => (allCancelled(r.packages) ? null : 'packages_not_cancelled'),
  },
]);

/** Huỷ ngay, hay còn kiện đã đóng gói phải mở trước (cờ Đang huỷ). */
export function cancelPlan(packages: readonly PackageStatus[]): 'now' | 'after_open' {
  return packages.some(isSealed) ? 'after_open' : 'now';
}

/** Hạn trả khi gian hàng chưa nhập số ngày hay không tìm thấy gian hàng (#236 D5). */
export const DEFAULT_RETURN_WINDOW_DAYS = 7;
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
 * Sàn `days`: mốc giao của kiện giao cuối + số ngày của gian hàng (7 khi chưa nhập).
 * Sàn `platform_status` (TikTok): mốc sàn báo hết quyền trả đã lưu (`stored`, nhận đơn ghi một lần); sàn chưa báo thì
 * null, đơn có kiện đã giao chưa hoàn tất, không có hạn dự phòng theo ngày (#236 D8).
 */
export function returnWindowEndsAt(policy: ReturnPolicy, lastDelivered: Date | null, stored: Date | null): Date | null {
  if (!lastDelivered) return null;
  if (policy.returnWindow === 'platform_status') return stored;
  return new Date(lastDelivered.getTime() + (policy.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS) * DAY_MS);
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

export type CompletionBlocker = 'packages_open' | 'all_packages_cancelled' | 'return_window' | 'return_requested' | 'cod_unconfirmed';

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

/**
 * Lý do chưa hoàn tất; null là hoàn tất được. `all_packages_cancelled`: đơn không bao giờ hoàn tất, việc nền khép đơn
 * khi mọi món đã huỷ (`settleCancelledOrder`, #236 PR 3, D16), như FE.
 */
export function completionBlocker(i: CompletionInput): CompletionBlocker | null {
  if (!i.packages.length || !i.packages.every(isStopped)) return 'packages_open';
  if (allCancelled(i.packages)) return 'all_packages_cancelled';
  if (i.lastDeliveredAt && (!i.returnWindowEndsAt || i.returnWindowEndsAt.getTime() > i.now)) return 'return_window';
  if (i.openReturnRequests > 0) return 'return_requested';
  if (i.codUnconfirmed) return 'cod_unconfirmed';
  return null;
}

export type CancelInitiator = 'buyer' | 'seller' | 'platform';
const CANCEL_INITIATOR_ORDER: readonly CancelInitiator[] = ['buyer', 'seller', 'platform'];
/** Lý do cấp đơn khi sàn tự huỷ mà không món nào ghi người, lý do. */
export const PLATFORM_CANCEL_REASON = 'Sàn huỷ đơn';
/** Lý do cấp đơn khi hệ thống huỷ đơn không phải đơn sàn vì mọi kiện đã huỷ (`auto_cancel`). */
export const AUTO_CANCEL_REASON = 'Mọi kiện đã huỷ';

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
 * Lý do huỷ cấp đơn khi sàn huỷ cả đơn mà đơn chưa có lý do (Sale huỷ, Sale đồng ý khách xin huỷ đã ghi trước): **mọi**
 * món đã huỷ cùng một lý do khác rỗng thì lấy lý do đó; không món nào có lý do lẫn người huỷ thì "Sàn huỷ đơn"; còn lại
 * (nhiều lý do, có món không lý do, có người huỷ mà không lý do) thì để trống, lý do ở từng dòng. Trả `undefined` khi
 * không ghi.
 */
export function orderCancelReasonFromLines(
  lines: readonly { cancelledQty: number; cancelReason: string | null; cancelInitiator: CancelInitiator | null }[],
): string | undefined {
  const cancelled = lines.filter((l) => l.cancelledQty > 0);
  const reasons = cancelled.map((l) => l.cancelReason?.trim() || null);
  const [first] = reasons;
  if (first && reasons.every((r) => r === first)) return first;
  if (reasons.every((r) => r === null) && !cancelled.some((l) => l.cancelInitiator)) return PLATFORM_CANCEL_REASON;
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

export type ShipByFlag = 'due_soon' | 'overdue';
/** Còn ≤ 1/DUE_SOON_PARTS thời gian chuẩn bị hàng thì Sắp trễ hạn (Documents/25 §8.5). */
export const DUE_SOON_PARTS = 4;

export interface ShipByInput {
  shipBy: Date | null;
  /** Mốc bắt đầu thời gian chuẩn bị: lúc đặt trên sàn, thiếu thì lúc app nhận đơn (`placedAt ?? createdAt`, #432). */
  startAt: Date;
  packages: readonly PackageStatus[];
  now: number;
}

/**
 * Cờ hạn chuẩn bị hàng của sàn (Documents/25 §8.2, §8.5; #432), chỉ khi còn kiện chưa bàn giao (`PRE_HANDOVER`):
 * tới `shipBy` thì Trễ hạn; còn ≤ 1/4 khoảng từ mốc bắt đầu tới `shipBy` thì Sắp trễ hạn. Hai cờ không cùng lúc.
 * Mốc bắt đầu không trước `shipBy` thì chỉ có thể Trễ hạn. So mili giây nguyên, cùng công thức với `flagCondition`.
 */
export function shipByFlag(i: ShipByInput): ShipByFlag | null {
  if (!i.shipBy || !i.packages.some((s) => PRE_HANDOVER.includes(s))) return null;
  const deadline = i.shipBy.getTime();
  const remaining = deadline - i.now;
  if (remaining <= 0) return 'overdue';
  return DUE_SOON_PARTS * remaining <= deadline - i.startAt.getTime() ? 'due_soon' : null;
}
