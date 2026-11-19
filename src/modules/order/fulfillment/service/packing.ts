import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { packageMachine, type PackageAction, type PackageStatus } from '../domain/package.ts';
import {
  buildPickList, packGroupBlockers, readyGroupBlockers, scanMismatch, type ScannedLine, type ScannedUntrackedLine,
} from '../domain/packing.ts';
import { lockPackingPackage, lockReadyPackages, packageGroupOf, pickListBase, platformItemsOf, readPackingPackage, setLinesPacked, type PackingPackage } from '../repository/packing.ts';
import { clearPendingDrop, deleteLines } from '../repository/line-cancel.ts';
import { awaitingReplacementIds, takeAllocationLock } from '../repository/allocation.ts';
import { markLinesReserved, packageShopOf, setReserved, updatePackage } from '../repository/packages.ts';
import type { Actor } from './actor.ts';
import { holdOrderReplacements, requestAllocation } from './allocation.ts';
import {
  cancelledOrderSettlerOf, getPackage, marketplacePackagesOf, orderRefsLookupOf, stockHoldLookupOf, type FulfillmentContext, type MarketplacePackages,
} from './packages.ts';
import { stockPort } from './stock-port.ts';
import { type PackageOrderRef, type PackageVariantRef, packageVariantsOf } from './views.ts';

const PICK_LIST_LIMIT = 500;
export const PACKAGE_LOCK_WAIT_MS = 10_000;
export type PackageDetail = Awaited<ReturnType<typeof getPackage>>;
type PackingAction = Extract<PackageAction, 'pack' | 'mark_ready' | 'open' | 'open_cancel'>;
type PackageIdentity = Pick<PackingPackage, 'id' | 'orderId' | 'status'>;
type Group = Awaited<ReturnType<typeof packageGroupOf>>;
const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');
/**
 * Kiện đang có cờ Cần mở (dỡ kiện về kệ) không báo sẵn sàng giao, không quét bàn giao (spec #238 D28): kiểm ở service, sau
 * `version` và máy trạng thái, không là guard của máy (bàn giao không nạp `record`).
 */
export const awaitingOpen = () => new AppError(409, 'awaiting_open', 'Kiện đang chờ dỡ kiện về kệ, mở kiện trước');
/**
 * Kiện chờ thay (spec #238 D9) cũng không báo sẵn sàng, không quét bàn giao: hàng của nó còn trong kiện cũ chờ dỡ, kiện
 * cũ vẫn giữ phần đó (review #393: quét trước rồi sàn báo rời kho làm kẹt số đang giữ). Cùng mã `awaiting_open`.
 */
/**
 * Khách đang xin huỷ (cờ `cancel_requested` của đơn, hay sàn báo khi app chưa kịp thấy cờ): báo giao phải chờ Sale trả lời.
 * Không bật `label_error`: bấm lại không giúp (#239 KH-B07).
 */
const cancelRequestedError = () =>
  new AppError(409, 'cancel_requested', 'Khách đang xin huỷ đơn, chờ Sale trả lời yêu cầu huỷ rồi mới báo sàn sẵn sàng giao');
export const awaitingReplacedOpen = () =>
  new AppError(409, 'awaiting_open', 'Kiện thay đang chờ kho mở kiện cũ (sàn chia lại kiện), mở kiện cũ trước');

/** Kiện `id` còn là kiện chờ thay thì ném `awaiting_open`. */
export async function assertNotAwaitingReplaced(id: string): Promise<void> {
  if ((await awaitingReplacementIds([id])).length) throw awaitingReplacedOpen();
}

export async function pickList(ctx: FulfillmentContext, ids: readonly string[] | undefined) {
  const { rows, packageIds, truncated } = await pickListBase(ids ? { ids } : { limit: PICK_LIST_LIMIT });
  const [orders, variants] = rows.length
    ? await Promise.all([orderRefsLookupOf(ctx)([...new Set(rows.map((row) => row.orderId))]), packageVariantsOf([{ lines: rows }])])
    : [new Map<string, PackageOrderRef>(), new Map<string, PackageVariantRef>()];
  // Dòng đã ghép nhặt theo biến thể app (SKU, tên, nhãn của app); chưa ghép hay "không quản tồn" theo SKU sàn (21 §19.2).
  const items = buildPickList(rows.map(({ packageId, orderId, orderLineId, variantId, stockUntracked, quantity }) => {
    const line = orders.get(orderId)?.lines.get(orderLineId);
    if (!line) throw new Error(`Không tìm thấy dòng đơn ${orderLineId} của kiện ${packageId}`);
    const variant = variantId ? variants.get(variantId) : undefined;
    return {
      packageId, variantId, untracked: stockUntracked, quantity,
      sku: variant?.sku ?? line.sku,
      productName: variant?.productName ?? line.productName,
      attributesLabel: variant?.attributesLabel || line.attributesLabel,
    };
  }));
  return { items, packageCount: packageIds.length, truncated };
}

