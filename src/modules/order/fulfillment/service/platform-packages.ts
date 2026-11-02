// Kiện của đơn sàn theo trạng thái sàn đẩy về (#105). Mỗi mã kiện sàn một kiện; sàn chưa chia kiện thì một kiện tạm,
// nhận mã ở lần kéo sau. Ảnh hưởng tồn khi kiện rời kho, quay về là của #106; ở đây chỉ giữ và nhả lúc tạo, huỷ.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { arrowAction, holdsStock, isHandedOver, isSealed, type PackageStatus, platformUpdate } from '../domain/package.ts';
import { insertPackage, insertPackageLines, lockOrderPackages, type PackageRow, setReserved, updatePackage } from '../repository/packages.ts';
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

export interface PlatformPackageLine {
  orderLineId: string;
  variantId: string | null;
  quantity: number;
  packageCode: string | null;
  trackingCode: string | null;
  /** null: sàn trả giá trị app chưa biết. */
  status: PlatformLineStatus | null;
}

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

/** Mốc rời kho, đã giao khi sàn báo (CHECK `packages_handed_over`); người làm để trống vì sàn làm. */
function milestones(from: PackageStatus | null, to: PackageStatus, at = new Date()) {
  return {
    ...(isHandedOver(to) && !(from && isHandedOver(from)) ? { handedOverAt: at } : {}),
    ...(to === 'delivered' ? { deliveredAt: at } : {}),
  };
}

async function changeStatus(orderId: string, pkg: PackageRow, to: PackageStatus, action: string) {
  await updatePackage(pkg.id, { status: to, ...milestones(pkg.status, to) });
  await recordTransition({ entityType: 'packages', entityId: pkg.id, from: pkg.status, to, action, actorId: null, source: 'marketplace' });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: orderId, payload: { packageId: pkg.id, orderId, from: pkg.status, to } });
  pkg.status = to;
}

async function createPackage(
  order: { id: string; shopId: string; shipBy: Date | null },
  code: string,
  status: PlatformLineStatus,
  lines: readonly PlatformPackageLine[],
): Promise<PackageRow> {
  // Món chưa đóng gói, hoặc đã đóng gói nhưng chưa rời kho, thì giữ hàng; đủ ghép SKU mới gọi cổng tồn.
  const wantsStock = status === 'pending' || status === 'packed' || status === 'awaiting_pickup';
  const mapped = lines.every((l) => l.variantId);
  const initial: PackageStatus = status === 'pending' ? 'backordered' : status === 'return_failed' ? 'returning' : status;
  const id = await insertPackage({
    code,
    orderId: order.id,
    shopId: order.shopId,
    platformPackageCode: lines[0]!.packageCode,
    trackingCode: lines[0]!.trackingCode,
    status: initial,
    shipBy: order.shipBy,
    ...milestones(null, initial),
  });
  const reserved = wantsStock && mapped && (await stockPort().reserve(id, stockLines(lines))).reserved;
  const to: PackageStatus = initial === 'backordered' && reserved ? 'reserved' : initial;
  await insertPackageLines(
    id,
    lines.map((l) => ({ orderLineId: l.orderLineId, variantId: l.variantId, quantity: l.quantity, reservedQty: reserved ? l.quantity : 0 })),
  );
  if (to !== initial) await updatePackage(id, { status: to });
  if (status === 'return_failed') await updatePackage(id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
  await recordTransition({ entityType: 'packages', entityId: id, from: null, to, action: 'create', actorId: null, source: 'marketplace' });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: id, orderId: order.id, from: null, to } });
  return {
    id,
    status: to,
    platformPackageCode: lines[0]!.packageCode,
    trackingCode: lines[0]!.trackingCode,
    needsOpen: false,
    needsAttention: status === 'return_failed',
    lines: lines.map((l) => ({ orderLineId: l.orderLineId, variantId: l.variantId, quantity: l.quantity, reservedQty: reserved ? l.quantity : 0 })),
  };
}

/** Áp trạng thái sàn lên một kiện đã có; trả true khi có đổi. Món huỷ cả kiện xử lý ở `cancelPlatformPackage`. */
async function applyStatus(orderId: string, pkg: PackageRow, remote: Exclude<PlatformLineStatus, 'cancelled'>): Promise<boolean> {
  if (remote === 'pending') return false;
  const to: PackageStatus = remote === 'return_failed' ? 'returning' : remote;
  let changed = false;
  if (to !== pkg.status) {
    const kind = platformUpdate(pkg.status, to);
    if (kind === 'invalid') {
      if (pkg.needsAttention) return false;
      await updatePackage(pkg.id, { needsAttention: true, flagNote: `Sàn báo ${remote} khi kiện đang ${pkg.status}` });
      pkg.needsAttention = true;
      return true;
    }
    await changeStatus(orderId, pkg, to, (kind === 'direct' && arrowAction(pkg.status, to)) || 'platform_sync');
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
export async function cancelPlatformPackage(orderId: string, pkg: PackageRow): Promise<'cancelled' | 'needs_open' | 'handed_over'> {
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
  await changeStatus(orderId, pkg, 'cancelled', 'cancel');
  return 'cancelled';
}

/**
 * Đồng bộ kiện của một đơn sàn với các món sàn trả về. `nextCode` cấp mã kiện mới (`KH-000001`), do `sales` giữ bộ
 * đếm. Trả trạng thái các kiện sau khi áp, để đơn suy cờ và quyết định huỷ.
 */
export async function syncPlatformPackages(
  order: { id: string; shopId: string; shipBy: Date | null },
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
    if (status === null) result.unknown = true;
    else if (status === 'cancelled') {
      const before = [pkg.status, pkg.needsOpen].join();
      result.cancelled.push(await cancelPlatformPackage(order.id, pkg));
      if ([pkg.status, pkg.needsOpen].join() !== before) result.changed = true;
    } else if (await applyStatus(order.id, pkg, status)) result.changed = true;
  }
  return { ...result, statuses: existing.map((p) => p.status) };
}
