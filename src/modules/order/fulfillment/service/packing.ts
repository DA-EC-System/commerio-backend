import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { withCompany, withSessionLock } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { packageMachine, type PackageAction, type PackageStatus } from '../domain/package.ts';
import { buildPickList, packGroupBlockers, readyGroupBlockers, scanMismatch, type ScannedLine } from '../domain/packing.ts';
import { lockPackingPackage, lockReadyPackages, packageGroupOf, pickListBase, platformItemsOf, readPackingPackage, setLinesPacked, type PackingPackage } from '../repository/packing.ts';
import { markLinesReserved, packageShopOf, updatePackage } from '../repository/packages.ts';
import type { Actor } from './actor.ts';
import { getPackage, marketplacePackagesOf, orderRefsLookupOf, stockHoldLookupOf, type FulfillmentContext, type MarketplacePackages } from './packages.ts';
import { stockPort } from './stock-port.ts';

const PICK_LIST_LIMIT = 500;
export const PACKAGE_LOCK_WAIT_MS = 10_000;
export type PackageDetail = Awaited<ReturnType<typeof getPackage>>;
type PackingAction = Extract<PackageAction, 'pack' | 'mark_ready' | 'open'>;
type PackageIdentity = Pick<PackingPackage, 'id' | 'orderId' | 'status'>;
type Group = Awaited<ReturnType<typeof packageGroupOf>>;
const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');

export async function pickList(ctx: FulfillmentContext, ids: readonly string[] | undefined) {
  const { rows, packageIds, truncated } = await pickListBase(ids ? { ids } : { limit: PICK_LIST_LIMIT });
  const orders = rows.length ? await orderRefsLookupOf(ctx)([...new Set(rows.map((row) => row.orderId))]) : new Map();
  const items = buildPickList(rows.map(({ orderId, orderLineId, ...row }) => {
    const line = orders.get(orderId)?.lines.get(orderLineId);
    if (!line) throw new Error(`Không tìm thấy dòng đơn ${orderLineId} của kiện ${row.packageId}`);
    return { ...row, ...line };
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
  ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; lines: ScannedLine[]; carrierCode?: string | undefined },
): Promise<PackageDetail> {
  const { companyId } = actor;
  return withPackageLock(ctx, companyId, id, async () => {
    const target = await withCompany(companyId, async () => {
      const pkg = await readPackage(id);
      await checkVersion(ctx, pkg, input.version);
      await transition(ctx, actor, pkg, 'pack');
      const errors = scanMismatch(pkg.lines, input.lines);
      if (errors) throw new AppError(422, 'scan_mismatch', 'Số món quét chưa khớp với kiện', { errors });

      const others = await otherGroupMembers(pkg);
      if (others.length) {
        const orders = await orderRefsLookupOf(ctx)(others.map((member) => member.orderId));
        checkGroup(packGroupBlockers(others.map((member) => ({ ...member, orderStatus: orders.get(member.orderId)?.status ?? 'cancelled' }))));
      }
      return pkg.shopId ? { shopId: pkg.shopId, items: await platformItemsOf(id) } : null;
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
          carrierCode: result?.carrier?.code ?? null, carrierName: result?.carrier?.name ?? null,
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
      const others = await otherGroupMembers(pkg);
      checkGroup(readyGroupBlockers(others));
      if (pkg.shopId && !pkg.platformPackageCode) throw new AppError(409, 'rts_package_not_found', 'Kiện chưa có mã kiện trên sàn');
      return { shopId: pkg.shopId, code: pkg.platformPackageCode, ids: [pkg.id, ...others.map((member) => member.id)] };
    });

    if (target.shopId && target.code) {
      try {
        await marketplacePackagesOf(ctx).readyToShip(companyId, target.shopId, target.code);
      } catch (err) {
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
          await updatePackage(member.id, { status: 'awaiting_pickup', labelError: false });
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

export async function openPackage(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail> {
  const { companyId } = actor;
  return withPackageLock(ctx, companyId, id, async () => {
    const target = await withCompany(companyId, async () => {
      const shop = await packageShopOf(id);
      if (!shop) throw notFound();
      const awaitingStocktake = shop.shopId !== null && (await stockHoldLookupOf(ctx)([shop.shopId], { lock: true })).has(shop.shopId);
      const pkg = await readPackage(id, true);
      await checkVersion(ctx, pkg, input.version);
      if (pkg.status === 'awaiting_pickup') {
        throw new AppError(409, 'invalid_transition', 'Kiện đã báo sàn sẵn sàng giao: dỡ kiện về kệ qua việc của kho (#238)');
      }
      await transition(ctx, actor, pkg, 'open');

      const missing = pkg.lines.filter((line) => line.variantId !== null && line.reservedQty < line.quantity);
      if (missing.length) {
        if (awaitingStocktake) throw new AppError(409, 'shop_awaiting_stocktake', 'Gian hàng đang chờ kiểm kê đầu kỳ');
        const { reserved } = await stockPort().reserve(id, missing.map((line) => ({ variantId: line.variantId!, quantity: line.quantity - line.reservedQty })));
        if (!reserved) throw new AppError(422, 'insufficient_stock', 'Không đủ hàng để giữ lại cả kiện, chờ hàng về rồi mở');
        await markLinesReserved(missing.map((line) => line.id));
        await updatePackage(id, { reservedAt: new Date() });
        const variantIds = [...new Set(pkg.lines.flatMap((line) => line.variantId ? [line.variantId] : []))].sort();
        await publishEvent({ type: 'fulfillment.allocation_done', aggregateId: companyId, payload: { variantIds } });
      }
      return { shopId: pkg.shopId, code: pkg.platformPackageCode, version: pkg.version + Number(missing.length > 0) };
    });

    const outcome: Awaited<ReturnType<MarketplacePackages['repack']>> | null = target.shopId && target.code
      ? await marketplacePackagesOf(ctx).repack(companyId, target.shopId, target.code)
      : null;
    try {
      return await withCompany(companyId, async () => {
        const pkg = await readPackage(id, true);
        await checkVersion(ctx, pkg, target.version);
        const { to } = await transition(ctx, actor, pkg, 'open');
        await updatePackage(id, {
          status: to, packedBy: null, packedAt: null, labelError: false,
          ...(outcome === 'repacked' && { platformPackageCode: null, trackingCode: null, carrierCode: null, carrierName: null }),
        });
        await setLinesPacked(id, false);
        await recordPacking(pkg, to, 'open', actor.accountId);
        return getPackage(ctx, id);
      });
    } catch (err) {
      // Sàn đã huỷ gói cũ mà app còn giữ mã đó: lượt kéo đơn không tự sửa (món về chờ đóng gói, kiện app vẫn `packed`).
      if (outcome === 'repacked') logger.error({ err, packageId: id, platformPackageCode: target.code }, 'sàn đã đóng gói lại, app chưa ghi; cần mở lại kiện');
      throw err;
    }
  });
}
