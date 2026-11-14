// Kiện thất lạc do người dùng (spec #238 §5.3, Documents/21 §19.2, 25 §8.3): kho báo kèm mã khiếu nại, người khác
// xác nhận. Kiện đã đóng không thấy khi dỡ (`lose_on_unload`) thì xác nhận ghi bàn giao (trừ tồn một lần qua
// `settleHandover`) rồi `lost`. Không cần khoá idempotency: khoá dòng kiện, trạng thái và `version` chặn lần hai.
import { sql } from 'drizzle-orm';
import { assertTransition, canSelfApprove, publishEvent, recordAudit, recordTransition } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { canReportLost, isSealed, packageMachine, type PackageStatus } from '../domain/package.ts';
import { lockPackage, packageShopOf, updatePackage } from '../repository/packages.ts';
import type { Actor } from './actor.ts';
import { settleHandover } from './handover-stock.ts';
import { type FulfillmentContext, getPackage, orderRefsLookupOf, stockHoldLookupOf } from './packages.ts';
import type { PackageDetail } from './packing.ts';

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');

async function versionConflict(ctx: FulfillmentContext, id: string): Promise<never> {
  throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: await getPackage(ctx, id) });
}

async function invalidTransition(ctx: FulfillmentContext, id: string): Promise<never> {
  throw new AppError(409, 'invalid_transition', 'Thao tác không hợp lệ ở trạng thái hiện tại', { current: await getPackage(ctx, id) });
}

/**
 * Kho báo kiện thất lạc. Thứ tự kiểm: kiện có (404, kể cả công ty khác, id sai dạng) → trạng thái báo mất được (409
 * `invalid_transition` kèm `current`) → kiện đã đóng phải đang chờ mở (409 `not_awaiting_open`) → chưa ai báo (409
 * `already_reported`) → `version` (409 kèm `current`). Trạng thái giữ nguyên, không ghi lịch sử trạng thái; ghi người
 * báo, giờ DB, mã khiếu nại và một dòng nhật ký thao tác.
 */
export async function reportLost(
  ctx: FulfillmentContext,
  actor: Actor,
  id: string,
  input: { version: number; claimCode: string },
): Promise<PackageDetail> {
  if (!isUuid(id)) throw notFound();
  return withCompany(actor.companyId, async () => {
    const pkg = await lockPackage(id);
    if (!pkg) throw notFound();
    if (!canReportLost(pkg.status)) await invalidTransition(ctx, id);
    if (isSealed(pkg.status) && !pkg.needsOpen) {
      throw new AppError(409, 'not_awaiting_open', 'Kiện đã đóng gói chỉ báo thất lạc được khi đang chờ mở kiện');
    }
    if (pkg.lostReportedBy !== null) throw new AppError(409, 'already_reported', 'Kiện đã được báo thất lạc, chờ người khác xác nhận');
    if (pkg.version !== input.version) await versionConflict(ctx, id);
    await updatePackage(pkg.id, { lostReportedBy: actor.accountId, lostReportedAt: sql`now()`, lostClaimCode: input.claimCode });
    await recordAudit({
      companyId: actor.companyId,
      actorId: actor.accountId,
      action: 'update',
      entityType: 'order.packages',
      entityId: pkg.id,
      after: { code: pkg.code, lostReported: true, claimCode: input.claimCode },
    });
    return getPackage(ctx, id);
  });
}

/**
 * Người khác người báo xác nhận kiện thất lạc. Thứ tự kiểm: 404 → chưa báo (409 `not_reported`) → máy trạng thái
 * (`lose` sau bàn giao, `lose_on_unload` kiện đã đóng đang chờ mở; 409 `invalid_transition`, 403 `forbidden`, 409
 * `second_person_required`, 409 `not_awaiting_open`) → `version`. Khoá gian hàng (`FOR SHARE`) trước khi khoá kiện như
 * bàn giao tay: `lose_on_unload` ở gian hàng chờ kiểm kê thì hoãn trừ tồn (spec 199b D7).
 */
