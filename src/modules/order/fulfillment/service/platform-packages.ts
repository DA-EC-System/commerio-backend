// Kiện của đơn sàn theo trạng thái sàn đẩy về (#105). Mỗi mã kiện sàn một kiện; sàn chưa chia kiện thì một kiện tạm,
// nhận mã ở lần kéo sau. Giữ, nhả lúc tạo, huỷ; kiện vào nhóm rời kho thì trừ tồn qua lõi `handover-stock.ts` (#199).
import { sql } from 'drizzle-orm';
import { getStatusHistory, publishEvent, recordTransition } from '../../../core/index.ts';
import { handoverStockMode, stockEffectOf } from '../domain/handover.ts';
import {
  type CancelKind,
  type PlatformLineStatus,
  type PlatformPackageOrder,
  DEFAULT_FAIL_REASON,
  deliveryTarget,
  eventsOf,
  journeyTimes,
  lineStatus,
} from '../domain/delivery.ts';
import { type CancelLine, planLineCancel } from '../domain/line-cancel.ts';
import { arrowAction, holdsStock, isHandedOver, isPlatformRevive, isSealed, type PackageStatus, platformUpdate } from '../domain/package.ts';
import { planResplit, type ResplitGroup, type ResplitPackage } from '../domain/resplit.ts';
import { takeAllocationLock } from '../repository/allocation.ts';
import { deleteLines, setPendingDrop, setPendingDropAll } from '../repository/line-cancel.ts';
import { reportDeliveryFailed, reportDelivered } from './delivery.ts';
import {
  insertPackage,
  insertPackageLines,
  lockOrderPackages,
  type PackageRow,
  type PackageShipping,
  readOrderPackages,
  setReserved,
  updatePackage,
} from '../repository/packages.ts';
import { requireCompanyId } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import type { PackageNotice } from '../repository/schema.ts';
import { requestAllocation } from './allocation.ts';
import { settleHandover } from './handover-stock.ts';
import { applyResplit, pendingSteps } from './resplit.ts';
import { type StockLine, stockPort } from './stock-port.ts';

// Trạng thái món sàn đã chuẩn hoá (cùng giá trị `RemoteLineStatus` của adapter) và đơn của kiện khai trong
// `domain/delivery.ts` (domain không được import service; `service/resplit.ts` dùng đơn mà không vòng import); re-export
// để sales, test giữ import cũ.
export type { PlatformLineStatus, CancelKind, PackageEvent, PlatformPackageOrder } from '../domain/delivery.ts';

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
  /**
   * Dòng đơn đã ghi huỷ đủ (`cancelled_qty = quantity`, sales truyền). Món đã gỡ khỏi kiện ở lượt trước không còn kiện
   * nào chứa: bỏ qua, không lập kiện `cancelled` mới cho nó (spec 205 D18).
   */
  alreadyCancelled?: boolean;
  /** Ghép "không quản tồn" (25 §8.1, #237): dòng không giữ, không trừ tồn; không có `variantId`. */
  untracked?: boolean;
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
  /**
   * Có phần sàn chia lại kiện mà app không tự xử lý (spec #238 D29: kiện đã bàn giao, sàn gộp món vào mã kiện cũ, một
   * món ở hai mã): đơn cần người xem. Chia lại xử lý được thì chỉ `changed`.
   */
  resplit: boolean;
  /** Món có trạng thái app chưa biết. */
  unknown: boolean;
  /** Sàn kéo lại kiện người dùng đã chuyển `lost`/`returning` (spec #238 §5.4): đơn cần người xem. */
  revived: boolean;
  /**
   * `order_line_id` của món sàn huỷ mà kiện chứa món chưa rời kho (gỡ, chờ bỏ, hay huỷ cả kiện): sales ghi
   * `cancelled_qty = quantity` trong cùng giao dịch (spec 205 §5.10). Có thể lặp lại qua các lượt kéo.
   */
  cancelledLines: string[];
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
  // #358: kiện có món đã giao và món `returned` là kiện đã giao; món `returned` lúc đó là khách trả sau khi nhận, đi
  // theo yêu cầu trả (Documents/25 §9), không phải kiện hoàn về. Chỉ khi mọi món là một trong hai trạng thái này: có món
  // chậm hơn thì món chậm nhất vẫn quyết, có món `lost` thì giữ luật hoà cũ (món đứng trước thắng).
  if (live.includes('delivered') && live.includes('returned') && live.every((s) => s === 'delivered' || s === 'returned')) return 'delivered';
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
  const flags = from === 'packed' && pkg.labelError ? { labelError: false } : {};
  // Sàn báo mất (spec #238 §5.4): kiện mang nguồn sàn (CHECK `packages_lost_confirmed`); kiện đang chờ mở thì gỡ cờ,
  // hộp đã rời kho. Báo cáo thất lạc của kho (nếu có) giữ nguyên.
  const lost = to === 'lost' ? { lostSource: 'marketplace' as const, ...(pkg.needsOpen ? { needsOpen: false, openPurpose: null } : {}) } : {};
  if (to === 'lost' && !isHandedOver(from)) logger.warn({ packageId: pkg.id, from }, 'sàn báo mất kiện chưa bàn giao');
  await updatePackage(pkg.id, { status: to, ...marks, ...flags, ...lost });
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
  if (to === 'lost') {
    await publishEvent({
      type: 'fulfillment.package_lost',
      aggregateId: order.id,
      payload: { packageId: pkg.id, orderId: order.id, claimCode: pkg.lostClaimCode ?? null },
    });
    pkg.needsOpen = false;
    pkg.openPurpose = null;
  }
  Object.assign(pkg, { status: to }, marks, flags);
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

