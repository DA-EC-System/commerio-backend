// Kiện đổi trạng thái sau khi đơn hoàn tất (#236 PR 3, spec 5.5, D9): consumer `sales-package-reopened` nghe
// `fulfillment.package_status_changed`. Đơn giữ `completed` (không đổi `completed_at`, `return_window_ends_at`), kết quả
// tính lại theo trạng thái hiện tại của các kiện, cờ Cần xử lý bật khi kiện thật sự mở lại. Tính theo trạng thái hiện
// tại nên nhận lại hay nhận lệch thứ tự sự kiện vẫn ra cùng kết quả (không ghi, không phát lần nữa).
import { publishEvent } from '../../../core/index.ts';
import { findPackagesOfOrders, isStopped, type PackageStatus } from '../../fulfillment/index.ts';
import { logger } from '../../../../shared/logger.ts';
import { outcomeOf } from '../domain/order.ts';
import { findOrder } from '../repository/order-views.ts';
import { lockOrderRow, updateOrder } from '../repository/orders.ts';
import { eventFlags, UNKNOWN_STATUS_NOTE } from './ingest.ts';

export interface PackageStatusChangedEvent {
  /** Giờ ghi outbox (giờ bắt đầu giao dịch của DB), ISO 8601. */
  occurredAt: string;
  payload: { packageId: string; orderId: string; from: PackageStatus | null; to: PackageStatus };
}

/**
 * Gọi trong `withCompany` của sự kiện. Khoá đơn trước, chỉ đọc kiện (cùng thứ tự "đơn trước kiện" với lượt kéo).
 * - Đơn không thấy (công ty khác qua RLS, id lạ) hay không `completed`: bỏ qua.
 * - `outcome` = `outcomeOf` của kiện hiện tại, ghi khi khác.
 * - Mở lại: kiện đi từ trạng thái dừng sau lúc hoàn tất, hoặc đơn đang có kiện chưa dừng. Bật cờ khi chưa bật; ghi note khi
 *   đơn chưa có cờ, hoặc note đang có là note "trạng thái app chưa biết" của #358 (lượt kéo sạch sẽ gỡ cờ mang note đó).
 *   Note của luồng khác giữ nguyên.
 */
export async function onPackageStatusChanged(event: PackageStatusChangedEvent): Promise<void> {
  const { orderId, packageId, from, to } = event.payload;
  const row = await lockOrderRow(orderId);
  if (row?.status !== 'completed') return;
  const order = await findOrder(orderId);
  if (!order) return;
  const packages = await findPackagesOfOrders([orderId]);
  const outcome = outcomeOf(packages.map((p) => p.status));
  const afterCompletion = !!order.completedAt && new Date(event.occurredAt) > order.completedAt;
  const reopened = (from !== null && isStopped(from) && afterCompletion) || packages.some((p) => !isStopped(p.status));
  const ownNote = row.attentionNote?.startsWith(UNKNOWN_STATUS_NOTE) ?? false;
  const code = packages.find((p) => p.id === packageId)?.code ?? packageId;
  const patch = {
    ...(outcome !== order.outcome && { outcome }),
    ...(reopened && !row.needsAttention && { needsAttention: true }),
    ...(reopened && (!row.needsAttention || ownNote) && { attentionNote: `Kiện ${code} đổi ${from ?? 'mới'} → ${to} sau khi đơn hoàn tất` }),
  };
  // Không gì khác thì không ghi, không phát (chạy lại cùng sự kiện, AC29).
  if (!Object.keys(patch).length) return;
  await updateOrder(orderId, patch);
  if (reopened) logger.info({ orderId, packageId, from, to }, 'kiện mở lại sau khi đơn hoàn tất');
  await publishEvent({
    type: 'sales.order_status_changed',
    aggregateId: orderId,
    payload: {
      orderId,
      code: row.code,
      from: 'completed',
      to: 'completed',
      flags: await eventFlags(orderId, { ...row, ...patch }),
    },
  });
}