export async function carriersOf(ctx: FulfillmentContext, companyId: string, id: string) {
  if (!isUuid(id)) throw notFound();
  const target = await withCompany(companyId, async () => {
    const pkg = await packageShopOf(id);
    if (!pkg) throw notFound();
    return pkg.shopId ? { shopId: pkg.shopId, items: await platformItemsOf(id) } : null;
  });
  return { items: target ? await marketplacePackagesOf(ctx).carriers(companyId, target.shopId, target.items) : [] };
}

export async function versionConflict(ctx: FulfillmentContext, id: string): Promise<never> {
  throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: await getPackage(ctx, id) });
}

export async function withPackageLock<T>(
  ctx: FulfillmentContext, companyId: string, id: string, fn: () => Promise<T>, additionalKeys: readonly string[] = [],
): Promise<T> {
  if (!isUuid(id)) throw notFound();
  const result = await withSessionLock(`fulfillment.package:${id.toLowerCase()}`, async () => ({ value: await fn() }), {
    waitMs: PACKAGE_LOCK_WAIT_MS, additionalKeys,
  });
  if (result === 'busy') return withCompany(companyId, () => versionConflict(ctx, id));
  return result.value;
}

async function readPackage(id: string, lock = false): Promise<PackingPackage> {
  const pkg = await (lock ? lockPackingPackage(id) : readPackingPackage(id));
  if (!pkg) throw notFound();
  return pkg;
}

async function checkVersion(ctx: FulfillmentContext, pkg: Pick<PackingPackage, 'id' | 'version'>, expected: number) {
  if (pkg.version !== expected) await versionConflict(ctx, pkg.id);
}

async function transition(ctx: FulfillmentContext, actor: Actor, pkg: PackingPackage, action: PackingAction) {
  const order = (await orderRefsLookupOf(ctx)([pkg.orderId])).get(pkg.orderId);
  if (!order) throw new Error(`Kiện ${pkg.id} không có đơn ${pkg.orderId}`);
  return assertTransition(packageMachine, pkg.status, action, {
    actor,
    record: { source: order.source, selfDelivery: pkg.selfDelivery, orderStatus: order.status },
  });
}

async function otherGroupMembers(pkg: Pick<PackingPackage, 'id' | 'shopId' | 'platformPackageCode'>): Promise<Group> {
  if (!pkg.shopId || !pkg.platformPackageCode) return [];
  return (await packageGroupOf(pkg.shopId, pkg.platformPackageCode)).filter((member) => member.id !== pkg.id);
}

function checkGroup(blockers: string[]) {
  if (blockers.length) {
    throw new AppError(409, 'package_group_not_ready', `Gói gộp còn kiện chưa sẵn sàng: ${blockers.join(', ')}`);
  }
}

async function recordPacking(pkg: PackageIdentity, to: PackageStatus, action: PackingAction, actorId: string) {
  await recordTransition({ entityType: 'packages', entityId: pkg.id, from: pkg.status, to, action, actorId });
  await publishEvent({
    type: 'fulfillment.package_status_changed',
    aggregateId: pkg.orderId,
    payload: { packageId: pkg.id, orderId: pkg.orderId, from: pkg.status, to },
  });
}

