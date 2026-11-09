// Kiện của đơn sàn theo trạng thái sàn đẩy về (#105). Mỗi mã kiện sàn một kiện; sàn chưa chia kiện thì một kiện tạm,
// nhận mã ở lần kéo sau. Giữ, nhả lúc tạo, huỷ; kiện vào nhóm rời kho thì trừ tồn qua lõi `handover-stock.ts` (#199).
import { sql } from 'drizzle-orm';
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { handoverStockMode, stockEffectOf } from '../domain/handover.ts';
import {
  type CancelKind,
  type PackageEvent,
  type PlatformLineStatus,
  DEFAULT_FAIL_REASON,
  deliveryTarget,
  eventsOf,
  journeyTimes,
  lineStatus,
} from '../domain/delivery.ts';
import { arrowAction, holdsStock, isHandedOver, isSealed, type PackageStatus, platformUpdate } from '../domain/package.ts';
import { reportDeliveryFailed, reportDelivered } from './delivery.ts';
import {
  insertPackage,
  insertPackageLines,
  lockOrderPackages,
  type PackageRow,
  type PackageShipping,
  setReserved,
  updatePackage,
} from '../repository/packages.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { PackageNotice } from '../repository/schema.ts';
import { requestAllocation } from './allocation.ts';
import { settleHandover } from './handover-stock.ts';
import { type StockLine, stockPort } from './stock-port.ts';

// Trạng thái món sàn đã chuẩn hoá (cùng giá trị `RemoteLineStatus` của adapter) khai trong `domain/delivery.ts`
// (domain không được import service); re-export để sales, test giữ import cũ.
export type { PlatformLineStatus, CancelKind, PackageEvent } from '../domain/delivery.ts';

/**
 * Đơn của kiện. `holdStock` false: gian hàng chờ kiểm kê đầu kỳ (#198), không giữ hàng cho kiện mới, kiện rời kho thì
 * hoãn trừ tồn tới `settleDeferredHandovers`. `placedAt`, `orderCutoffAt` (mốc kéo đơn của gian hàng) quyết kiện lần đầu
 * thấy đã rời kho có trừ tồn không (25 §6.1, §8.1).
 */
export interface PlatformPackageOrder {
  id: string;
  shopId: string;
  shipBy: Date | null;
  holdStock: boolean;
  placedAt: Date;
  orderCutoffAt: Date | null;
  /** Hành trình kiện của sàn (spec 199c §5.7), đọc ngoài giao dịch; thiếu là `[]` (mốc lấy giờ đồng bộ). */
  packageEvents?: readonly PackageEvent[];
}

export interface PlatformPackageLine {
  orderLineId: string;
  variantId: string | null;
  quantity: number;
  packageCode: string | null;
  trackingCode: string | null;
  /** null: sàn trả giá trị app chưa biết. */
  status: PlatformLineStatus | null;
  /** Loại huỷ của sàn (`cancellation_reason`); món huỷ vì giao không thành là `failed_delivery` (spec 199c D2). */
  cancelKind?: CancelKind | null;
  shipping: PackageShipping;
}

const SHIPPING_KEYS = ['shipmentProvider', 'shippingProviderType', 'shippingType', 'promisedShippingAt'] as const;

/** Vận chuyển của nhóm món: món đầu có giá trị (như mã vận đơn); món không có thì giữ giá trị đã lưu. */
function shippingOf(lines: readonly PlatformPackageLine[], saved: PackageShipping): PackageShipping {
  const pick = <K extends (typeof SHIPPING_KEYS)[number]>(k: K) => lines.find((l) => l.shipping[k] !== null)?.shipping[k] ?? saved[k];
  return {
    shipmentProvider: pick('shipmentProvider'),
    shippingProviderType: pick('shippingProviderType'),
    shippingType: pick('shippingType'),
    promisedShippingAt: pick('promisedShippingAt'),
  };
}

const sameShipping = (a: PackageShipping, b: PackageShipping) =>
  SHIPPING_KEYS.every((k) => (a[k] instanceof Date || b[k] instanceof Date ? a[k]?.valueOf() === b[k]?.valueOf() : a[k] === b[k]));

const NO_SHIPPING: PackageShipping = { shipmentProvider: null, shippingProviderType: null, shippingType: null, promisedShippingAt: null };

export interface PlatformPackagesResult {
  statuses: PackageStatus[];
  changed: boolean;
  /** Sàn chia lại kiện khác lần trước: chưa tự xử lý, đơn cần người xem. */
  resplit: boolean;
  /** Món có trạng thái app chưa biết. */
  unknown: boolean;
}

