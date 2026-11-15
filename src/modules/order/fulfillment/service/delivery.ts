// Một chỗ thi hành tác động giao xong, giao thất bại của kiện (spec 199c §5.3, Documents/21 §11.2). Mọi đường vào
// (đồng bộ sàn, hàm bù, quét nhận hoàn) gọi trong giao dịch của bên gọi; kiện đã khoá `FOR UPDATE`. Chốt "phát một
// lần" bằng `delivery_posted_at` (D8).
import { sql } from 'drizzle-orm';
import { assertTransition, publishEvent, recordTransition } from '../../../core/index.ts';
import { requireCompanyId, withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { getVariants } from '../../../product/index.ts';
import { deliveredAmounts, DEFAULT_FAIL_REASON, mergeReceiveLines, returnUnitCosts, type ScanLine } from '../domain/delivery.ts';
import { packageMachine, type PackageStatus } from '../domain/package.ts';
import {
  anotherDeliveryPosted,
  deliveryLinesOf,
  deliveryStateOf,
  lineCostsOf,
  orderShippingOf,
  packageStatuses,
} from '../repository/delivery.ts';
import { lockPackage, updatePackage } from '../repository/packages.ts';
import type { Actor } from './actor.ts';
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

/** `variantId` trong `lines` không phải SKU của công ty: 422 theo bảng lỗi của 21 §15.3 (không ghi gì). */
async function assertOwnVariants(lines: readonly ScanLine[] | undefined): Promise<void> {
  if (!lines?.length) return;
  const known = new Set((await getVariants(lines.map((l) => l.variantId).filter(isUuid))).map((v) => v.id));
  const errors = Object.fromEntries(
    lines.flatMap((l, i) => (known.has(l.variantId) ? [] : [[`lines.${i}.variantId`, 'Biến thể không thuộc công ty']])),
  );
  if (Object.keys(errors).length) throw new AppError(422, 'validation_failed', 'Dữ liệu không hợp lệ', { errors });
}

/**
 * Kho nhận kiện về (25 §8.3): kiện → `returned` theo mũi tên `action` của máy trạng thái. Thứ tự kiểm: kiện có (404, kể
 * cả công ty khác, id sai dạng) → máy trạng thái (409 `invalid_transition`) → `version` (409 kèm `current`) → `code`
 * khi route có quét mã (422 `package_mismatch`) → `lines` (422 `validation_failed`, 21 §15.3). Gộp `lines` với dòng kiện
 * đã ghép SKU (món vắng: quét 0; món ngoài kiện: dự kiến 0; không gửi `lines`: coi như quét đủ) rồi gọi `receiveBack`
 * kèm người quét và giá vốn dòng kiện: phiếu `KT` nháp, chờ xử lý cộng ngay theo số quét, tồn thực chưa đổi tới khi
 * phiếu ghi sổ. Không có dòng nào để lập (kiện chưa ghép SKU, không quét món nào) thì không lập phiếu. Phát
 * `package_status_changed`, `package_returned`. Không cần khoá idempotency: khoá dòng kiện, `version`, trạng thái chặn
 * lần hai; `receiveBack` gọi lại cùng nguồn trả phiếu cũ.
 */
async function receiveBackPackage(
  ctx: FulfillmentContext,
  actor: Actor,
  id: string,
  action: 'receive_return' | 'found',
  input: { version: number; code?: string; lines?: ScanLine[] | undefined },
) {
  if (!isUuid(id)) throw notFound();
  return withCompany(actor.companyId, async () => {
    const pkg = await lockPackage(id);
    if (!pkg) throw notFound();
    // Trạng thái trước `version`: quét lần hai (gửi lại version máy quét đã tải) báo `invalid_transition`, không báo
    // xung đột (21 §19.2), cùng thứ tự với bàn giao (`handover.ts`).
    const { to } = assertTransition(packageMachine, pkg.status, action, { actor });
    if (pkg.version !== input.version) {
      throw new AppError(409, 'version_conflict', 'Kiện vừa được cập nhật, tải lại rồi thử lại', { current: await getPackage(ctx, id) });
    }
    if (input.code !== undefined) {
      const code = input.code.trim().toLowerCase();
      if (code !== pkg.code.toLowerCase() && code !== pkg.trackingCode?.toLowerCase()) {
        throw new AppError(422, 'package_mismatch', MISMATCH, { errors: { code: MISMATCH } });
      }
    }
    await assertOwnVariants(input.lines);
    // Dòng chưa ghép SKU không vào phiếu (kho ghi SKU thực nhận trên phiếu, hoặc lập phiếu tay; spec 199c §10).
    // Món ngoài kiện mà số quét 0 (`quantity = 0` hợp lệ, 21 §15.3) không có gì để ghi: bỏ, kho không nhận dòng 0/0.
    const lines = mergeReceiveLines(pkg.lines, input.lines).filter((l) => l.expected > 0 || l.scanned > 0);
    if (lines.length) {
      await stockPort().receiveBack({ type: 'package', id: pkg.id }, lines, {
        actorId: actor.accountId,
        number: pkg.code,
        // Đơn và gian hàng của kiện lưu trên phiếu để truy ngược (21 §11.1); kho chỉ phát `return_inspected` cho nguồn yêu cầu trả.
        orderId: pkg.orderId,
        shopId: pkg.shopId,
        unitCosts: returnUnitCosts(await lineCostsOf(pkg.id)),
      });
    } else logger.info({ packageId: pkg.id }, 'kiện về kho không có dòng nào đã ghép SKU hay được quét, không lập phiếu kiểm hàng hoàn');
    const from = pkg.status;
    await updatePackage(pkg.id, { status: to });
    await recordTransition({ entityType: 'packages', entityId: pkg.id, from, to, action, actorId: actor.accountId });
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

/** Kho quét nhận hàng hoàn (spec 199c §5.5, 25 §8.3, D2-24): kiện `returning` → `returned`; `code` là mã kiện hoặc mã vận đơn. */
export function receiveReturn(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; code: string; lines?: ScanLine[] | undefined }) {
  return receiveBackPackage(ctx, actor, id, 'receive_return', input);
}

/** Kho nhận kiện thất lạc tìm thấy (21 §19.2, 25 §8.3 E61): kiện `lost` → `returned`, hàng về như kiện hoàn. */
export function foundPackage(ctx: FulfillmentContext, actor: Actor, id: string, input: { version: number; lines?: ScanLine[] | undefined }) {
  return receiveBackPackage(ctx, actor, id, 'found', input);
}

/** Trạng thái một kiện cho finance (E139, spec 199c §5.6). */
export interface PackageStatusInfo {
  orderId: string;
  status: PackageStatus;
  /** ISO của `delivered_at`; null khi kiện chưa giao. */
  deliveredAt: string | null;
}

/**
 * Trạng thái kiện theo id cho finance (E139, spec 199c §5.6). Chạy trong `withCompany` của bên gọi. Id không phải uuid
 * bị bỏ; không còn id nào thì trả `Map` rỗng, không truy vấn. Id của công ty khác hoặc không có thì vắng trong `Map`.
 */
export async function packageStatusOf(packageIds: readonly string[]): Promise<Map<string, PackageStatusInfo>> {
  const companyId = requireCompanyId('packageStatusOf');
  const ids = [...new Set(packageIds.filter(isUuid))];
  const out = new Map<string, PackageStatusInfo>();
  if (!ids.length) return out;
  for (const r of await packageStatuses(companyId, ids)) {
    out.set(r.id, { orderId: r.orderId, status: r.status, deliveredAt: r.deliveredAt?.toISOString() ?? null });
  }
  return out;
}
