// Tự hoàn tất đơn (Documents/21 §19.1, #105 PR 2): mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không còn yêu cầu trả
// mở → `completed` với kết quả theo kiện chưa huỷ. Đơn Đang huỷ còn kiện chờ mở thì chưa dừng nên chưa hoàn tất; đơn sàn
// huỷ mọi món mà mọi kiện đã dừng, có kiện không huỷ (kiện hoá ra đã bàn giao), thì hoàn tất kèm cờ Sàn đã huỷ (25 §8.2,
// #238). Huỷ một phần món thì hoàn tất như thường.
import { publishEvent, recordTransition, registerConsumer } from '../../../core/index.ts';
import { findPackagesOfOrders } from '../../fulfillment/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { every } from '../../../../shared/lifecycle.ts';
import { logger } from '../../../../shared/logger.ts';
import { completionBlocker, outcomeOf, RETURN_WINDOW_DAYS } from '../domain/order.ts';
import { findOrder, openReturnCounts } from '../repository/order-views.ts';
import { allLinesCancelled, findCompletionCandidates, updateOrderAt } from '../repository/orders.ts';
import { settleCancelledOrder } from './ingest.ts';
import { onReturnInspected } from './return-ingest.ts';

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
  const linesCancelled = await allLinesCancelled(orderId);
  // Mọi kiện đều huỷ mà đơn đang chờ sàn huỷ hay sàn đã huỷ mọi món: phải sang `cancelled` (25 §8.2), không `completed`.
  if (statuses.every((s) => s === 'cancelled') && (order.cancelPending || linesCancelled)) {
    // Lần khép sau khi kho mở kiện huỷ lỗi (chỉ log): khép lại ở đây để đơn không nằm mãi ở `processing`.
    if (linesCancelled) await settleCancelledOrder(orderId);
    return false;
  }
  const done = await updateOrderAt(orderId, order.version, {
    status: 'completed',
    outcome: outcomeOf(statuses),
    completedAt: now,
    returnWindowEndsAt: lastDelivered ? new Date(lastDelivered.getTime() + RETURN_WINDOW_DAYS * 86_400_000) : null,
    // Cờ chờ sàn chỉ có nghĩa khi đơn còn mở (CHECK `orders_cancel_pending_open`, `orders_cancel_requested_open`).
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
  // Kiểm hàng hoàn của yêu cầu trả ghi sổ thì đóng yêu cầu, hoàn tiền (#202, §11.2).
  registerConsumer('inventory.return_inspected', onReturnInspected, { consumer: 'sales-return-inspected' });
  return every(3_600_000, () => completeDueOrdersOnce(), 'việc nền tự hoàn tất đơn lỗi');
}
