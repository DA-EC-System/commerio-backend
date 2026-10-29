// Trạng thái tiền của đơn do hệ thống chuyển (#117; Documents/21 §21.2): kiện đầu tiên giao xong, sau mỗi lô quyết
// toán. Gọi trong `withCompany` của bên gọi (ghi sổ #116, đối soát). Người chốt lệch ở `payments.ts`.
import { Decimal } from 'decimal.js';
import { currentCompanyId } from '../../../../shared/db/client.ts';
import { recordTransition } from '../../../core/index.ts';
import { vnDate } from '../domain/config-version.ts';
import { NO_THRESHOLD, nextAfterSettlement, type Threshold } from '../domain/settlement.ts';
import { orderSums } from '../repository/ledger.ts';
import { lockOrderSettlement, updateOrderSettlement } from '../repository/order-settlements.ts';
import { getEffectiveConfig } from './config-versions.ts';

export const SETTLEMENT_ENTITY = 'order_settlements';

/** Ngưỡng lệch đang áp hôm nay (cấu hình `mismatch_threshold` của #118), không có thì mọi lệch là lệch. */
export async function currentThreshold(now = new Date()): Promise<Threshold> {
  return (await getEffectiveConfig('mismatch_threshold', null, vnDate(now)))?.payload ?? NO_THRESHOLD;
}

/** Kiện của đơn vừa ghi số ước tính: `none → pending` lần đầu, cập nhật tổng ước tính. */
export async function markDelivered(orderId: string, shopId: string): Promise<void> {
  const row = await lockOrderSettlement(orderId, currentCompanyId()!, shopId);
  const sums = (await orderSums([orderId])).get(orderId);
  const first = row.status === 'none';
  await updateOrderSettlement(orderId, row, { estimatedTotal: sums?.estimated ?? '0', ...(first && { status: 'pending' }) });
  if (first) {
    await recordTransition({ entityType: SETTLEMENT_ENTITY, entityId: orderId, from: 'none', to: 'pending', action: 'first_delivered', actorId: null, source: 'system' });
  }
}

/**
 * Sau một lô quyết toán: tính lại tổng ước tính, thực tế, lệch của từng đơn, chuyển trạng thái theo ngưỡng
 * (`nextAfterSettlement`). Trả số đơn đổi trạng thái.
 */
export async function recomputeAfterSettlement(orderIds: readonly string[], shopId: string, t: Threshold): Promise<number> {
  const sums = await orderSums(orderIds);
  let changed = 0;
  for (const orderId of [...orderIds].sort()) {
    const row = await lockOrderSettlement(orderId, currentCompanyId()!, shopId);
    const s = sums.get(orderId) ?? { estimated: '0', actual: '0' };
    const diff = new Decimal(s.actual).minus(s.estimated);
    const next = nextAfterSettlement(row.status, s.estimated, diff, row.resolvedDiffBase, t);
    await updateOrderSettlement(orderId, row, {
      estimatedTotal: s.estimated,
      settledTotal: s.actual,
      diff: diff.toFixed(2),
      ...(next && { status: next.to }),
    });
    if (next) {
      changed++;
      await recordTransition({
        entityType: SETTLEMENT_ENTITY,
        entityId: orderId,
        from: row.status,
        to: next.to,
        action: next.action,
        actorId: null,
        source: 'marketplace',
      });
    }
  }
  return changed;
}
