// Một chỗ thi hành tác động giao xong, giao thất bại của kiện (spec 199c §5.3, Documents/21 §11.2). Mọi đường vào
// (đồng bộ sàn, hàm bù, quét nhận hoàn) gọi trong giao dịch của bên gọi; kiện đã khoá `FOR UPDATE`. Chốt "phát một
// lần" bằng `delivery_posted_at` (D8).
import { sql } from 'drizzle-orm';
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { deliveredAmounts, type DeliveredLine, DEFAULT_FAIL_REASON } from '../domain/delivery.ts';
import { packageMachine } from '../domain/package.ts';
import {
  anotherDeliveryPosted,
  deliveryLinesOf,
  deliveryStateOf,
  orderShippingOf,
} from '../repository/delivery.ts';
import { lockPackage, updatePackage } from '../repository/packages.ts';
// Người quét: cùng hình `Actor` của `service/handover.ts` (import file đó sẽ thành vòng qua `handover-stock.ts`).
type Actor = { companyId: string; accountId: string; permissions: readonly string[]; enabledModules: readonly string[] };
import { type FulfillmentContext, getPackage } from './packages.ts';
import { stockPort } from './stock-port.ts';

/**
 * Báo kiện giao xong cho finance (spec 199c §5.3): phát `fulfillment.package_delivered` đủ tiền, đúng một lần.
 * Trả `true` khi phát, `false` khi đã phát rồi, còn dòng hoãn trừ, hay đơn không có gian hàng (MVP chưa có đường
 * vào). Chạy trong giao dịch của bên gọi; kiện đã khoá.
 */
export async function reportDelivered(packageId: string): Promise<boolean> {
  requireCompanyId('reportDelivered');
  const state = await deliveryStateOf(packageId);
  if (!state) return false;
  // 1. Đã phát rồi (đồng bộ lại, kiện vào delivered lần hai) không phát lại.
  if (state.deliveryPostedAt !== null) return false;
  // 2. Kiện còn dòng đã ghép SKU chưa trừ tồn (không before_cutoff): hoãn, hàm bù gọi lại sau khi chốt giá vốn.
  if (state.deferred) return false;
  // 3. Đơn không có gian hàng (đơn tạo tay, MVP chưa có đường vào) không báo.
  if (state.shopId === null) {
    logger.warn({ packageId, orderId: state.orderId }, 'kiện giao xong nhưng đơn không có gian hàng, không báo finance');
    return false;
  }
  const lines = await deliveryLinesOf(packageId);
  const shipping = await orderShippingOf(state.orderId);
  // 4. Kiện đầu của đơn mang ship cấp đơn; kiện khác đã báo thì ship "0.00" (D4).
  const first = !(await anotherDeliveryPosted(state.orderId, packageId));
  const amounts = deliveredAmounts(lines, shipping, first);
  // 5. Phát sự kiện cùng giao dịch, đặt mốc phát.
  await publishEvent({
    type: 'fulfillment.package_delivered',
    aggregateId: state.orderId,
    payload: {
      packageId,
      orderId: state.orderId,
      shopId: state.shopId,
      deliveredAt: (state.deliveredAt ?? new Date()).toISOString(),
      ...amounts,
    },
  });
  await updatePackage(packageId, { deliveryPostedAt: sql`now()` });
  return true;
}

/**
 * Báo kiện giao thất bại (spec 199c §5.3): phát `fulfillment.package_delivery_failed` với lý do (mặc định
 * `DEFAULT_FAIL_REASON` khi hành trình không cho). Chạy trong giao dịch của bên gọi.
 */
export async function reportDeliveryFailed(pkg: { id: string; orderId: string }, reason: string): Promise<void> {
  await publishEvent({
    type: 'fulfillment.package_delivery_failed',
    aggregateId: pkg.orderId,
    payload: { packageId: pkg.id, orderId: pkg.orderId, reason: reason || DEFAULT_FAIL_REASON },
  });
}

const notFound = () => new AppError(404, 'not_found', 'Không tìm thấy kiện');
const MISMATCH = 'Mã quét không phải của kiện này';

/**
 * Kho quét nhận hàng hoàn (spec 199c §5.5, 25 §8.3, D2-24): kiện `returning` → `returned`. Thứ tự kiểm: kiện có (404,
 * kể cả công ty khác, id sai dạng) → `version` (409 kèm `current`) → máy trạng thái (409 `invalid_transition`) → mã
 * quét khớp mã kiện hoặc mã vận đơn, không phân biệt hoa thường (422 `package_mismatch`). Dòng đã ghép SKU vào một
 * phiếu `KT` nháp (tồn chưa đổi tới khi phiếu ghi sổ); không dòng nào ghép thì không lập phiếu. Phát
 * `package_status_changed`, `package_returned`. Không cần khoá idempotency: khoá dòng kiện, `version`, trạng thái chặn
 * quét lần hai; `receiveBack` gọi lại cùng nguồn trả phiếu cũ.
 */
export async function receiveReturn(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; code: string }) {
  if (!isUuid(id)) throw notFound();
  return withCompany(actor.companyId, async () => {
    const pkg = await lockPackage(id);
    if (!pkg) throw notFound();
    if (pkg.version !== input.version) {
      throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: await getPackage(ctx, id) });
    }
    const { to } = assertTransition(packageMachine, pkg.status, 'receive_return', { actor });
    const code = input.code.trim().toLowerCase();
    if (code !== pkg.code.toLowerCase() && code !== pkg.trackingCode?.toLowerCase()) {
      throw new AppError(422, 'package_mismatch', MISMATCH, { errors: { code: MISMATCH } });
    }
    const lines = pkg.lines.filter((l) => l.variantId !== null).map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));
    // Dòng chưa ghép SKU không vào phiếu (kho lập phiếu tay, giới hạn đã biết của spec 199c §10).
    if (lines.length) await stockPort().receiveBack({ type: 'package', id: pkg.id }, lines);
    else logger.info({ packageId: pkg.id }, 'kiện hoàn về không có dòng nào đã ghép SKU, không lập phiếu kiểm hàng hoàn');
    const from = pkg.status;
    await updatePackage(pkg.id, { status: to });
    await recordTransition({ entityType: 'packages', entityId: pkg.id, from, to, action: 'receive_return', actorId: actor.accountId });
    await publishEvent({ type: 'fulfillment.package_status_changed', aggregateId: pkg.orderId, payload: { packageId: pkg.id, orderId: pkg.orderId, from, to } });
    if (pkg.shopId !== null) {
      await publishEvent({
        type: 'fulfillment.package_returned',
        aggregateId: pkg.orderId,
        payload: { packageId: pkg.id, orderId: pkg.orderId, shopId: pkg.shopId, returnedAt: new Date().toISOString() },
      });
    }
    return getPackage(ctx, id);
  });
}

export type { DeliveredLine };
