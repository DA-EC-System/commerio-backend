// Kiện của đơn sàn theo trạng thái sàn đẩy về (#105). Mỗi mã kiện sàn một kiện; sàn chưa chia kiện thì một kiện tạm,
// nhận mã ở lần kéo sau. Giữ, nhả lúc tạo, huỷ; kiện vào nhóm rời kho thì trừ tồn qua lõi `handover-stock.ts` (#199).
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { handoverStockMode, stockEffectOf } from '../domain/handover.ts';
import { arrowAction, holdsStock, isHandedOver, isSealed, type PackageStatus, platformUpdate } from '../domain/package.ts';
import {
  insertPackage,
  insertPackageLines,
  lockOrderPackages,
  type PackageRow,
  type PackageShipping,
  setReserved,
  updatePackage,
} from '../repository/packages.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { PackageNotice } from '../repository/schema.ts';
import { settleHandover } from './handover-stock.ts';
import { type StockLine, stockPort } from './stock-port.ts';

/** Trạng thái món sàn đã chuẩn hoá (cùng giá trị `RemoteLineStatus` của adapter). */
export type PlatformLineStatus =
  | 'pending'
  | 'packed'
  | 'awaiting_pickup'
  | 'in_transit'
  | 'delivered'
  | 'delivery_failed'
  | 'returning'
  | 'returned'
  | 'return_failed'
  | 'lost'
  | 'cancelled';

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
}

export interface PlatformPackageLine {
  orderLineId: string;
  variantId: string | null;
  quantity: number;
  packageCode: string | null;
  trackingCode: string | null;
  /** null: sàn trả giá trị app chưa biết. */
  status: PlatformLineStatus | null;
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

function groupStatus(lines: readonly PlatformPackageLine[]): PlatformLineStatus | null {
  if (lines.some((l) => l.status === null)) return null;
  const live = lines.filter((l) => l.status !== 'cancelled') as (PlatformPackageLine & { status: keyof typeof RANK })[];
  if (!live.length) return 'cancelled';
  return live.reduce((a, b) => (RANK[b.status] < RANK[a.status] ? b : a)).status;
}

const stockLines = (lines: PackageRow['lines'] | readonly PlatformPackageLine[]): StockLine[] =>
  lines.filter((l) => l.variantId).map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));

/**
 * Mốc rời kho, đã giao khi sàn báo (CHECK `packages_handed_over`, `packages_handover_source`); người làm để trống vì
 * sàn làm.
 */
function milestones(from: PackageStatus | null, to: PackageStatus, at = new Date()) {
  return {
    // Sàn báo rời kho thì cũng là sàn xác nhận lấy (`pickup_confirmed_at`, 21 §19.2).
    ...(isHandedOver(to) && !(from && isHandedOver(from))
      ? { handedOverAt: at, handoverSource: 'marketplace' as const, pickupConfirmedAt: at }
      : {}),
    ...(to === 'delivered' ? { deliveredAt: at } : {}),
  };
}

async function changeStatus(order: PlatformPackageOrder, pkg: PackageRow, to: PackageStatus, action: string) {
  const from = pkg.status;
  const marks = milestones(from, to);
  await updatePackage(pkg.id, { status: to, ...marks });
  await recordTransition({ entityType: 'packages', entityId: pkg.id, from, to, action, actorId: null, source: 'marketplace' });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: pkg.id, orderId: order.id, from, to } });
  Object.assign(pkg, { status: to }, marks);
  // Sàn báo kiện rời kho (kể cả nhảy cóc từ thiếu hàng): trừ tồn một lần; chờ kiểm kê thì hoãn.
  if (stockEffectOf(from, to) === 'ship') await settleHandover(pkg, { actorId: null, mode: order.holdStock ? 'deduct' : 'defer' });
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
): Promise<PackageRow> {
  // Món chưa đóng gói, hoặc đã đóng gói nhưng chưa rời kho, thì giữ hàng; đủ ghép SKU mới gọi cổng tồn.
  const wantsStock = status === 'pending' || status === 'packed' || status === 'awaiting_pickup';
  const mapped = lines.every((l) => l.variantId);
  const initial: PackageStatus = status === 'pending' ? 'backordered' : status === 'return_failed' ? 'returning' : status;
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
    ...milestones(null, initial),
  });
  const { reserved, notices } = wantsStock && mapped && order.holdStock ? await tryReserve(id, lines) : { reserved: false, notices: [] };
  if (notices.length) await updatePackage(id, { notices });
  const to: PackageStatus = initial === 'backordered' && reserved ? 'reserved' : initial;
  const rows = lines.map((l) => ({ orderLineId: l.orderLineId, variantId: l.variantId, quantity: l.quantity, reservedQty: reserved ? l.quantity : 0 }));
  const lineIds = await insertPackageLines(id, rows);
  if (to !== initial) await updatePackage(id, { status: to });
  if (status === 'return_failed') await updatePackage(id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
  await recordTransition({ entityType: 'packages', entityId: id, from: null, to, action: 'create', actorId: null, source: 'marketplace' });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: id, orderId: order.id, from: null, to } });
  const marks = milestones(null, initial);
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
  if (stockEffectOf(null, to) === 'ship') {
    await settleHandover(pkg, {
      actorId: null,
      mode: handoverStockMode({ firstSeen: true, placedAt: order.placedAt, orderCutoffAt: order.orderCutoffAt, awaitingStocktake: !order.holdStock }),
    });
  }
  return pkg;
}

/** Áp trạng thái sàn lên một kiện đã có; trả true khi có đổi. Món huỷ cả kiện xử lý ở `cancelPlatformPackage`. */
async function applyStatus(order: PlatformPackageOrder, pkg: PackageRow, remote: Exclude<PlatformLineStatus, 'cancelled'>): Promise<boolean> {
  if (remote === 'pending') return false;
  const to: PackageStatus = remote === 'return_failed' ? 'returning' : remote;
  let changed = false;
  // Kho đã quét mà sàn báo rời kho: sàn xác nhận lấy, không trừ thêm (spec 199a §5.4). Chỉ là thông tin, không tính đổi.
  if (pkg.handoverSource === 'scan' && pkg.pickupConfirmedAt === null && isHandedOver(pkg.status) && isHandedOver(to)) {
    const at = new Date();
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
    await changeStatus(order, pkg, to, (kind === 'direct' && arrowAction(pkg.status, to)) || 'platform_sync');
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
  const touched = new Set<string>();
  for (const [code, group] of groups) {
    const status = groupStatus(group);
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
      pkg = await createPackage(order, await nextCode(), status, group);
      existing.push(pkg);
      touched.add(pkg.id);
      result.changed = true;
      if (status === 'cancelled') result.cancelled.push('cancelled');
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
    } else if (await applyStatus(order, pkg, status)) result.changed = true;
  }
  return { ...result, statuses: existing.map((p) => p.status) };
}