export async function packPackage(
  ctx: FulfillmentContext, actor: Actor, id: string, input: {
    version: number; lines: ScannedLine[]; untrackedLines?: ScannedUntrackedLine[] | undefined; carrierCode?: string | undefined;
  },
): Promise<PackageDetail> {
  const { companyId } = actor;
  return withPackageLock(ctx, companyId, id, async () => {
    const target = await withCompany(companyId, async () => {
      const pkg = await readPackage(id);
      await checkVersion(ctx, pkg, input.version);
      await transition(ctx, actor, pkg, 'pack');
      const errors = scanMismatch(pkg.lines, input.lines, input.untrackedLines ?? []);
      if (errors) throw new AppError(422, 'scan_mismatch', 'Số món quét chưa khớp với kiện', { errors });

      const others = await otherGroupMembers(pkg);
      if (others.length) {
        const orders = await orderRefsLookupOf(ctx)(others.map((member) => member.orderId));
        checkGroup(packGroupBlockers(others.map((member) => ({ ...member, orderStatus: orders.get(member.orderId)?.status ?? 'cancelled' }))));
      }
      // Kiện giữ vận đơn sau khi mở (spec #238 D25): sàn vẫn giữ gói, mã và vận đơn cũ; đóng gói lại không gọi sàn.
      return pkg.shopId && !pkg.waybillKept ? { shopId: pkg.shopId, items: await platformItemsOf(id) } : null;
    });

    const result = target ? await marketplacePackagesOf(ctx).pack(companyId, target.shopId, {
      ...target.items, ...(input.carrierCode !== undefined && { carrierCode: input.carrierCode }),
    }) : null;

    try {
      return await withCompany(companyId, async () => {
        const pkg = await readPackage(id, true);
        if (pkg.version !== input.version && pkg.status === 'packed' && (!result || pkg.platformPackageCode === result.packageCode)) {
          return getPackage(ctx, id);
        }
        await checkVersion(ctx, pkg, input.version);
        const { to } = await transition(ctx, actor, pkg, 'pack');
        if (result && pkg.platformPackageCode && pkg.platformPackageCode !== result.packageCode) {
          logger.warn({ packageId: id, platformPackageCode: result.packageCode }, 'sàn đổi mã kiện khi đóng gói');
        }
        await updatePackage(id, {
          status: to, packedBy: actor.accountId, packedAt: new Date(), labelError: false,
          // Giữ vận đơn: không ghi đè mã kiện sàn, vận đơn, ĐVVC (D25).
          ...(!pkg.waybillKept && { carrierCode: result?.carrier?.code ?? null, carrierName: result?.carrier?.name ?? null }),
          ...(result && { platformPackageCode: result.packageCode }),
          ...(result?.trackingCode != null && { trackingCode: result.trackingCode }),
        });
        await setLinesPacked(id, true);
        await recordPacking(pkg, to, 'pack', actor.accountId);
        return getPackage(ctx, id);
      });
    } catch (err) {
      if (result) logger.error({ err, packageId: id, platformPackageCode: result.packageCode }, 'sàn đã đóng gói, app chưa ghi; lượt kéo đơn sẽ khớp');
      throw err;
    }
  });
}