/**
 * Lập kiện cho một nhóm món sàn. `resplit`: kiện mới do sàn chia lại kiện (spec #238 §5.6, D23): vào `backordered` bất kể
 * trạng thái sàn (vòng áp trạng thái áp sau, như kiện đã có), giữ ngay khi `hold` (kiện chờ thay thì không), không đi
 * luật "kiện lần đầu thấy" (`store_only`, mốc kéo đơn): hàng của nó đã nằm trong kho, đã giữ ở kiện cũ.
 */
async function createPackage(
  order: PlatformPackageOrder,
  code: string,
  status: PlatformLineStatus,
  lines: readonly PlatformPackageLine[],
  journey: { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null },
  resplit?: { replacesPackageId: string; replacesCode: string; hold: boolean },
): Promise<PackageRow> {
  // Món chưa đóng gói, hoặc đã đóng gói nhưng chưa rời kho, thì giữ hàng; đủ ghép SKU (hoặc "không quản tồn") mới qua
  // cổng tồn (spec 237).
  const wantsStock = resplit ? resplit.hold : status === 'pending' || status === 'packed' || status === 'awaiting_pickup';
  const mapped = lines.every((l) => l.variantId || l.untracked);
  const variantLines = stockLines(lines);
  // Cách xử lý tồn tính trước khi chèn: kiện lần đầu thấy đã hoàn về của đơn đặt trước mốc vào thẳng `returned` (D9).
  const mode = handoverStockMode({ firstSeen: true, placedAt: order.placedAt, orderCutoffAt: order.orderCutoffAt, awaitingStocktake: !order.holdStock });
  const initial: PackageStatus = resplit
    ? 'backordered'
    : status === 'pending'
      ? 'backordered'
      : status === 'cancelled'
        ? 'cancelled'
        : deliveryTarget(status, { firstSeen: true, storeOnly: mode === 'store_only' });
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
    // Kiện lần đầu thấy đã mất: nguồn sàn (CHECK `packages_lost_confirmed`, spec #238 §5.4).
    ...(initial === 'lost' ? { lostSource: 'marketplace' as const } : {}),
    ...(resplit ? { replacesPackageId: resplit.replacesPackageId } : {}),
  });
  // Kiện chỉ toàn dòng không quản tồn (chưa có dòng biến thể): coi như giữ được, không qua cổng tồn, kể cả
  // `holdStock` false (spec 237 D10). Có dòng biến thể thì giữ như cũ qua cổng tồn.
  const untrackedOnly = wantsStock && mapped && variantLines.length === 0;
  const { reserved, notices } = untrackedOnly
    ? { reserved: true, notices: [] }
    : wantsStock && mapped && order.holdStock
      ? await tryReserve(id, lines)
      : { reserved: false, notices: [] };
  if (notices.length) await updatePackage(id, { notices });
  const to: PackageStatus = initial === 'backordered' && reserved ? 'reserved' : initial;
  const rows = lines.map((l) => ({
    orderLineId: l.orderLineId,
    variantId: l.variantId,
    quantity: l.quantity,
    reservedQty: reserved && l.variantId ? l.quantity : 0,
    stockUntracked: !l.variantId && !!l.untracked,
  }));
  const lineIds = await insertPackageLines(id, rows);
  if (to !== initial || reserved) await updatePackage(id, { ...(to !== initial && { status: to }), ...(reserved && { reservedAt: sql`now()` }) });
  // Kiện mới giữ hàng làm số có thể bán giảm: báo channel đẩy tồn (spec 199b D4), không chạy lượt phân hàng.
  // Chỉ khi có dòng biến thể (dòng không quản tồn không giữ, không trừ — spec 237 D10).
  if (reserved && variantLines.length) {
    const variantIds = [...new Set(variantLines.map((l) => l.variantId))].sort();
    await publishEvent({ type: 'fulfillment.allocation_done', aggregateId: requireCompanyId('createPackage'), payload: { variantIds } });
  }
  // Kiện chia lại: cờ hoàn thất bại do vòng áp trạng thái bật (`applyStatus`).
  const returnFailed = status === 'return_failed' && !resplit;
  if (returnFailed) await updatePackage(id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
  await recordTransition({
    entityType: 'packages',
    entityId: id,
    from: null,
    to,
    action: 'create',
    actorId: null,
    source: 'marketplace',
    ...(resplit
      ? { reason: `Sàn chia lại kiện ${resplit.replacesCode}` }
      : to === 'delivery_failed'
        ? { reason: journey.failReason ?? DEFAULT_FAIL_REASON }
        : {}),
  });
  await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: order.id, payload: { packageId: id, orderId: order.id, from: null, to } });
  // Kiện rời kho trước mốc bắt đầu lấy đơn (`store_only`) không phát `package_lost` (spec #238 §5.4).
  if (to === 'lost' && mode !== 'store_only') {
    await publishEvent({ type: 'fulfillment.package_lost', aggregateId: order.id, payload: { packageId: id, orderId: order.id, claimCode: null } });
  }
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
    selfDelivery: false,
    lostReportedBy: null,
    lostClaimCode: null,
    openPurpose: null,
    labelError: false,
    needsAttention: returnFailed,
    replacesPackageId: resplit?.replacesPackageId ?? null,
    waybillKept: false,
    shipping,
    lines: rows.map((l, i) => ({ ...l, id: lineIds[i]!, stockDeducted: false, pendingDropQty: 0 })),
  };
  // Kiện lần đầu thấy đã rời kho: đơn đặt trước mốc kéo đơn thì chỉ lưu (kiểm kê đã tính), còn lại trừ (25 §8.1).
  // Kiện vào thẳng `returned` (D9) cũng chỉ lưu: không phiếu `KT`, không `package_returned`.
  if (stockEffectOf(null, to) === 'ship') await settleHandover(pkg, { actorId: null, mode });
  // Kiện lần đầu thấy đã giao / giao thất bại (spec 199c §5.4 "Kiện mới"): báo cho finance sau khi trừ tồn.
  if (to === 'delivered') await reportDelivered(pkg.id);
  else if (to === 'delivery_failed') await reportDeliveryFailed({ id: pkg.id, orderId: pkg.orderId }, journey.failReason ?? DEFAULT_FAIL_REASON);
  return pkg;
}

