// Máy trạng thái kiện (Documents/21 §19.2, sơ đồ D2), cùng bảng với FE `src/lib/machines/order.ts`.
// #105 dùng bảng này để áp trạng thái sàn đẩy về; thao tác của người dùng (đóng gói, bàn giao…) làm ở #106.
import { defineMachine } from '../../../core/index.ts';

export type PackageStatus =
  | 'backordered'
  | 'reserved'
  | 'packed'
  | 'awaiting_pickup'
  | 'self_delivering'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'lost'
  | 'cancelled';

export type PackageAction =
  | 'hold'
  | 'reclaim'
  | 'pack'
  | 'mark_ready'
  | 'hand_over'
  | 'undo_handover'
  | 'open'
  | 'open_cancel'
  | 'cancel'
  | 'self_deliver'
  | 'deliver'
  | 'fail'
  | 'redeliver'
  | 'redeliver_self'
  | 'return'
  | 'receive_return'
  | 'lose'
  | 'found';

/** Kiện đang giữ hàng: tính vào Đang giữ của tồn kho. */
export const HOLDING: readonly PackageStatus[] = ['reserved', 'packed', 'awaiting_pickup'];
/** Kiện đã rời kho: tồn thực đã trừ. */
export const HANDED_OVER: readonly PackageStatus[] = [
  'in_transit',
  'self_delivering',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'lost',
];
/** Kiện đã dừng. */
export const STOPPED: readonly PackageStatus[] = ['delivered', 'returned', 'lost', 'cancelled'];
/** Kiện đã đóng gói: huỷ phải mở kiện trước. */
export const SEALED: readonly PackageStatus[] = ['packed', 'awaiting_pickup'];

export const holdsStock = (s: PackageStatus) => HOLDING.includes(s);
export const isHandedOver = (s: PackageStatus) => HANDED_OVER.includes(s);
export const isStopped = (s: PackageStatus) => STOPPED.includes(s);
export const isSealed = (s: PackageStatus) => SEALED.includes(s);

export interface PackageRecord {
  source: 'marketplace' | 'inbox' | 'manual';
  selfDelivery: boolean;
  orderStatus: 'unpaid' | 'processing' | 'completed' | 'cancelled';
}

const carrierOnly = (r: PackageRecord) => (r.source === 'marketplace' ? 'not_allowed_for_source' : null);
const process = 'fulfillment.order.process';
const delivery = 'fulfillment.delivery.update';

export const packageMachine = defineMachine<PackageStatus, PackageAction, PackageRecord>([
  { from: 'backordered', to: 'reserved', action: 'hold', system: true },
  { from: 'reserved', to: 'backordered', action: 'reclaim', system: true },
  {
    from: 'reserved',
    to: 'packed',
    action: 'pack',
    permission: process,
    guard: (r) => (r.orderStatus === 'processing' ? null : 'order_not_processing'),
  },
  {
    from: 'packed',
    to: 'awaiting_pickup',
    action: 'mark_ready',
    permission: process,
    guard: (r) => (r.selfDelivery ? 'self_delivery' : null),
  },
  { from: 'awaiting_pickup', to: 'in_transit', action: 'hand_over', permission: process },
  { from: 'in_transit', to: 'awaiting_pickup', action: 'undo_handover', permission: 'fulfillment.handover.revert', needsReason: true },
  { from: SEALED, to: 'reserved', action: 'open', permission: process },
  { from: SEALED, to: 'cancelled', action: 'open_cancel', permission: process },
  { from: ['backordered', 'reserved'], to: 'cancelled', action: 'cancel', system: true },
  {
    from: 'packed',
    to: 'self_delivering',
    action: 'self_deliver',
    permission: delivery,
    guard: (r) => (r.selfDelivery ? null : 'carrier_delivery'),
  },
  { from: ['in_transit', 'self_delivering', 'delivery_failed'], to: 'delivered', action: 'deliver', permission: delivery, guard: carrierOnly },
  {
    from: ['in_transit', 'self_delivering'],
    to: 'delivery_failed',
    action: 'fail',
    permission: delivery,
    needsReason: true,
    guard: carrierOnly,
  },
  {
    from: 'delivery_failed',
    to: 'in_transit',
    action: 'redeliver',
    permission: delivery,
    guard: (r) => carrierOnly(r) ?? (r.selfDelivery ? 'self_delivery' : null),
  },
  {
    from: 'delivery_failed',
    to: 'self_delivering',
    action: 'redeliver_self',
    permission: delivery,
    guard: (r) => (r.selfDelivery ? null : 'carrier_delivery'),
  },
  {
    from: ['in_transit', 'delivery_failed', 'self_delivering'],
    to: 'returning',
    action: 'return',
    permission: delivery,
    guard: carrierOnly,
  },
  { from: 'returning', to: 'returned', action: 'receive_return', permission: process },
  {
    from: ['awaiting_pickup', 'in_transit', 'delivery_failed', 'returning', 'self_delivering'],
    to: 'lost',
    action: 'lose',
    permission: process,
    needsSecondPerson: true,
    needsReason: true,
  },
  { from: 'lost', to: 'returned', action: 'found', permission: process },
]);

/** Đường chính: sàn báo nhảy cóc trên đường này thì áp thẳng. */
export const MAIN_PATH: readonly PackageStatus[] = ['reserved', 'packed', 'awaiting_pickup', 'in_transit', 'delivered'];

const fromList = (from: PackageStatus | readonly PackageStatus[]) => (typeof from === 'string' ? [from] : from);

/** Thao tác của mũi tên `from → to` trong bảng, `undefined` khi không có mũi tên. */
export function arrowAction(from: PackageStatus, to: PackageStatus): PackageAction | undefined {
  return packageMachine.transitions.find((t) => t.to === to && fromList(t.from).includes(from))?.action;
}

/**
 * Sàn đẩy trạng thái kiện: `direct` khi có mũi tên, `jump` khi nhảy tới trên đường chính (kiện thiếu hàng tính như
 * đang giữ), `invalid` khi không áp được (kiện gắn cờ Cần xử lý).
 */
export function platformUpdate(from: PackageStatus, to: PackageStatus): 'direct' | 'jump' | 'invalid' {
  if (arrowAction(from, to)) return 'direct';
  const a = MAIN_PATH.indexOf(from === 'backordered' ? 'reserved' : from);
  const b = MAIN_PATH.indexOf(to);
  return a >= 0 && b > a ? 'jump' : 'invalid';
}
