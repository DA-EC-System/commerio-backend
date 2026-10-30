// Tự hoàn tất đơn (Documents/21 §19.1, #105 PR 2): mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không còn yêu cầu trả
// mở → `completed` với kết quả theo kiện chưa huỷ. Đơn đang huỷ chờ mở kiện (#106) thì bỏ qua.
import { publishEvent, recordTransition } from '../../../core/index.ts';
import { findPackagesOfOrders } from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { every } from '../../../../shared/lifecycle.ts';
import { logger } from '../../../../shared/logger.ts';
import { completionBlocker, outcomeOf, RETURN_WINDOW_DAYS } from '../domain/order.ts';
import { findOrder, openReturnCounts } from '../repository/order-views.ts';
import { findCompletionCandidates, updateOrderAt } from '../repository/orders.ts';

async function completeOne(orderId: string, now: Date): Promise<boolean> {
  const order = await findOrder(orderId);
  if (order?.status !== 'processing') return false;
  const [packages, returns] = await Promise.all([findPackagesOfOrders([orderId]), openReturnCounts([orderId])]);
  const statuses = packages.map((p) => p.status);
  const lastDelivered = packages.reduce<Date | null>((a, p) => (p.deliveredAt && (!a || p.deliveredAt > a) ? p.deliveredAt : a), null);
  const blocker = completionBlocker({
    packages: statuses,
    lastDeliveredAt: lastDelivered?.toISOString() ?? null,
    openReturnRequests: returns.get(orderId) ?? 0,
    codUnconfirmed: false,
    now: now.getTime(),
  });
  if (blocker) return false;
  const done = await updateOrderAt(orderId, order.version, {
    status: 'completed',
    outcome: outcomeOf(statuses),
    completedAt: now,
    returnWindowEndsAt: lastDelivered ? new Date(lastDelivered.getTime() + RETURN_WINDOW_DAYS * 86_400_000) : null,
  });
  // Người khác vừa sửa đơn: lượt sau xét lại.
  if (!done) return false;
  await recordTransition({ entityType: 'orders', entityId: orderId, from: 'processing', to: 'completed', action: 'complete', actorId: null, source: 'system' });
  const flags = [order.needsAttention && 'needs_attention', order.platformCancelled && 'platform_cancelled'].filter((f): f is string => !!f);
  await publishEvent({
    type: 'sales.order_status_changed',
    aggregateId: orderId,
    payload: { orderId, code: order.code, from: 'processing', to: 'completed', flags },
  });
  return true;
}

/** Một lượt tự hoàn tất cho mọi công ty; đơn lỗi không chặn đơn khác. Trả số đơn đã hoàn tất. */
export async function completeDueOrdersOnce(now = new Date()): Promise<number> {
  let completed = 0;
  for (const c of await findCompletionCandidates()) {
    try {
      if (await withCompany(c.companyId, () => completeOne(c.id, now))) completed += 1;
    } catch (err) {
      logger.warn({ err, orderId: c.id }, 'tự hoàn tất đơn lỗi');
    }
  }
  return completed;
}

/** Việc nền của `sales` trong worker: tự hoàn tất mỗi giờ. */
export async function startSalesBackground(): Promise<() => Promise<void>> {
  return every(3_600_000, () => completeDueOrdersOnce(), 'việc nền tự hoàn tất đơn lỗi');
}
