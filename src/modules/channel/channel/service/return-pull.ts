// Kéo yêu cầu trả của sàn theo gian hàng (#202): chạy sau mỗi lượt kéo đơn (cùng việc `channel.order_pull`), từ mốc
// `last_return_sync_at` (lần đầu: `order_cutoff_at`) lùi 2 phút. Gọi sàn ngoài giao dịch; mỗi yêu cầu một giao dịch qua
// `ingestMarketplaceReturn` của `order`. Lazada trả mới tạo trước, không theo thời điểm sửa, nên mốc chỉ tiến tới lúc
// bắt đầu lượt khi đi hết các trang; lỗi giữa chừng thì lượt sau kéo lại từ mốc cũ (ghi lặp không sao, theo mã sàn).
// Yêu cầu của đơn chưa có trong app (`unknown_order`) không giữ mốc: chỉ về lại khi sàn sửa yêu cầu đó lần nữa. Kéo đơn
// chạy ngay trước trong cùng việc nên đơn mới thường đã có.
import {
  flagRefundApprovalFailed,
  ingestMarketplaceReturn,
  markRefundApproved,
  markReturnConfirmed,
  type PlatformReturn,
  type ReturnIngestOutcome,
  returnsAwaitingConfirm,
  returnsAwaitingRefundApproval,
} from '../../../order/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { advanceReturnCursor } from '../repository/raw-orders.ts';
import { lockShopForOrders } from '../repository/shops.ts';
import { type MarketplaceAdapter, MarketplaceError, type RemoteReturn } from './marketplaces/common.ts';
import { onMarketplace, shopSession, shopStopped } from './shops.ts';

const OVERLAP_MS = 2 * 60_000;
const MAX_PAGES = 200;

export type ReturnPullResult = Record<ReturnIngestOutcome, number>;

/** Đổi yêu cầu trả của adapter sang dạng `order` nhận. */
export function toPlatformReturn(shopId: string, r: RemoteReturn): PlatformReturn {
  return {
    shopId,
    externalReturnId: r.externalId,
    externalOrderId: r.externalOrderId,
    kind: r.kind,
    status: r.status,
    rawStatus: r.rawStatus,
    ofcStatus: r.ofcStatus ?? null,
    disputeInProgress: r.disputeInProgress,
    returnTo: r.returnTo ?? null,
    returnTrackingCode: r.returnTrackingCode,
    respondBy: r.respondBy,
    sellerHandledReceipt: r.sellerHandledReceipt ?? false,
    reason: r.reason,
    refundAmount: r.refundAmount,
    lines: r.lines.map((l) => ({ externalLineId: l.externalLineId, externalReturnLineId: l.externalReturnLineId ?? null, quantity: l.quantity ?? 1 })),
    updatedAt: r.updatedAt,
  };
}

/**
 * Thử lại báo sàn đã nhận hàng trả cho yêu cầu mang cờ báo sàn lỗi lúc quét (§20.1): mỗi yêu cầu một lời gọi ngoài giao
 * dịch, nhận được thì gỡ cờ. Lỗi chỉ ghi log, giữ cờ để lượt sau thử tiếp; mất uỷ quyền thì ném như kéo đơn. Trả số yêu
 * cầu đã gỡ cờ.
 */
export async function retryReturnConfirms(companyId: string, shopId: string, adapter: MarketplaceAdapter, accessToken: string): Promise<number> {
  if (!adapter.confirmReturnReceived) return 0;
  const pending = await withCompany(companyId, () => returnsAwaitingConfirm(shopId));
  let confirmed = 0;
  for (const r of pending) {
    try {
      await onMarketplace(() => adapter.confirmReturnReceived!(accessToken, r.externalReturnId, r.externalLineIds));
    } catch (err) {
      if (shopStopped(err)) throw err;
      logger.warn({ err, shopId, returnRequestId: r.id }, 'thử lại báo sàn đã nhận hàng trả lỗi');
      continue;
    }
    if (await withCompany(companyId, () => markReturnConfirmed(r.id))) confirmed += 1;
  }
  return confirmed;
}

/**
 * Báo sàn đồng ý hoàn tiền cho yêu cầu đã đóng sau kiểm hàng hoàn (`refund_approval = pending`, #392): mỗi yêu cầu một
 * lời gọi ngoài giao dịch; sàn nhận thì `done`, lỗi thì bật Cần xử lý một lần và thử lại lượt sau. Mất uỷ quyền thì ném.
 */
export async function approvePendingRefunds(companyId: string, shopId: string, adapter: MarketplaceAdapter, accessToken: string): Promise<number> {
  if (!adapter.approveReturnRefund) return 0;
  const pending = await withCompany(companyId, () => returnsAwaitingRefundApproval(shopId));
  let approved = 0;
  for (const r of pending) {
    try {
      await onMarketplace(() => adapter.approveReturnRefund!(accessToken, r.externalReturnId));
    } catch (err) {
      if (shopStopped(err)) throw err;
      logger.warn({ err, shopId, returnRequestId: r.id }, 'báo sàn đồng ý hoàn tiền lỗi');
      const message = err instanceof AppError ? err.message : 'lỗi không rõ';
      await withCompany(companyId, () => flagRefundApprovalFailed(r.id, message));
      continue;
    }
    if (await withCompany(companyId, () => markRefundApproved(r.id))) approved += 1;
  }
  return approved;
}

export async function pullShopReturns(companyId: string, shopId: string): Promise<ReturnPullResult> {
  const result: ReturnPullResult = { created: 0, updated: 0, unchanged: 0, unknown_order: 0, skipped: 0 };
  const { shop, adapter, accessToken } = await withCompany(companyId, () => shopSession(shopId));
  // Trước lượt kéo: sàn nhận xong thì chính lượt này đọc được trạng thái mới.
  await retryReturnConfirms(companyId, shopId, adapter, accessToken);
  await approvePendingRefunds(companyId, shopId, adapter, accessToken);
  if (!adapter.listReturns || !shop.orderCutoffAt) return result;
  const startedAt = new Date();
  const since = new Date((shop.lastReturnSyncAt ?? shop.orderCutoffAt).getTime() - OVERLAP_MS);
  let cursor: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const prev = cursor;
    const page = await onMarketplace(async () => {
      const p = await adapter.listReturns!(accessToken, since, prev);
      if (p.nextCursor !== null && p.nextCursor === prev) throw new MarketplaceError('rejected', 'cursor_stuck', 'Adapter trả lại con trỏ cũ');
      return p;
    });
    for (const item of page.items) {
      const outcome = await withCompany(companyId, async () => {
        // Khoá chia sẻ gian hàng như kéo đơn (#207): không ghi vào gian hàng vừa ngắt.
        const locked = await lockShopForOrders(shopId);
        if (!locked || locked.status === 'disconnected') {
          throw new AppError(409, 'shop_not_connected', 'Gian hàng đã ngắt', { current: 'disconnected' });
        }
        return ingestMarketplaceReturn(toPlatformReturn(shopId, item));
      });
      result[outcome] += 1;
    }
    cursor = page.nextCursor;
    if (!cursor) {
      await withCompany(companyId, () => advanceReturnCursor(shopId, startedAt));
      break;
    }
  }
  return result;
}