// Món chậm nhất quyết định trạng thái kiện; món đã huỷ không tính trừ khi cả kiện huỷ.
const RANK: Record<Exclude<PlatformLineStatus, 'cancelled'>, number> = {
  pending: 0,
  packed: 1,
  awaiting_pickup: 2,
  in_transit: 3,
  delivery_failed: 3,
  returning: 4,
  return_failed: 4,
  delivered: 5,
  returned: 5,
  lost: 5,
};

// Trạng thái món đã tính loại huỷ (`lineStatus`): món huỷ vì giao không thành kể là `returning` (spec 199c D2).
function groupStatus(lines: readonly PlatformPackageLine[]): PlatformLineStatus | null {
  const statuses = lines.map(lineStatus);
  if (statuses.some((s) => s === null)) return null;
  const live = statuses.filter((s) => s !== 'cancelled') as (keyof typeof RANK)[];
  if (!live.length) return 'cancelled';
  return live.reduce((a, b) => (RANK[b] < RANK[a] ? b : a));
}

/** Sàn báo huỷ mọi món của nhóm (trạng thái thô, chưa tính loại huỷ). */
const allCancelled = (lines: readonly PlatformPackageLine[]) => lines.every((l) => l.status === 'cancelled');

const stockLines = (lines: PackageRow['lines'] | readonly PlatformPackageLine[]): StockLine[] =>
  lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));

/**
 * Mốc rời kho, đã giao khi sàn báo (CHECK `packages_handed_over`, `packages_handover_source`); người làm để trống vì
 * sàn làm. Mốc theo hành trình kiện (`times`), sự kiện nào vắng hoặc sau giờ đồng bộ thì lấy giờ đồng bộ (spec 199c §5.4).
 */
function milestones(
  from: PackageStatus | null,
  to: PackageStatus,
  times: { leftAt: Date | null; deliveredAt: Date | null } = { leftAt: null, deliveredAt: null },
  now = new Date(),
) {
  const leftAt = times.leftAt ?? now;
  return {
    // Sàn báo rời kho thì cũng là sàn xác nhận lấy (`pickup_confirmed_at`, 21 §19.2).
    ...(isHandedOver(to) && !(from && isHandedOver(from))
      ? { handedOverAt: leftAt, handoverSource: 'marketplace' as const, pickupConfirmedAt: leftAt }
      : {}),
    ...(to === 'delivered' ? { deliveredAt: times.deliveredAt ?? now } : {}),
  };
}

/**
 * Đổi trạng thái kiện; `times`, `failReason` theo hành trình của nhóm món (spec 199c §5.4). Khi vào `delivery_failed`
 * thì lịch sử ghi lý do (từ trace khi có, không thì câu mặc định), và báo thất bại cho finance. Khi vào `delivered`
 * thì báo giao xong sau khi trừ tồn (một lần, `delivery_posted_at` chặn).
 */
async function changeStatus(
  order: PlatformPackageOrder,
  pkg: PackageRow,
  to: PackageStatus,
  action: string,
  times?: { leftAt: Date | null; deliveredAt: Date | null },
  failReason?: string | null,
) {
  const from = pkg.status;
  const marks = milestones(from, to, times);
  await updatePackage(pkg.id, { status: to, ...marks });
  await recordTransition({
    entityType: 'packages',
    entityId: pkg.id,
    from,
    to,
    action,
    actorId: null,
    source: 'marketplace',
    ...(to === 'delivery_failed' ? { reason: failReason ?? DEFAULT_FAIL_REASON } : {}),
  });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: pkg.id, orderId: order.id, from, to } });
  Object.assign(pkg, { status: to }, marks);
  // Sàn báo kiện rời kho (kể cả nhảy cóc từ thiếu hàng): trừ tồn một lần; chờ kiểm kê thì hoãn.
  if (stockEffectOf(from, to) === 'ship') await settleHandover(pkg, { actorId: null, mode: order.holdStock ? 'deduct' : 'defer' });
  if (to === 'delivered') await reportDelivered(pkg.id);
  else if (to === 'delivery_failed') await reportDeliveryFailed({ id: pkg.id, orderId: pkg.orderId }, failReason ?? DEFAULT_FAIL_REASON);
}

/**
 * Giữ hàng qua cổng tồn. `reserve` còn chờ issue khác (501 `not_implemented`) thì không làm hỏng lượt kéo đơn: kiện ở
 * `backordered`, mang `notices` (Documents/21 §18.7.9). Lỗi khác ném tiếp.
 */
