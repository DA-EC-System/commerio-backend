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
  | 'lose_on_unload'
  | 'found'
  | 'platform_lost'
  | 'platform_in_transit'
  | 'platform_deliver';

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

/** Tab của màn kiện (21 §19.2). `shipping` gồm `in_transit`, `self_delivering`; `needs_open` theo cờ. */
export const PACKAGE_TABS = [
  'backordered',
  'reserved',
  'packed',
  'awaiting_pickup',
  'shipping',
  'delivery_failed',
  'returning',
  'needs_open',
] as const;
export type PackageTab = (typeof PACKAGE_TABS)[number];

export const holdsStock = (s: PackageStatus) => HOLDING.includes(s);
export const isHandedOver = (s: PackageStatus) => HANDED_OVER.includes(s);
export const isStopped = (s: PackageStatus) => STOPPED.includes(s);
export const isSealed = (s: PackageStatus) => SEALED.includes(s);

/** Nguồn của lần chuyển gần nhất vào trạng thái hiện tại (cột `source` của lịch sử trạng thái). */
export type StatusSource = 'user' | 'marketplace' | 'system';

export interface PackageRecord {
  source: 'marketplace' | 'inbox' | 'manual';
  selfDelivery: boolean;
  orderStatus: 'unpaid' | 'processing' | 'completed' | 'cancelled';
  /** Cờ Cần mở; chỉ cần nạp khi xét `lose_on_unload`. */
  needsOpen?: boolean;
  /** Bên gọi nạp từ lịch sử trạng thái, chỉ khi xét `platform_in_transit`, `platform_deliver`. */
  statusSource?: StatusSource;
}

/** Tập `from` của `lose`: kiện đã rời kho mà chưa dừng. */
const LOSE_FROM: readonly PackageStatus[] = ['in_transit', 'delivery_failed', 'returning', 'self_delivering'];
/** Trạng thái còn báo mất được: tập `from` của `lose` và `lose_on_unload` (spec #238 §5.3). */
export const LOSABLE: readonly PackageStatus[] = [...LOSE_FROM, ...SEALED];
export const canReportLost = (s: PackageStatus) => LOSABLE.includes(s);

/** Sàn kéo lại kiện người dùng đã chuyển sang `lost`/`returning` (spec #238 §5.4). */
const REVIVE_FROM: readonly PackageStatus[] = ['lost', 'returning'];

const carrierOnly = (r: PackageRecord) => (r.source === 'marketplace' ? 'not_allowed_for_source' : null);
const userMoved = (r: PackageRecord) => (r.statusSource === 'user' ? null : 'status_from_platform');
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
  // `lose` đứng trước `platform_lost`: `arrowAction` không truyền `system` trả mũi tên khớp đầu tiên.
  {
    from: LOSE_FROM,
    to: 'lost',
    action: 'lose',
    permission: process,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
  },
  // Kiện đã đóng không thấy khi dỡ (25 §8.3): chỉ khi đang chờ mở; bên gọi ghi bàn giao (trừ tồn) rồi `lost`.
  {
    from: SEALED,
    to: 'lost',
    action: 'lose_on_unload',
    permission: process,
    needsSecondPerson: true,
    allowSelfApproval: true,
    needsReason: true,
    guard: (r) => (r.needsOpen ? null : 'not_awaiting_open'),
  },
  { from: 'lost', to: 'returned', action: 'found', permission: process },
  { from: LOSE_FROM, to: 'lost', action: 'platform_lost', system: true },
  { from: REVIVE_FROM, to: 'in_transit', action: 'platform_in_transit', system: true, guard: userMoved },
  { from: REVIVE_FROM, to: 'delivered', action: 'platform_deliver', system: true, guard: userMoved },
]);

/** Đường chính: sàn báo nhảy cóc trên đường này thì áp thẳng. */
export const MAIN_PATH: readonly PackageStatus[] = ['reserved', 'packed', 'awaiting_pickup', 'in_transit', 'delivered'];
/** Trước bàn giao (spec 199c D5): kiện ở đây mà sàn báo giao lỗi thì bù bàn giao (trừ tồn một lần) rồi áp. */
const PRE_HANDOVER: readonly PackageStatus[] = ['backordered', 'reserved', 'packed', 'awaiting_pickup'];

const fromList = (from: PackageStatus | readonly PackageStatus[]) => (typeof from === 'string' ? [from] : from);

/**
 * Thao tác của mũi tên `from → to` trong bảng, `undefined` khi không có mũi tên. `system`: đường sàn, mũi tên của hệ
 * thống khớp trước (sàn báo mất ra `platform_lost`, không ra `lose`); không có thì trả mũi tên khớp bất kỳ.
 */
export function arrowAction(from: PackageStatus, to: PackageStatus, opts: { system?: boolean } = {}): PackageAction | undefined {
  const arrows = packageMachine.transitions.filter((t) => t.to === to && fromList(t.from).includes(from));
  return ((opts.system ? arrows.find((t) => t.system) : undefined) ?? arrows[0])?.action;
}

/**
 * Sàn đẩy trạng thái kiện, xét theo thứ tự:
 * 1. Kiện `lost`/`returning` mà sàn báo `in_transit`/`delivered` (`platform_in_transit`, `platform_deliver`): `direct`
 *    khi trạng thái hiện tại do người chuyển tay (`ctx.statusSource = 'user'`), còn lại `invalid` (spec #238 §5.4).
 * 2. Kiện trước bàn giao mà sàn báo nhánh giao lỗi (`delivery_failed`, `returning`) hoặc `lost`: `jump`;
 *    `stockEffectOf` trả `ship` nên lõi bàn giao tự bù trừ tồn (spec 199c D5, spec #238 D18). Xét trước mũi tên vì
 *    `packed`/`awaiting_pickup` → `lost` có mũi tên `lose_on_unload` của người dùng.
 * 3. `direct` khi có mũi tên (ưu tiên mũi tên hệ thống), `jump` khi nhảy tới trên đường chính (kiện thiếu hàng tính
 *    như đang giữ), còn lại `invalid` (kiện gắn cờ Cần xử lý).
 */
export function platformUpdate(
  from: PackageStatus,
  to: PackageStatus,
  ctx: { statusSource?: StatusSource } = {},
): 'direct' | 'jump' | 'invalid' {
  if (REVIVE_FROM.includes(from) && (to === 'in_transit' || to === 'delivered')) {
    return ctx.statusSource === 'user' ? 'direct' : 'invalid';
  }
  if (PRE_HANDOVER.includes(from) && (to === 'delivery_failed' || to === 'returning' || to === 'lost')) return 'jump';
  if (arrowAction(from, to, { system: true })) return 'direct';
  const a = MAIN_PATH.indexOf(from === 'backordered' ? 'reserved' : from);
  const b = MAIN_PATH.indexOf(to);
  if (a >= 0 && b > a) return 'jump';
  return 'invalid';
}