export async function markReady(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail> {
  const { companyId } = actor;
  if (!isUuid(id)) throw notFound();
  const candidate = await withCompany(companyId, () => readPackage(id));
  // Hai kiện trong cùng nhóm có thể được bấm từ hai màn khác nhau. Khoá chung mã sàn trước khi kiểm phiên bản.
  const groupKeys = candidate.shopId && candidate.platformPackageCode
    ? [`fulfillment.ready:${candidate.shopId}:${candidate.platformPackageCode}`]
    : [];
  return withPackageLock(ctx, companyId, id, async () => {
    const target = await withCompany(companyId, async () => {
      const pkg = await readPackage(id);
      await checkVersion(ctx, pkg, input.version);
      if (pkg.shopId !== candidate.shopId || pkg.platformPackageCode !== candidate.platformPackageCode) {
        await versionConflict(ctx, id);
      }
      await transition(ctx, actor, pkg, 'mark_ready');
      if (pkg.needsOpen) throw awaitingOpen();
      const others = await otherGroupMembers(pkg);
      // Đơn của kiện bấm hay của kiện khác trong nhóm gói đang có khách xin huỷ: sàn sẽ từ chối, chặn trước khi gọi.
      const orders = await orderRefsLookupOf(ctx)([...new Set([pkg.orderId, ...others.map((member) => member.orderId)])]);
      if ([...orders.values()].some((order) => order.cancelRequested)) throw cancelRequestedError();
      // Kiện chờ thay (của kiện bấm, hay của kiện khác trong nhóm gói): chưa báo sẵn sàng được.
      const replaced = await awaitingReplacementIds([pkg.id, ...others.map((member) => member.id)]);
      if (replaced.includes(pkg.id)) throw awaitingReplacedOpen();
      const waitingMembers = others.filter((member) => member.status === 'packed' && replaced.includes(member.id)).map((member) => member.code);
      checkGroup([...readyGroupBlockers(others), ...waitingMembers]);
      if (pkg.shopId && !pkg.platformPackageCode) {
        throw new AppError(409, 'rts_package_not_found', 'Sàn chưa cấp mã kiện cho đơn này (đơn còn chờ sàn duyệt). Kéo đơn ngay rồi thử lại');
      }
      return {
        shopId: pkg.shopId, code: pkg.platformPackageCode, ids: [pkg.id, ...others.map((member) => member.id)], waybillKept: pkg.waybillKept,
      };
    });

    // Kiện giữ vận đơn sau khi mở (spec #238 D25): sàn đã có vận đơn cũ, chỉ chuyển `packed → awaiting_pickup` trong app
    // (`updatePackage` tự tắt `waybill_kept`). Sàn cấp mã vận đơn ngay sau khi báo giao (TikTok, KH-B02) thì ghi ở bước sau.
    let trackingCode: string | null = null;
    if (target.shopId && target.code && !target.waybillKept) {
      try {
        ({ trackingCode } = await marketplacePackagesOf(ctx).readyToShip(companyId, target.shopId, target.code));
      } catch (err) {
        if (err instanceof AppError && err.code === 'cancel_requested') throw err;
        await withCompany(companyId, async () => {
          const pkg = await lockPackingPackage(id);
          if (pkg?.status === 'packed') await updatePackage(id, { labelError: true });
        }).catch((flagError: unknown) => {
          logger.error({ err: flagError, packageId: id, platformPackageCode: target.code }, 'không lưu được cờ lỗi lấy vận đơn');
        });
        throw err;
      }
    }

    try {
      return await withCompany(companyId, async () => {
        const members = await lockReadyPackages(target.ids);
        const pkg = members.find((member) => member.id === id.toLowerCase());
        if (!pkg) throw notFound();
        const alreadyReady = pkg.status === 'awaiting_pickup' && pkg.platformPackageCode === target.code && pkg.shopId === target.shopId;
        if (!alreadyReady) await checkVersion(ctx, pkg, input.version);
        for (const member of members) {
          if (member.status === 'awaiting_pickup' && member.platformPackageCode === target.code && member.shopId === target.shopId) continue;
          if (member.status !== 'packed' || member.platformPackageCode !== target.code || member.shopId !== target.shopId) {
            logger.warn({ packageId: member.id, platformPackageCode: target.code }, 'kiện trong nhóm đã đổi khi báo sẵn sàng giao');
            continue;
          }
          // Mã vận đơn sàn trả ghi lên mọi kiện vừa chuyển của nhóm; sàn chưa cấp thì giữ mã cũ (Lazada có từ lúc pack).
          await updatePackage(member.id, { status: 'awaiting_pickup', labelError: false, ...(trackingCode !== null && { trackingCode }) });
          await recordPacking(member, 'awaiting_pickup', 'mark_ready', actor.accountId);
        }
        return getPackage(ctx, id);
      });
    } catch (err) {
      if (target.shopId) logger.error({ err, packageId: id, platformPackageCode: target.code }, 'sàn đã nhận báo giao, app chưa ghi; lượt kéo đơn sẽ khớp');
      throw err;
    }
  }, groupKeys);
}

/** Sàn huỷ mọi món của kiện (spec 205 D21): mở kiện là huỷ kiện (`open_cancel`), không giữ lại, không gọi repack. */
const allPendingDrop = (pkg: PackingPackage) => pkg.lines.length > 0 && pkg.lines.every((line) => line.pendingDropQty > 0);

/** Nhả phần đang giữ của các dòng (dòng đã ghép SKU); trả SKU vừa nhả để xếp lượt phân hàng. */
async function releaseLines(id: string, lines: PackingPackage['lines']): Promise<string[]> {
  const held = lines.filter((line) => line.variantId !== null && line.reservedQty > 0);
  if (held.length) await stockPort().release(id, held.map((line) => ({ variantId: line.variantId!, quantity: line.reservedQty })));
  return held.map((line) => line.variantId!);
}

export async function openPackage(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail> {
  const { companyId } = actor;
  return withPackageLock(ctx, companyId, id, async () => {
    const target = await withCompany(companyId, async () => {
      const shop = await packageShopOf(id);
      if (!shop) throw notFound();
      const awaitingStocktake = shop.shopId !== null && (await stockHoldLookupOf(ctx)([shop.shopId], { lock: true })).has(shop.shopId);
      const pkg = await readPackage(id, true);
      await checkVersion(ctx, pkg, input.version);
      // Kiện đã báo sàn sẵn sàng giao chỉ mở khi có cờ Cần mở (dỡ kiện về kệ, spec #238 §5.6, D25).
      if (pkg.status === 'awaiting_pickup' && !pkg.needsOpen) {
        throw new AppError(409, 'invalid_transition', 'Kiện đã báo sàn sẵn sàng giao, không có việc dỡ kiện về kệ');
      }
      // Giữ vận đơn (D25): kiện `awaiting_pickup` hay đã giữ vận đơn từ lần mở trước, không gọi `repack`. Mở để chia lại
      // (`resplit`) mà còn món thì gói cũ còn trên sàn với phần còn lại (sàn giữ mã cũ): `repack` như kiện sửa (D24), không
      // thì lần đóng gói sau gọi `pack` của sàn trên gói đã đóng. Mọi món đã chuyển đi thì đi `open_cancel`, không gọi.
      const keepWaybill = pkg.status === 'awaiting_pickup' || pkg.waybillKept;
      const plan = { purpose: pkg.openPurpose, keepWaybill };
      if (allPendingDrop(pkg)) {
        await transition(ctx, actor, pkg, 'open_cancel');
        return { shopId: null, code: null, version: pkg.version, cancel: true, ...plan };
      }
      await transition(ctx, actor, pkg, 'open');

      // Dòng chờ bỏ (món sàn đã huỷ, spec 205 §5.10) sẽ bị xoá ở bước ghi: không giữ thêm hàng cho chúng.
      const missing = pkg.lines.filter((line) => line.variantId !== null && line.pendingDropQty === 0 && line.reservedQty < line.quantity);
      if (missing.length) {
        if (awaitingStocktake) throw new AppError(409, 'shop_awaiting_stocktake', 'Gian hàng đang chờ kiểm kê đầu kỳ');
        const { reserved } = await stockPort().reserve(id, missing.map((line) => ({ variantId: line.variantId!, quantity: line.quantity - line.reservedQty })));
        if (!reserved) throw new AppError(422, 'insufficient_stock', 'Không đủ hàng để giữ lại cả kiện, chờ hàng về rồi mở');
        await markLinesReserved(missing.map((line) => line.id));
        await updatePackage(id, { reservedAt: new Date() });
        const variantIds = [...new Set(pkg.lines.flatMap((line) => line.variantId ? [line.variantId] : []))].sort();
        await publishEvent({ type: 'fulfillment.allocation_done', aggregateId: companyId, payload: { variantIds } });
      }
      return {
        shopId: pkg.shopId, code: pkg.platformPackageCode, version: pkg.version + Number(missing.length > 0), cancel: false, ...plan,
      };
    });

    // Sàn đã huỷ gói khi mọi món bị huỷ: gọi đóng gói lại chỉ nhận lỗi (D21). Giữ vận đơn (D25): không gọi.
    const outcome: Awaited<ReturnType<MarketplacePackages['repack']>> | null = !target.cancel && !target.keepWaybill && target.shopId && target.code
      ? await marketplacePackagesOf(ctx).repack(companyId, target.shopId, target.code)
      : null;
    let written: { detail: PackageDetail; cancelledOrderId: string | null };
    try {
      written = await withCompany(companyId, async () => {
        // Mở để chia lại (D26): khoá advisory phân hàng trước khi khoá kiện (thứ tự khoá §5.10) để giữ ngay cho kiện thay.
        // `version` không đổi từ bước kiểm nên mục đích không đổi; lệch thì `version_conflict`.
        const resplit = target.purpose === 'resplit';
        if (resplit) await takeAllocationLock(companyId);
        const pkg = await readPackage(id, true);
        await checkVersion(ctx, pkg, target.version);
        if (target.cancel) {
          if (!allPendingDrop(pkg)) await versionConflict(ctx, id);
          const { to } = await transition(ctx, actor, pkg, 'open_cancel');
          const released = await releaseLines(id, pkg.lines);
          await setReserved(id, false);
          await clearPendingDrop(id);
          await setLinesPacked(id, false);
          await updatePackage(id, { status: to, needsOpen: false, openPurpose: null, packedBy: null, packedAt: null, labelError: false });
          await recordPacking(pkg, to, 'open_cancel', actor.accountId);
          if (resplit) await holdOrderReplacements(ctx, pkg.orderId, released);
          await requestAllocation(released);
          // Mở để chia lại: đơn không huỷ, không khép.
          return { detail: await getPackage(ctx, id), cancelledOrderId: resplit ? null : pkg.orderId };
        }
        const { to } = await transition(ctx, actor, pkg, 'open');
        // Kiện chờ mở vì kiểm kê (spec #238 §5.5) hay để chia lại: mở xong là hết việc, gỡ cờ cùng câu với trạng thái (CHECK
        // `packages_open`). Kiện chờ mở để bỏ dòng chờ bỏ (spec 205 §5.10) cũng hết việc khi các dòng đó đã xoá.
        const stocktake = pkg.openPurpose === 'stocktake';
        const dropped = pkg.lines.filter((line) => line.pendingDropQty > 0);
        const released = await releaseLines(id, dropped);
        await deleteLines(dropped.map((line) => line.id));
        await updatePackage(id, {
          status: to, packedBy: null, packedAt: null, labelError: false,
          ...((stocktake || resplit || dropped.length > 0) && { needsOpen: false, openPurpose: null }),
          ...(outcome === 'repacked' && { platformPackageCode: null, trackingCode: null, carrierCode: null, carrierName: null }),
          // Giữ mã kiện sàn, vận đơn, ĐVVC (D25): đóng gói, báo sẵn sàng lại không gọi sàn.
          ...(target.keepWaybill && pkg.platformPackageCode !== null && pkg.trackingCode !== null && { waybillKept: true }),
        });
        await setLinesPacked(id, false);
        await recordPacking(pkg, to, 'open', actor.accountId);
        if (resplit) await holdOrderReplacements(ctx, pkg.orderId, released);
        // Kiện `stocktake`, `resplit` về `reserved` vẫn giữ hàng: lượt phân hàng sau commit lấy lại phần giữ nếu tồn thực
        // vẫn nhỏ hơn đang giữ (kiện về `backordered`), không thì kiện ở lại `reserved` (D24). Cộng SKU vừa nhả của dòng
        // chờ bỏ (phần dư sau khi kiện thay đã giữ).
        const kept = stocktake || resplit
          ? pkg.lines.flatMap((line) => (line.variantId && line.pendingDropQty === 0 ? [line.variantId] : []))
          : [];
        await requestAllocation([...released, ...kept]);
        return { detail: await getPackage(ctx, id), cancelledOrderId: null };
      });
    } catch (err) {
      // Sàn đã huỷ gói cũ mà app còn giữ mã đó: lượt kéo đơn không tự sửa (món về chờ đóng gói, kiện app vẫn `packed`).
      if (outcome === 'repacked') logger.error({ err, packageId: id, platformPackageCode: target.code }, 'sàn đã đóng gói lại, app chưa ghi; cần mở lại kiện');
      throw err;
    }
    if (!written.cancelledOrderId) return written.detail;
    // Sàn đã huỷ xong nên lượt kéo không chạy lại luật huỷ đơn (D21): khép đơn đang huỷ ở giao dịch riêng, sau khi nhả
    // khoá kiện (lượt kéo khoá đơn trước kiện). Lỗi chỉ log: kiện đã huỷ xong, đơn giữ cờ đang huỷ.
    const orderId = written.cancelledOrderId;
    try {
      await withCompany(companyId, () => cancelledOrderSettlerOf(ctx)(orderId));
    } catch (err) {
      logger.error({ err, packageId: id, orderId }, 'kiện đã huỷ khi mở, chưa khép được đơn đang huỷ');
      return written.detail;
    }
    return withCompany(companyId, () => getPackage(ctx, id));
  });
}