const UNCHANGED = { changed: false, revived: false } as const;

/**
 * Áp trạng thái sàn lên một kiện đã có; `changed` khi có đổi, `revived` khi sàn kéo lại kiện người dùng đã chuyển
 * `lost`/`returning` (spec #238 §5.4). Món huỷ cả kiện xử lý ở `cancelPlatformPackage`.
 */
async function applyStatus(
  order: PlatformPackageOrder,
  pkg: PackageRow,
  remote: Exclude<PlatformLineStatus, 'cancelled'>,
  journey: { leftAt: Date | null; deliveredAt: Date | null; failReason: string | null },
): Promise<{ changed: boolean; revived: boolean }> {
  if (remote === 'pending') return UNCHANGED;
  const to = deliveryTarget(remote, { firstSeen: false, storeOnly: false });
  // Kho đã quét nhận hàng hoàn trước, sàn báo hoàn chậm hơn: bỏ qua, không cờ (spec 199c §5.4, AC14).
  if (pkg.status === 'returned' && to === 'returning') return UNCHANGED;
  let changed = false;
  let revived = false;
  // Kho đã quét mà sàn báo rời kho: sàn xác nhận lấy, không trừ thêm (spec 199a §5.4). Mốc theo hành trình (spec 199c).
  if (pkg.handoverSource === 'scan' && pkg.pickupConfirmedAt === null && isHandedOver(pkg.status) && isHandedOver(to)) {
    const at = journey.leftAt ?? new Date();
    await updatePackage(pkg.id, { pickupConfirmedAt: at });
    pkg.pickupConfirmedAt = at;
  }
  // Sàn không bao giờ kéo kiện ra khỏi nhóm rời kho (mũi tên `undo_handover` chỉ dành cho CEO, đi kèm đảo tồn). Kho vừa
  // quét mà sàn chưa cập nhật thì bỏ qua (sàn chậm hơn kho là bình thường); còn lại là bất thường, gắn cờ Cần xử lý.
  const backFromOut = stockEffectOf(pkg.status, to) === 'reverse';
  if (backFromOut && pkg.handoverSource === 'scan' && pkg.pickupConfirmedAt === null) return UNCHANGED;
  if (to !== pkg.status) {
    const from = pkg.status;
    // Sàn kéo lại kiện `lost`/`returning`: chỉ áp khi lần chuyển gần nhất do người dùng (spec #238 §5.4). Đọc lịch sử
    // chỉ ở nhánh này.
    const revive = isPlatformRevive(from, to);
    const statusSource = revive ? (await getStatusHistory('packages', pkg.id)).at(-1)?.source : undefined;
    const kind = backFromOut ? 'invalid' : platformUpdate(from, to, { statusSource });
    if (kind === 'invalid') {
      if (pkg.needsAttention) return UNCHANGED;
      await updatePackage(pkg.id, { needsAttention: true, flagNote: `Sàn báo ${remote} khi kiện đang ${from}` });
      pkg.needsAttention = true;
      return { changed: true, revived: false };
    }
    // Đường sàn ưu tiên mũi tên hệ thống: sàn báo mất ghi `platform_lost`, không ghi `lose` của người dùng.
    await changeStatus(order, pkg, to, (kind === 'direct' && arrowAction(from, to, { system: true })) || 'platform_sync', journey, journey.failReason);
    changed = true;
    if (revive) {
      // Cột `lost_*` đã tự xoá theo luật của `updatePackage` (D14); tồn không đổi (đã trừ lúc bàn giao).
      await updatePackage(pkg.id, { needsAttention: true, flagNote: `Sàn báo ${to} sau khi người dùng chuyển ${from}` });
      pkg.needsAttention = true;
      revived = true;
      logger.warn({ packageId: pkg.id, from, to }, 'sàn kéo lại kiện do người dùng chuyển');
    }
  }
  if (remote === 'return_failed' && !pkg.needsAttention) {
    await updatePackage(pkg.id, { needsAttention: true, flagNote: 'Sàn báo hoàn hàng thất bại' });
    pkg.needsAttention = true;
    changed = true;
  }
  return { changed, revived };
}