async function tryReserve(id: string, lines: readonly PlatformPackageLine[]): Promise<{ reserved: boolean; notices: PackageNotice[] }> {
  try {
    return { reserved: (await stockPort().reserve(id, stockLines(lines))).reserved, notices: [] };
  } catch (err) {
    if (!(err instanceof AppError && err.code === 'not_implemented')) throw err;
    const { issue, owner } = (err.extensions ?? {}) as { issue?: string; owner?: string };
    return {
      reserved: false,
      notices: [{ code: 'not_implemented', issue: issue ?? '', owner: owner ?? '', message: 'Chưa giữ hàng được cho kiện này' }],
    };
  }
}

async function createPackage(
  order: PlatformPackageOrder,
  code: string,
  status: PlatformLineStatus,
  lines: readonly PlatformPackageLine[],
  journey: { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null },
): Promise<PackageRow> {
  // Món chưa đóng gói, hoặc đã đóng gói nhưng chưa rời kho, thì giữ hàng; đủ ghép SKU mới gọi cổng tồn.
  const wantsStock = status === 'pending' || status === 'packed' || status === 'awaiting_pickup';
  const mapped = lines.every((l) => l.variantId);
  // Cách xử lý tồn tính trước khi chèn: kiện lần đầu thấy đã hoàn về của đơn đặt trước mốc vào thẳng `returned` (D9).
  const mode = handoverStockMode({ firstSeen: true, placedAt: order.placedAt, orderCutoffAt: order.orderCutoffAt, awaitingStocktake: !order.holdStock });
  const initial: PackageStatus =
    status === 'pending' ? 'backordered' : status === 'cancelled' ? 'cancelled' : deliveryTarget(status, { firstSeen: true, storeOnly: mode === 'store_only' });
  const shipping = shippingOf(lines, NO_SHIPPING);
  const id = await insertPackage({
    ...shipping,
    code,
    orderId: order.id,
    shopId: order.shopId,
    platformPackageCode: lines[0]!.packageCode,
    trackingCode: lines[0]!.trackingCode,
    status: initial,
    shipBy: order.shipBy,
    ...milestones(null, initial, { leftAt: journey.leftAt, deliveredAt: journey.deliveredAt }),
  });
  const { reserved, notices } = wantsStock && mapped && order.holdStock ? await tryReserve(id, lines) : { reserved: false, notices: [] };
  if (notices.length) await updatePackage(id, { notices });
  const to: PackageStatus = initial === 'backordered' && reserved ? 'reserved' : initial;
  const rows = lines.map((l) => ({ orderLineId: l.orderLineId, variantId: l.variantId, quantity: l.quantity, reservedQty: reserved ? l.quantity : 0 }));
  const lineIds = await insertPackageLines(id, rows);
  if (to !== initial || reserved) await updatePackage(id, { ...(to !== initial && { status: to }), ...(reserved && { reservedAt: sql`now()` }) });
  // Kiện mới giữ hàng làm số có thể bán giảm: báo channel đẩy tồn (spec 199b D4), không chạy lượt phân hàng.
  if (reserved) {
    const variantIds = [...new Set(stockLines(lines).map((l) => l.variantId))].sort();
    await publishEvent({ type: 'fulfillment.allocation_done', aggregateId: requireCompanyId('createPackage'), payload: { variantIds } });
  }
  if (status === 'return_failed') await updatePackage(id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
  await recordTransition({
    entityType: 'packages',
    entityId: id,
    from: null,
    to,
    action: 'create',
    actorId: null,
    source: 'marketplace',
    ...(to === 'delivery_failed' ? { reason: journey.failReason ?? DEFAULT_FAIL_REASON } : {}),
  });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: id, orderId: order.id, from: null, to } });
  const marks = milestones(null, initial, { leftAt: journey.leftAt, deliveredAt: journey.deliveredAt });
  const pkg: PackageRow = {
    id,
    code,
    orderId: order.id,
    shopId: order.shopId,
    status: to,
    version: 0,
    handoverSource: marks.handoverSource ?? null,
    pickupConfirmedAt: marks.pickupConfirmedAt ?? null,
    handedOverAt: marks.handedOverAt ?? null,
    platformPackageCode: lines[0]!.packageCode,
    trackingCode: lines[0]!.trackingCode,
    needsOpen: false,
    needsAttention: status === 'return_failed',
    shipping,
    lines: rows.map((l, i) => ({ ...l, id: lineIds[i]!, stockDeducted: false })),
  };
  // Kiện lần đầu thấy đã rời kho: đơn đặt trước mốc kéo đơn thì chỉ lưu (kiểm kê đã tính), còn lại trừ (25 §8.1).
  // Kiện vào thẳng `returned` (D9) cũng chỉ lưu: không phiếu `KT`, không `package_returned`.
  if (stockEffectOf(null, to) === 'ship') await settleHandover(pkg, { actorId: null, mode });
  // Kiện lần đầu thấy đã giao / giao thất bại (spec 199c §5.4 "Kiện mới"): báo cho finance sau khi trừ tồn.
  if (to === 'delivered') await reportDelivered(pkg.id);
  else if (to === 'delivery_failed') await reportDeliveryFailed({ id: pkg.id, orderId: pkg.orderId }, journey.failReason ?? DEFAULT_FAIL_REASON);
  return pkg;
}

