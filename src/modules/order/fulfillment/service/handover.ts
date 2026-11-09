// Thao tác bàn giao của người dùng (Documents/21 §19.2, spec 199a §5.4): kho quét bàn giao theo lô, CEO huỷ bàn giao
// nhầm. Trừ, đảo tồn qua lõi `handover-stock.ts`.
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { isHandedOver, packageMachine } from '../domain/package.ts';
import { lockPackage, updatePackage } from '../repository/packages.ts';
import { revertHandover, settleHandover } from './handover-stock.ts';
import { type FulfillmentContext, getPackage } from './packages.ts';

export interface Actor {
  companyId: string;
  accountId: string;
  permissions: readonly string[];
  enabledModules: readonly string[];
}

export interface HandOverResult {
  handedOver: { id: string; code: string; issue: { id: string; number: string } }[];
  failed: { packageId: string; code: string; detail: string }[];
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');
const versionConflict = (current: number) =>
  new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: { version: current } });

/** Một kiện trong một giao dịch: khoá, kiểm, chuyển `in_transit`, trừ tồn, lịch sử, sự kiện. */
async function handOverOne(actor: Actor, item: { id: string; version: number }) {
  return withCompany(actor.companyId, async () => {
    const pkg = await lockPackage(item.id);
    if (!pkg) throw notFound();
    // Trước `version`: quét lại hay hai người quét đua nhau thì báo đã bàn giao, không báo xung đột (21 §19.2).
    if (isHandedOver(pkg.status)) throw new AppError(409, 'already_handed_over', 'Kiện đã bàn giao');
    if (pkg.version !== item.version) throw versionConflict(pkg.version);
    const { to } = assertTransition(packageMachine, pkg.status, 'hand_over', { actor });
    const from = pkg.status;
    const at = new Date();
    await updatePackage(pkg.id, { status: to, handoverSource: 'scan', handedOverBy: actor.accountId, handedOverAt: at });
    Object.assign(pkg, { status: to, handoverSource: 'scan', handedOverAt: at });
    await recordTransition({ entityType: 'packages', entityId: pkg.id, from, to, action: 'hand_over', actorId: actor.accountId });
    const { documents } = await settleHandover(pkg, { actorId: actor.accountId, mode: 'deduct' });
    // Kiện chờ lấy hàng đã đủ SKU và đã giữ hàng: luôn đúng một phiếu.
    const issue = documents[0];
    if (!issue) throw new Error(`Kiện ${pkg.id} bàn giao mà không có phiếu xuất`);
    await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: pkg.orderId, payload: { packageId: pkg.id, orderId: pkg.orderId, from, to } });
    return { id: pkg.id, code: pkg.code, issue: { id: issue.documentId, number: issue.number } };
  });
}

/**
 * Kho quét bàn giao theo lô: mỗi kiện một giao dịch, kiện lỗi không chặn kiện khác. Lỗi của người gọi (`AppError`) vào
 * `failed` với mã, câu của lỗi; lỗi khác log `error` và trả câu chung, không lộ chi tiết.
 */
export async function handOverPackages(actor: Actor, items: readonly { id: string; version: number }[]): Promise<HandOverResult> {
  const result: HandOverResult = { handedOver: [], failed: [] };
  for (const item of items) {
    try {
      result.handedOver.push(await handOverOne(actor, item));
    } catch (err) {
      if (err instanceof AppError) {
        result.failed.push({ packageId: item.id, code: err.code, detail: err.message });
        continue;
      }
      logger.error({ err, packageId: item.id }, 'bàn giao kiện lỗi');
      result.failed.push({ packageId: item.id, code: 'internal_error', detail: 'Lỗi hệ thống khi bàn giao kiện này, thử lại sau' });
    }
  }
  return result;
}

export const CANCELLING_ORDER_NOTE = 'Đơn đang huỷ: dỡ kiện về kệ';

/**
 * CEO huỷ bàn giao nhầm do kho quét khi sàn chưa xác nhận lấy (21 §19.2, D2-06): đảo đủ cả lượt, kiện về chờ lấy hàng
 * và giữ hàng lại. Đơn đang huỷ thì bật Cần xử lý để kho dỡ kiện về kệ (chưa có khung việc #209, spec 199a D11).
 */
export async function undoHandover(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; reason: string }) {
  if (!isUuid(id)) throw notFound();
  return withCompany(actor.companyId, async () => {
    const pkg = await lockPackage(id);
    if (!pkg) throw notFound();
    if (pkg.version !== input.version) {
      throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: await getPackage(ctx, id) });
    }
    const { to } = assertTransition(packageMachine, pkg.status, 'undo_handover', { actor, reason: input.reason });
    if (pkg.handoverSource !== 'scan' || pkg.pickupConfirmedAt !== null) {
      throw new AppError(409, 'handover_confirmed_by_platform', 'Sàn đã xác nhận lấy kiện này, không huỷ bàn giao được');
    }
    const from = pkg.status;
    const reason = input.reason.trim();
    await revertHandover(pkg, actor.accountId, reason);
    await recordTransition({ entityType: 'packages', entityId: pkg.id, from, to, action: 'undo_handover', actorId: actor.accountId, reason });
    await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: pkg.orderId, payload: { packageId: pkg.id, orderId: pkg.orderId, from, to } });
    const order = (await ctx.orderRefsOf?.([pkg.orderId]))?.get(pkg.orderId);
    if (order?.cancelling || order?.platformCancelled) {
      await updatePackage(pkg.id, { needsAttention: true, flagNote: CANCELLING_ORDER_NOTE });
    }
    return getPackage(ctx, id);
  });
}
