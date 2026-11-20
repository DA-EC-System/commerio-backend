// Khép đơn (Documents/21 §19.1, #105 PR 2, #236): tự hoàn tất và tự huỷ đơn mọi kiện đã huỷ.
// - Hoàn tất: mọi kiện dừng, có kiện không huỷ, qua hạn trả của gian hàng tính từ kiện giao cuối (`returnWindowDays`,
//   chưa nhập hay không thấy gian hàng: 7 ngày), không còn yêu cầu trả mở, kiện tự giao thu COD đã xác nhận →
//   `completed` với kết quả theo kiện chưa huỷ. Đơn Đang huỷ còn kiện chờ mở thì chưa dừng nên chưa hoàn tất; đơn sàn huỷ
//   mọi món mà có kiện không huỷ (kiện hoá ra đã bàn giao) thì hoàn tất kèm cờ Sàn đã huỷ (25 §8.2, #238). Huỷ một phần
//   món thì hoàn tất như thường.
// - Khép (#236 PR 3, D16): mọi kiện đã huỷ (`all_packages_cancelled`) thì không bao giờ hoàn tất; `settleCancelledOrder`
//   huỷ đơn khi mọi món đã huỷ (đơn sàn `platform_cancel`, đơn khác `auto_cancel`), còn món sống ngoài kiện thì giữ.
import { publishEvent, recordTransition, registerConsumer } from '../../../core/index.ts';
import { findPackagesOfOrders } from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { every } from '../../../../shared/lifecycle.ts';
import { logger } from '../../../../shared/logger.ts';
import {
  codUnconfirmed,
  completionBlocker,
  lastDeliveredAt,
  outcomeOf,
  type ReturnPolicy,
  returnWindowEndsAt,
} from '../domain/order.ts';
import { findOrder, findOrders, openReturnCounts } from '../repository/order-views.ts';
import { allLinesCancelled, findCompletionCandidates, updateOrderAt } from '../repository/orders.ts';
import { settleCancelledOrder } from './ingest.ts';
import { registerSalesMetrics, recordAutoComplete } from './metrics.ts';
import type { SalesContext } from './orders.ts';
import { onPackageStatusChanged } from './package-reopened.ts';
import { onReturnInspected } from './return-ingest.ts';
import { policyOf, returnPoliciesFor } from './return-policy.ts';

/** Cỡ trang ứng viên mỗi lượt (lật theo `id`). */
export const COMPLETION_PAGE = 500;

/**
 * Đọc lại đơn, kiện, yêu cầu trả trong giao dịch ghi rồi hoàn tất nếu vẫn đủ điều kiện: kiện đổi giữa lần đọc lô và
 * lúc này thì không hoàn tất. Ghi theo `version`; trả `false` khi không hoàn tất (lượt sau xét lại).
 */
async function completeOne(orderId: string, now: Date, policy: ReturnPolicy): Promise<boolean> {
  const order = await findOrder(orderId);
  if (order?.status !== 'processing') return false;
  const [packages, returns] = await Promise.all([findPackagesOfOrders([orderId]), openReturnCounts([orderId])]);
  const statuses = packages.map((p) => p.status);
  const lastDelivered = lastDeliveredAt(packages);
  const endsAt = returnWindowEndsAt(policy, lastDelivered, order.returnWindowEndsAt);
  const blocker = completionBlocker({
    packages: statuses,
    lastDeliveredAt: lastDelivered,
    returnWindowEndsAt: endsAt,
    openReturnRequests: returns.get(orderId) ?? 0,
    codUnconfirmed: codUnconfirmed(packages),
    now: now.getTime(),
  });
  // Mọi kiện đã huỷ cũng là blocker (`all_packages_cancelled`): đơn đó đi bước khép, không bao giờ hoàn tất.
  if (blocker) return false;
  const linesCancelled = await allLinesCancelled(orderId);
  const done = await updateOrderAt(orderId, order.version, {
    status: 'completed',
    outcome: outcomeOf(statuses),
    completedAt: now,
    returnWindowEndsAt: endsAt,
    // Cờ chờ sàn chỉ có nghĩa khi đơn còn mở (CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open` thêm ở PR
    // bỏ cột `cancelling`).
    cancelPending: false,
    cancelRequested: false,
    // Sàn huỷ mọi món mà có kiện hoá ra đã bàn giao (kho không thấy kiện khi dỡ, #238): cờ Sàn đã huỷ như mọi đơn bị
    // huỷ khi đã có kiện bàn giao (25 §8.2), kể cả khi lượt kéo đơn chưa kịp bật. Huỷ một phần món (KH-B09) thì không.
    ...(linesCancelled && { platformCancelled: true }),
  });
  // Người khác vừa sửa đơn: lượt sau xét lại.
  if (!done) return false;
  await recordTransition({ entityType: 'orders', entityId: orderId, from: 'processing', to: 'completed', action: 'complete', actorId: null, source: 'system' });
  const flags = [order.needsAttention && 'needs_attention', (order.platformCancelled || linesCancelled) && 'platform_cancelled'].filter((f): f is string => !!f);
  await publishEvent({
    type: 'sales.order_status_changed',
    aggregateId: orderId,
    payload: { orderId, code: order.code, from: 'processing', to: 'completed', flags },
  });
  return true;
}

/** Bước của một đơn tới lượt: hoàn tất, hay khép vì mọi kiện đã huỷ. */
type DueOrder = { orderId: string; policy: ReturnPolicy; step: 'complete' | 'close' };

/**
 * Đơn của một công ty trong trang tới lượt khép, kèm bước và chính sách hạn trả: một `withCompany` đọc lô đơn, kiện,
 * yêu cầu trả mở, chính sách gian hàng (số câu không tỉ lệ với số đơn đang chờ hạn trả).
 */