/**
 * Sàn huỷ cả kiện: chưa đóng gói thì huỷ và nhả hàng; đã đóng gói thì chờ mở (`needs_open`, mở là #106); đã rời kho
 * thì để kiện chạy tiếp (Documents/21 §19.1, #105 A5). Kiện đang chờ mở để sửa hay vì kiểm kê thì `markWholePendingDrop`
 * (bên gọi) nâng mục đích lên `cancel`.
 */
export async function cancelPlatformPackage(order: PlatformPackageOrder, pkg: PackageRow): Promise<'cancelled' | 'needs_open' | 'handed_over'> {
  if (pkg.status === 'cancelled') return 'cancelled';
  if (isHandedOver(pkg.status)) return 'handed_over';
  if (isSealed(pkg.status)) {
    if (!pkg.needsOpen) {
      await updatePackage(pkg.id, { needsOpen: true, openPurpose: 'cancel' });
      Object.assign(pkg, { needsOpen: true, openPurpose: 'cancel' });
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

/** Sàn huỷ món (spec 205 D17): huỷ vì giao không thành là kiện hoàn về (spec 199c D2), không phải huỷ dòng. */
const isLineCancel = (l: PlatformPackageLine) => l.status === 'cancelled' && l.cancelKind !== 'failed_delivery';

/**
 * Gỡ món sàn huỷ khỏi kiện chưa đóng gói (spec 205 §5.10): nhả phần đang giữ của dòng, xoá dòng, xếp lượt phân hàng cho
 * SKU vừa nhả và SKU còn lại (kiện thiếu hàng bớt món có thể giữ đủ). Kiện giữ trạng thái; lịch sử `drop_lines` (D20).
 */
async function dropLines(pkg: PackageRow, dropped: readonly CancelLine[]) {
  const held = dropped.filter((l) => l.variantId && l.reservedQty > 0);
  if (held.length) await stockPort().release(pkg.id, held.map((l) => ({ variantId: l.variantId!, quantity: l.reservedQty })));
  await deleteLines(dropped.map((l) => l.id));
  const ids = new Set(dropped.map((l) => l.id));
  pkg.lines = pkg.lines.filter((l) => !ids.has(l.id));
  const variantIds = [...new Set([...dropped, ...pkg.lines].flatMap((l) => (l.variantId ? [l.variantId] : [])))].sort();
  if (variantIds.length) await requestAllocation(variantIds);
  await updatePackage(pkg.id, {});
  await recordTransition({
    entityType: 'packages',
    entityId: pkg.id,
    from: pkg.status,
    to: pkg.status,
    action: 'drop_lines',
    actorId: null,
    source: 'marketplace',
    reason: `Sàn huỷ ${dropped.reduce((n, l) => n + l.quantity, 0)} món`,
  });
}

/**
 * Đánh dấu chờ bỏ món sàn huỷ ở kiện đã đóng gói (spec 205 §5.10): kiện vẫn giữ hàng, chờ mở (`edit`); kiện đang chờ mở
 * thì giữ mục đích cũ, chỉ tăng `version`.
 */
async function markPendingDrop(pkg: PackageRow, fresh: readonly CancelLine[]) {
  await setPendingDrop(fresh.map((l) => l.id));
  const ids = new Set(fresh.map((l) => l.id));
  for (const l of pkg.lines) if (ids.has(l.id)) l.pendingDropQty = l.quantity;
  await updatePackage(pkg.id, pkg.needsOpen ? {} : { needsOpen: true, openPurpose: 'edit' });
  if (!pkg.needsOpen) Object.assign(pkg, { needsOpen: true, openPurpose: 'edit' });
}

/**
 * Sàn huỷ cả kiện đã đóng gói (spec 205 §5.10, D21): mọi dòng chờ bỏ; kiện đang chờ mở để sửa (`edit`) hay vì kiểm kê
 * (`stocktake`, huỷ thắng, spec #238 mục 10) thì chuyển sang chờ mở để huỷ: kho mở ra là huỷ (`open_cancel`), không về
 * `reserved`. Trả true khi có ghi.
 */
async function markWholePendingDrop(pkg: PackageRow): Promise<boolean> {
  let changed = false;
  if (pkg.lines.some((l) => l.pendingDropQty < l.quantity)) {
    await setPendingDropAll(pkg.id);
    for (const l of pkg.lines) l.pendingDropQty = l.quantity;
    changed = true;
  }
  if (pkg.openPurpose === 'edit' || pkg.openPurpose === 'stocktake') {
    await updatePackage(pkg.id, { openPurpose: 'cancel' });
    pkg.openPurpose = 'cancel';
    changed = true;
  }
  return changed;
}

/** Nhóm món sàn của một lượt kéo: theo mã kiện sàn, món chưa có mã theo kiện app chứa nó (`code` rỗng). */
interface PlatformGroup {
  code: string;
  lines: PlatformPackageLine[];
}

const isLive = (p: PackageRow) => p.status !== 'cancelled';

/**
 * Kiện chứa từng dòng đơn: chủ (kiện sống có dòng sống của dòng đơn, spec #238 §5.6) thắng; dòng đơn không có chủ thì
 * kiện cuối (theo mã) còn chứa dòng của nó, kể cả kiện đã huỷ hay dòng chờ bỏ (như trước #238: món đã huỷ ở lượt trước
 * vẫn theo kiện đã huỷ của nó, không lập kiện mới). Sau khi chia lại, món có kiện cũ đã huỷ và kiện mới: kiện mới thắng.
 */
function ownersOf(packages: readonly PackageRow[]): Map<string, PackageRow> {
  const owner = new Map<string, PackageRow>();
  for (const p of packages) for (const l of p.lines) owner.set(l.orderLineId, p);
  for (const p of packages.filter(isLive)) for (const l of p.lines) if (l.pendingDropQty === 0) owner.set(l.orderLineId, p);
  return owner;
}

/** Món xử lý bằng huỷ dòng (spec 205 D16): kiện chỉ có một phần món bị huỷ. Luật thuần, không ghi. */
function lineCancelHandled(packages: readonly PackageRow[], lines: readonly PlatformPackageLine[]): Set<string> {
  const cancelledIds = new Set(lines.filter(isLineCancel).map((l) => l.orderLineId));
  const handled = new Set<string>();
  for (const pkg of packages) {
    const plan = planLineCancel(pkg.status, pkg.lines, cancelledIds);
    if (plan.kind === 'drop' || plan.kind === 'pending') for (const l of plan.lines) handled.add(l.orderLineId);
  }
  return handled;
}

/**
 * Gom món: món chưa có mã kiện sàn mà đã nằm trong kiện app thì theo kiện đó (spec 205 D10): sàn chưa nói gì về cách
 * chia, nên cách chia của app (tách kiện) là đúng. Món có mã sàn gom theo mã. Món xử lý bằng huỷ dòng, và món đã huỷ ở
 * lượt trước không còn kiện nào chứa (D18), không vào nhóm. Khoá: mã sàn, không mã thì `\u0000<id kiện app>`.
 */
function groupsOf(packages: readonly PackageRow[], lines: readonly PlatformPackageLine[]): Map<string, PlatformGroup> {
  const handled = lineCancelHandled(packages, lines);
  const owner = ownersOf(packages);
  const groups = new Map<string, PlatformGroup>();
  for (const l of lines) {
    if (handled.has(l.orderLineId) || (l.alreadyCancelled && !owner.has(l.orderLineId))) continue;
    const key = l.packageCode || `\u0000${owner.get(l.orderLineId)?.id ?? ''}`;
    const group = groups.get(key) ?? { code: l.packageCode || '', lines: [] };
    group.lines.push(l);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Đầu vào của luật chia lại (spec #238 §5.6): mọi kiện của đơn (bỏ dòng của món xử lý bằng huỷ dòng: lượt này gỡ hoặc
 * chờ bỏ chúng) và nhóm xét chia lại: có mã, trạng thái biết và khác `cancelled`, có món mà chủ là kiện sống.
 */
function resplitInput(packages: readonly PackageRow[], lines: readonly PlatformPackageLine[], groups: ReadonlyMap<string, PlatformGroup>) {
  const handled = lineCancelHandled(packages, lines);
  const owned = new Set(
    packages.filter(isLive).flatMap((p) => p.lines.filter((l) => l.pendingDropQty === 0 && !handled.has(l.orderLineId)).map((l) => l.orderLineId)),
  );
  const considered: ResplitGroup[] = [];
  for (const { code, lines: group } of groups.values()) {
    const status = groupStatus(group);
    if (!code || status === null || status === 'cancelled' || !group.some((l) => owned.has(l.orderLineId))) continue;
    considered.push({ code, lines: group.map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity })) });
  }
  const resplitPackages: ResplitPackage[] = packages.map((p) => ({
    id: p.id,
    code: p.code,
    status: p.status,
    platformPackageCode: p.platformPackageCode,
    lines: p.lines
      .filter((l) => !handled.has(l.orderLineId))
      .map((l) => ({ id: l.id, orderLineId: l.orderLineId, quantity: l.quantity, pendingDropQty: l.pendingDropQty })),
  }));
  return { packages: resplitPackages, groups: considered };
}

/** Kiện nhận nhóm vì khớp theo tập (bước 1 của luật): tập dòng sống bằng tập món của nhóm. */
function matchesBySet(pkg: ResplitPackage, group: ResplitGroup): boolean {
  const key = (lines: readonly { orderLineId: string; quantity: number }[]) => {
    const qty = new Map<string, number>();
    for (const l of lines) qty.set(l.orderLineId, (qty.get(l.orderLineId) ?? 0) + l.quantity);
    return [...qty].map(([id, q]) => `${id}:${q}`).sort().join('|');
  };
  return key(pkg.lines.filter((l) => l.pendingDropQty === 0)) === key(group.lines);
}

/**
 * Đồng bộ kiện của một đơn sàn với các món sàn trả về. `nextCode` cấp mã kiện mới (`KH-000001`), do `sales` giữ bộ
 * đếm. Trả trạng thái các kiện sau khi áp, để đơn suy cờ và quyết định huỷ.
 *
 * Sàn chia lại kiện (spec #238 §5.6): xem trước kế hoạch trên kiện đọc không khoá; có bước thì lấy khoá advisory phân
 * hàng **trước** khi khoá kiện (thứ tự đơn → advisory → kiện), lập lại kế hoạch trên kiện đã khoá rồi thi hành. Kế hoạch
 * mới có bước mà lượt chưa lấy advisory (dữ liệu đổi giữa hai lần đọc): không thi hành, để lượt sau.
 */
export async function syncPlatformPackages(
  order: PlatformPackageOrder,
  lines: readonly PlatformPackageLine[],
  nextCode: () => Promise<string>,
): Promise<PlatformPackagesResult & { cancelled: ('cancelled' | 'needs_open' | 'handed_over')[] }> {
  const unlocked = await readOrderPackages(order.id);
  const previewInput = resplitInput(unlocked, lines, groupsOf(unlocked, lines));
  const allocationLocked = pendingSteps(planResplit(previewInput.packages, previewInput.groups), unlocked).length > 0;
  if (allocationLocked) await takeAllocationLock(requireCompanyId('syncPlatformPackages'));

  const existing = await lockOrderPackages(order.id);
  // Gom nhóm trước khi ghi huỷ dòng: món huỷ dòng tính bằng luật thuần trên dòng chưa đổi.
  const groups = groupsOf(existing, lines);
  const result = {
    changed: false,
    resplit: false,
    unknown: false,
    revived: false,
    cancelled: [] as ('cancelled' | 'needs_open' | 'handed_over')[],
    cancelledLines: [] as string[],
  };

  // Huỷ dòng xét theo từng kiện, trước khi gom nhóm (spec 205 D16): món huỷ có thể không còn mang mã kiện sàn và rơi vào
  // nhóm riêng chỉ gồm món huỷ, nhóm đó sẽ huỷ cả kiện dù kiện còn món sống. Kiện huỷ hết món thì để đường huỷ cả kiện.
  const cancelledIds = new Set(lines.filter(isLineCancel).map((l) => l.orderLineId));
  for (const pkg of existing) {
    const plan = planLineCancel(pkg.status, pkg.lines, cancelledIds);
    if (plan.kind === 'none' || plan.kind === 'whole') continue;
    if (plan.kind === 'drop') {
      await dropLines(pkg, plan.lines);
      result.changed = true;
    } else if (plan.fresh.length) {
      await markPendingDrop(pkg, plan.fresh);
      result.changed = true;
    }
    result.cancelledLines.push(...plan.lines.map((l) => l.orderLineId));
  }

  const events = order.packageEvents ?? [];
  const journeyOf = (code: string, group: readonly PlatformPackageLine[]) =>
    // Hành trình kiện của nhóm (spec 199c §5.4): khớp mã kiện sàn rồi mã vận đơn, một lần mỗi nhóm; mốc thiếu/lai `now`.
    journeyTimes(eventsOf(events, { platformPackageCode: code || null, trackingCode: group.find((l) => l.trackingCode)?.trackingCode ?? null }), new Date());

  // Kế hoạch chia lại trên kiện đã khoá, sau huỷ dòng.
  const input = resplitInput(existing, lines, groups);
  const considered = new Set(input.groups.map((g) => g.code));
  let plan = planResplit(input.packages, input.groups);
  let steps = pendingSteps(plan, existing);
  if (steps.length && (!allocationLocked || steps.some((s) => s.kind === 'mark_drop'))) {
    // Chưa giữ advisory (thứ tự khoá: không lấy advisory sau khi đã khoá kiện) hoặc có kiện đã đóng phải chờ dỡ (Task 3):
    // chỉ nhận nhóm khớp theo tập, nhóm khác bỏ qua tới lượt sau, không bật cờ.
    logger.warn({ orderId: order.id, steps: steps.map((s) => s.kind) }, 'chia lại kiện để lượt sau');
    const targets = new Map(
      [...plan.targets].filter(([code, id]) => {
        const pkg = input.packages.find((p) => p.id === id)!;
        return matchesBySet(pkg, input.groups.find((g) => g.code === code)!);
      }),
    );
    plan = { targets, steps: [], resplit: false };
    steps = [];
  }
  if (plan.resplit) logger.warn({ orderId: order.id, steps: steps.map((s) => s.kind) }, 'sàn chia lại kiện, app không tự xử lý được');
  let created = new Map<string, PackageRow>();
  if (steps.length) {
    const applied = await applyResplit(order, plan, existing, async (code, replacesPackageId, awaitingOpen) => {
      const group = groups.get(code)!.lines;
      return createPackage(order, await nextCode(), groupStatus(group)!, group, journeyOf(code, group), {
        replacesPackageId,
        replacesCode: existing.find((p) => p.id === replacesPackageId)!.code,
        hold: !awaitingOpen,
      });
    });
    created = applied.created;
    if (applied.releasedVariantIds.length) await requestAllocation(applied.releasedVariantIds);
    logger.info({ orderId: order.id, steps: steps.map((s) => s.kind) }, 'áp kế hoạch sàn chia lại kiện');
    result.changed = true;
  }
  result.resplit ||= plan.resplit;

  const owner = ownersOf(existing);
  const touched = new Set<string>();
  for (const { code, lines: group } of groups.values()) {
    const status = groupStatus(group);
    const journey = journeyOf(code, group);
    let pkg: PackageRow | undefined;
    if (considered.has(code)) {
      // Nhóm xét chia lại: kiện nhận nhóm theo kế hoạch, hoặc kiện vừa lập; không có (bị cờ, để lượt sau) thì bỏ qua.
      const target = plan.targets.get(code);
      pkg = target ? existing.find((p) => p.id === target) : created.get(code);
      if (!pkg) continue;
    } else pkg = (code && existing.find((p) => p.platformPackageCode === code)) || owner.get(group[0]!.orderLineId);
    if (pkg && code && pkg.platformPackageCode === null) {
      await updatePackage(pkg.id, { platformPackageCode: code });
      pkg.platformPackageCode = code;
      result.changed = true;
    }
    if (!pkg) {
      // Nhóm `cancelled` hay trạng thái lạ có món đang thuộc kiện khác (nhóm xét chia lại đã đi kế hoạch ở trên).
      if (group.some((l) => owner.has(l.orderLineId))) {
        result.resplit = true;
        continue;
      }
      if (status === null) {
        result.unknown = true;
        continue;
      }
      // Đơn lần đầu thấy đã có món sàn huỷ (spec 205 D23): kiện sắp lập chưa rời kho thì món huỷ không vào kiện, sales
      // ghi `cancelled_qty`; lượt sau món đó không còn chủ nên bỏ qua (D18). Kiện lần đầu thấy đã rời kho giữ đủ món (E96).
      const dropped = status === 'pending' || status === 'packed' || status === 'awaiting_pickup' ? group.filter(isLineCancel) : [];
      pkg = await createPackage(order, await nextCode(), status, dropped.length ? group.filter((l) => !dropped.includes(l)) : group, journey);
      existing.push(pkg);
      touched.add(pkg.id);
      result.changed = true;
      result.cancelledLines.push(...dropped.map((l) => l.orderLineId));
      if (status === 'cancelled') {
        result.cancelled.push('cancelled');
        result.cancelledLines.push(...group.map((l) => l.orderLineId));
      } else if (allCancelled(group)) result.cancelled.push('handed_over');
      continue;
    }
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
      const outcome = await cancelPlatformPackage(order, pkg);
      result.cancelled.push(outcome);
      if ([pkg.status, pkg.needsOpen].join() !== before) result.changed = true;
      // Kiện chưa rời kho bị huỷ cả kiện: mọi món của kiện là món sàn huỷ (spec 205 §5.10). Kiện đã đóng gói thì mọi dòng
      // chờ bỏ tới khi mở (D21).
      if (outcome !== 'handed_over') result.cancelledLines.push(...pkg.lines.map((l) => l.orderLineId));
      if (outcome === 'needs_open' && (await markWholePendingDrop(pkg))) result.changed = true;
    } else {
      const applied = await applyStatus(order, pkg, status, journey);
      if (applied.changed) result.changed = true;
      if (applied.revived) result.revived = true;
      // Sàn huỷ món vì giao không thành (D2): kiện đi tiếp sang `returning`; báo `handed_over` như kiện đã rời kho bị
      // sàn huỷ để sales bật cờ `platform_cancelled`, không huỷ đơn (spec 199c §5.4, 25 §8.2).
      if (allCancelled(group)) result.cancelled.push('handed_over');
    }
  }
  return { ...result, statuses: existing.map((p) => p.status) };
}