export async function confirmLost(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number }): Promise<PackageDetail> {
  if (!isUuid(id)) throw notFound();
  return withCompany(actor.companyId, async () => {
    const shop = await packageShopOf(id);
    if (!shop) throw notFound();
    const awaiting = shop.shopId !== null && (await stockHoldLookupOf(ctx)([shop.shopId], { lock: true })).has(shop.shopId);
    const pkg = await lockPackage(id);
    if (!pkg) throw notFound();
    if (pkg.lostReportedBy === null || pkg.lostClaimCode === null) {
      throw new AppError(409, 'not_reported', 'Kiện chưa được báo thất lạc');
    }
    const order = (await orderRefsLookupOf(ctx)([pkg.orderId])).get(pkg.orderId);
    if (!order) throw new Error(`Kiện ${pkg.id} không có đơn ${pkg.orderId}`);
    const action = isSealed(pkg.status) ? 'lose_on_unload' : 'lose';
    const reason = `Mã khiếu nại ${pkg.lostClaimCode}`;
    // Hỏi `canSelfApprove` chỉ khi người xác nhận là người báo (như `inventory/service/documents.ts`).
    const canSelf = pkg.lostReportedBy === actor.accountId && (await canSelfApprove(actor.accountId));
    let checked: { to: PackageStatus; selfApproved: boolean };
    try {
      checked = assertTransition(packageMachine, pkg.status, action, {
        actor,
        record: {
          source: order.source,
          selfDelivery: pkg.selfDelivery,
          orderStatus: order.status,
          needsOpen: pkg.needsOpen,
          createdBy: pkg.lostReportedBy,
        },
        reason,
        canSelfApprove: canSelf,
      });
    } catch (err) {
      if (err instanceof AppError && err.code === 'invalid_transition') await invalidTransition(ctx, id);
      throw err;
    }
    if (pkg.version !== input.version) await versionConflict(ctx, id);
    const { to, selfApproved } = checked;
    const from = pkg.status;
    const lost = { status: to, lostConfirmedBy: actor.accountId, lostSource: 'user' as const, lostSelfApproved: selfApproved };
    if (action === 'lose_on_unload') {
      // Kiện chưa rời kho mà mất: ghi bàn giao cùng câu với `lost` (CHECK `packages_handed_over`), gỡ cờ chờ mở (CHECK
      // `packages_open`); không có sàn nào xác nhận lấy nên `pickup_confirmed_at` để null.
      await updatePackage(pkg.id, {
        ...lost,
        handoverSource: 'scan',
        handedOverBy: actor.accountId,
        handedOverAt: sql`now()`,
        needsOpen: false,
        openPurpose: null,
      });
      Object.assign(pkg, { status: to, handoverSource: 'scan' });
    } else {
      await updatePackage(pkg.id, lost);
    }
    await recordTransition({
      entityType: 'packages',
      entityId: pkg.id,
      from,
      to,
      action,
      actorId: actor.accountId,
      reason,
      selfApproved,
      audit: { entityType: 'order.packages', label: pkg.code },
    });
    // Trừ mọi dòng đã ghép SKU một lần (kể cả dòng chờ bỏ, D20); `settleHandover` phát `package_shipped`.
    if (action === 'lose_on_unload') await settleHandover(pkg, { actorId: actor.accountId, mode: awaiting ? 'defer' : 'deduct' });
    await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: pkg.orderId, payload: { packageId: pkg.id, orderId: pkg.orderId, from, to } });
    await publishEvent({
      type: 'fulfillment.package_lost',
      aggregateId: pkg.orderId,
      payload: { packageId: pkg.id, orderId: pkg.orderId, claimCode: pkg.lostClaimCode },
    });
    logger.info({ packageId: pkg.id, action, selfApproved }, 'xác nhận kiện thất lạc');
    return getPackage(ctx, id);
  });
}