/** Áp trạng thái sàn lên một kiện đã có; trả true khi có đổi. Món huỷ cả kiện xử lý ở `cancelPlatformPackage`. */
async function applyStatus(
  order: PlatformPackageOrder,
  pkg: PackageRow,
  remote: Exclude<PlatformLineStatus, 'cancelled'>,
  journey: { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null },
): Promise<boolean> {
  if (remote === 'pending') return false;
  const to = deliveryTarget(remote, { firstSeen: false, storeOnly: false });
  // Kho đã quét nhận hàng hoàn trước, sàn báo hoàn chậm hơn: bỏ qua, không cờ (spec 199c §5.4, AC14).
  if (pkg.status === 'returned' && to === 'returning') return false;
  let changed = false;
  // Kho đã quét mà sàn báo rời kho: sàn xác nhận lấy, không trừ thêm (spec 199a §5.4). Mốc theo hành trình (spec 199c).
  if (pkg.handoverSource === 'scan' && pkg.pickupConfirmedAt === null && isHandedOver(pkg.status) && isHandedOver(to)) {
    const at = journey.leftAt ?? new Date();
    await updatePackage(pkg.id, { pickupConfirmedAt: at });
    pkg.pickupConfirmedAt = at;
  }
  // Sàn không bao giờ kéo kiện ra khỏi nhóm rời kho (mũi tên `undo_handover` chỉ dành cho CEO, đi kèm đảo tồn). Kho vừa
  // quét mà sàn chưa cập nhật thì bỏ qua (sàn chậm hơn kho là bình thường); còn lại là bất thường, gắn cờ Cần xử lý.
  const backFromOut = stockEffectOf(pkg.status, to) === 'reverse';
  if (backFromOut && pkg.handoverSource === 'scan' && pkg.pickupConfirmedAt === null) return false;
  if (to !== pkg.status) {
    const kind = backFromOut ? 'invalid' : platformUpdate(pkg.status, to);
    if (kind === 'invalid') {
      if (pkg.needsAttention) return false;
      await updatePackage(pkg.id, { needsAttention: true, flagNote: `Sàn báo ${remote} khi kiện đang ${pkg.status}` });
      pkg.needsAttention = true;
      return true;
    }
    await changeStatus(order, pkg, to, (kind === 'direct' && arrowAction(pkg.status, to)) || 'platform_sync', journey, journey.failReason);
    changed = true;
  }
  if (remote === 'return_failed' && !pkg.needsAttention) {
    await updatePackage(pkg.id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
    pkg.needsAttention = true;
    changed = true;
  }
  return changed;
}

/**
 * Sàn huỷ cả kiện: chưa đóng gói thì huỷ và nhả hàng; đã đóng gói thì chờ mở (`needs_open`, mở là #106); đã rời kho
 * thì để kiện chạy tiếp (Documents/21 §19.1, #105 A5).
 */
export async function cancelPlatformPackage(order: PlatformPackageOrder, pkg: PackageRow): Promise<'cancelled' | 'needs_open' | 'handed_over'> {
  if (pkg.status === 'cancelled') return 'cancelled';
  if (isHandedOver(pkg.status)) return 'handed_over';
  if (isSealed(pkg.status)) {
    if (!pkg.needsOpen) {
      await updatePackage(pkg.id, { needsOpen: true, openPurpose: 'cancel' });
      pkg.needsOpen = true;
    }
    return 'needs_open';
  }
  if (holdsStock(pkg.status)) {
    await stockPort().release(pkg.id, stockLines(pkg.lines));
    await setReserved(pkg.id, false);
    // Số có thể bán tăng: phân hàng cho kiện khác sau khi giao dịch commit (spec 199b §5.4).
    await requestAllocation(stockLines(pkg.lines).map((l) => l.variantId));
  }
  await changeStatus(order, pkg, 'cancelled', 'cancel');
  return 'cancelled';
}

/**
 * Đồng bộ kiện của một đơn sàn với các món sàn trả về. `nextCode` cấp mã kiện mới (`KH-000001`), do `sales` giữ bộ
 * đếm. Trả trạng thái các kiện sau khi áp, để đơn suy cờ và quyết định huỷ.
 */
export async function syncPlatformPackages(
  order: PlatformPackageOrder,
  lines: readonly PlatformPackageLine[],
  nextCode: () => Promise<string>,
): Promise<PlatformPackagesResult & { cancelled: ('cancelled' | 'needs_open' | 'handed_over')[] }> {
  const existing = await lockOrderPackages(order.id);
  const owner = new Map(existing.flatMap((p) => p.lines.map((l) => [l.orderLineId, p] as const)));
  const groups = new Map<string, PlatformPackageLine[]>();
  for (const l of lines) groups.set(l.packageCode ?? '', [...(groups.get(l.packageCode ?? '') ?? []), l]);

  const result = { changed: false, resplit: false, unknown: false, cancelled: [] as ('cancelled' | 'needs_open' | 'handed_over')[] };
  const events = order.packageEvents ?? [];
  const touched = new Set<string>();
  for (const [code, group] of groups) {
    const status = groupStatus(group);
    // Hành trình kiện của nhóm (spec 199c §5.4): khớp mã kiện sàn rồi mã vận đơn, một lần mỗi nhóm; mốc thiếu/lai `now`.
    const journey = journeyTimes(eventsOf(events, { platformPackageCode: code || null, trackingCode: group.find((l) => l.trackingCode)?.trackingCode ?? null }), new Date());
    let pkg = (code && existing.find((p) => p.platformPackageCode === code)) || owner.get(group[0]!.orderLineId);
    if (pkg && code && pkg.platformPackageCode === null) {
      await updatePackage(pkg.id, { platformPackageCode: code });
      pkg.platformPackageCode = code;
      result.changed = true;
    }
    if (!pkg) {
      if (group.some((l) => owner.has(l.orderLineId))) {
        result.resplit = true;
        continue;
      }
      if (status === null) {
        result.unknown = true;
        continue;
      }
      pkg = await createPackage(order, await nextCode(), status, group, journey);
      existing.push(pkg);
      touched.add(pkg.id);
      result.changed = true;
      if (status === 'cancelled') result.cancelled.push('cancelled');
      else if (allCancelled(group)) result.cancelled.push('handed_over');
      continue;
    }
    if (group.some((l) => owner.get(l.orderLineId) && owner.get(l.orderLineId) !== pkg)) result.resplit = true;
    touched.add(pkg.id);
    const tracking = group.find((l) => l.trackingCode)?.trackingCode ?? null;
    if (tracking && tracking !== pkg.trackingCode) {
      await updatePackage(pkg.id, { trackingCode: tracking });
      pkg.trackingCode = tracking;
      result.changed = true;
    }
    // Vận chuyển chỉ là thông tin (#260): ghi khi khác, không tính là đổi (không phát sự kiện đơn, không đếm "cập nhật").
    const shipping = shippingOf(group, pkg.shipping);
    if (!sameShipping(shipping, pkg.shipping)) {
      await updatePackage(pkg.id, shipping);
      pkg.shipping = shipping;
    }
    if (status === null) result.unknown = true;
    else if (status === 'cancelled') {
      const before = [pkg.status, pkg.needsOpen].join();
      result.cancelled.push(await cancelPlatformPackage(order, pkg));
      if ([pkg.status, pkg.needsOpen].join() !== before) result.changed = true;
    } else {
      if (await applyStatus(order, pkg, status, journey)) result.changed = true;
      // Sàn huỷ món vì giao không thành (D2): kiện đi tiếp sang `returning`; báo `handed_over` như kiện đã rời kho bị
      // sàn huỷ để sales bật cờ `platform_cancelled`, không huỷ đơn (spec 199c §5.4, 25 §8.2).
      if (allCancelled(group)) result.cancelled.push('handed_over');
    }
  }
  return { ...result, statuses: existing.map((p) => p.status) };
}