async function dueOrdersOfCompany(
  ctx: Required<Pick<SalesContext, 'returnPoliciesOf'>>,
  companyId: string,
  orderIds: readonly string[],
  now: Date,
): Promise<DueOrder[]> {
  return withCompany(companyId, async () => {
    const orders = await findOrders(orderIds);
    const [packages, returns, policies] = await Promise.all([
      findPackagesOfOrders(orderIds),
      openReturnCounts(orderIds),
      returnPoliciesFor(ctx, orders.map((o) => o.shopId)),
    ]);
    const due: DueOrder[] = [];
    for (const o of orders) {
      if (o.status !== 'processing') continue;
      const own = packages.filter((p) => p.orderId === o.id);
      const policy = policyOf(policies, o.shopId);
      const last = lastDeliveredAt(own);
      const blocker = completionBlocker({
        packages: own.map((p) => p.status),
        lastDeliveredAt: last,
        returnWindowEndsAt: returnWindowEndsAt(policy, last, o.returnWindowEndsAt),
        openReturnRequests: returns.get(o.id) ?? 0,
        codUnconfirmed: codUnconfirmed(own),
        now: now.getTime(),
      });
      if (blocker === null) due.push({ orderId: o.id, policy, step: 'complete' });
      else if (blocker === 'all_packages_cancelled') due.push({ orderId: o.id, policy, step: 'close' });
    }
    return due;
  });
}

/**
 * Một lượt tự hoàn tất cho mọi công ty, lật trang ứng viên theo `id`. Đọc lô của một công ty lỗi (kể cả đọc chính sách
 * gian hàng) thì bỏ công ty đó ở lượt này, không rơi về 7 ngày; đơn lỗi không chặn đơn khác. Đơn mọi kiện đã huỷ đi
 * bước khép (`settleCancelledOrder`). Trả số đơn đã hoàn tất.
 * `ctx.returnPoliciesOf` bắt buộc: thiếu thì ném ngay, không chạy lượt nào (không rơi về 7 ngày, #390).
 */
export async function completeDueOrdersOnce(
  now = new Date(),
  ctx: Required<Pick<SalesContext, 'returnPoliciesOf'>>,
  pageSize = COMPLETION_PAGE,
): Promise<number> {
  if (!ctx.returnPoliciesOf) throw new Error('completeDueOrdersOnce cần ctx.returnPoliciesOf');
  const started = Date.now();
  let candidates = 0;
  let completed = 0;
  // Đơn mọi kiện huỷ: đã huỷ, và chưa huỷ được (còn món sống ngoài kiện, hay người khác vừa khép). Không log từng đơn.
  let cancelled = 0;
  let cancelSkipped = 0;
  let failedOrders = 0;
  let skippedCompanies = 0;
  let cursor: string | null = null;
  for (;;) {
    const page = await findCompletionCandidates(cursor, pageSize);
    if (!page.length) break;
    candidates += page.length;
    cursor = page[page.length - 1]!.id;
    const byCompany = new Map<string, string[]>();
    for (const c of page) byCompany.set(c.companyId, [...(byCompany.get(c.companyId) ?? []), c.id]);
    for (const [companyId, orderIds] of byCompany) {
      let due: DueOrder[];
      try {
        due = await dueOrdersOfCompany(ctx, companyId, orderIds, now);
      } catch (err) {
        skippedCompanies += 1;
        logger.error({ err, companyId }, 'đọc lô tự hoàn tất của công ty lỗi');
        continue;
      }
      for (const { orderId, policy, step } of due) {
        try {
          if (step === 'close') {
            if (await withCompany(companyId, () => settleCancelledOrder(orderId))) cancelled += 1;
            else cancelSkipped += 1;
          } else if (await withCompany(companyId, () => completeOne(orderId, now, policy))) completed += 1;
        } catch (err) {
          failedOrders += 1;
          logger.error({ err, orderId, companyId }, 'tự hoàn tất đơn lỗi');
        }
      }
    }
    if (page.length < pageSize) break;
  }
  logger.info(
    { candidates, completed, cancelled, cancelSkipped, failedOrders, skippedCompanies, ms: Date.now() - started },
    'lượt tự hoàn tất đơn xong',
  );
  recordAutoComplete({ completed, cancelled, failedOrders, skippedCompanies });
  return completed;
}

/** Việc nền của `sales` trong worker: khép đơn mỗi giờ, consumer yêu cầu trả và kiện mở lại sau hoàn tất. */
export async function startSalesBackground(ctx: SalesContext): Promise<() => Promise<void>> {
  const { returnPoliciesOf } = ctx;
  // `AppContext` khai bắt buộc; thiếu (ctx dựng tay) thì không khởi động việc nền thay vì chốt đơn theo 7 ngày.
  if (!returnPoliciesOf) throw new Error('startSalesBackground cần ctx.returnPoliciesOf');
  // Kiểm hàng hoàn của yêu cầu trả ghi sổ thì đóng yêu cầu, hoàn tiền (#202, §11.2).
  registerConsumer('inventory.return_inspected', (event) => onReturnInspected(event, ctx), { consumer: 'sales-return-inspected' });
  // Kiện đổi trạng thái sau khi đơn hoàn tất: tính lại kết quả, bật Cần xử lý khi kiện mở lại (#236 PR 3, 5.5).
  registerConsumer('fulfillment.package_status_changed', onPackageStatusChanged, { consumer: 'sales-package-reopened' });
  registerSalesMetrics();
  return every(3_600_000, () => completeDueOrdersOnce(new Date(), { returnPoliciesOf }), 'việc nền tự hoàn tất đơn lỗi');
}
