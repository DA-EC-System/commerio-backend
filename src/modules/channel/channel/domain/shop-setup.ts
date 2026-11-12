// Tiến độ thiết lập gian hàng (#198, Documents/21 §18.7.7): hàm thuần trên cột của `channel.shops` và lúc lỗi của việc
// nền đã hết lượt thử. Bước kiểm kê và phân hàng chỉ có ở chế độ `stocktake`; đẩy tồn chờ kiểm kê, lượt kéo đơn còn mở,
// rồi chờ phân hàng.
import type { ShopStatus } from './shop.ts';

export type SetupStepKey = 'match' | 'opening_stock' | 'open_orders' | 'allocate' | 'push_stock';
export type SetupStepStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface ShopSetup {
  steps: { key: SetupStepKey; status: SetupStepStatus; blockedBy: string | null }[];
  /** Số SKU sàn trong bản sao chưa có ghép hiệu lực (gồm SKU bỏ qua lúc thiết lập); giảm ngay khi ghép (#220 đợt 2). */
  unmatchedCount: number;
  /** Số đơn còn mở cũ hơn không kéo về vì vượt trần `OPEN_ORDER_PULL_MAX`; 0 khi không cắt. */
  openOrdersSkipped: number;
}

export interface SetupInput {
  status: ShopStatus;
  openingStockMode: 'push' | 'stocktake' | null;
  openingStocktakeId: string | null;
  /** Phiếu đầu kỳ đã ghi sổ, đang chờ `allocation_done` có `cause` trùng phiếu (§18.6.11). */
  allocationStocktakeId: string | null;
  /** Số SKU chưa ghép đếm từ bản sao SKU sàn (`unmatchedRemoteCounts`), không còn cột lưu. */
  unmatchedCount: number;
  openOrdersPulledAt: Date | null;
  openOrdersSkipped: number;
  stockPushedAt: Date | null;
  /** Lúc việc `channel.open_order_pull` của gian hàng rơi vào hàng lỗi gần nhất. */
  openOrderPullFailedAt: Date | null;
  /** Lúc việc `channel.listing_sync` của gian hàng rơi vào hàng lỗi gần nhất. */
  listingSyncFailedAt: Date | null;
}

/** Mọi bước xong quá ngần này thì thôi trả `setup`. */
const SETUP_VISIBLE_MS = 24 * 3600_000;

const step = (key: SetupStepKey, status: SetupStepStatus, blockedBy: string | null = null) => ({ key, status, blockedBy });

/**
 * `null` khi gian hàng thiết lập trước #198 (không có `openingStockMode`), đã ngắt, hoặc mọi bước xong quá 24 giờ. Gian
 * hàng `connecting` chỉ có bước ghép `pending`: chưa biết chế độ tồn đầu kỳ nên chưa biết có bước kiểm kê không.
 */
export function setupOf(s: SetupInput, now: Date): ShopSetup | null {
  if (s.status === 'connecting') return { steps: [step('match', 'pending')], unmatchedCount: 0, openOrdersSkipped: 0 };
  if (!s.openingStockMode || s.status === 'disconnected') return null;
  const awaiting = s.openingStocktakeId !== null;
  const pulled = s.openOrdersPulledAt;
  const steps: ShopSetup['steps'] = [step('match', 'done')];
  if (s.openingStockMode === 'stocktake') steps.push(step('opening_stock', awaiting ? 'pending' : 'done'));
  steps.push(step('open_orders', pulled ? 'done' : s.openOrderPullFailedAt ? 'failed' : 'running'));
  // Phân hàng sau kiểm kê đầu kỳ (§18.6.11, §18.7.7): chỉ chế độ `stocktake`; chờ phiếu thì chưa chạy.
  const allocating = s.allocationStocktakeId !== null;
  if (s.openingStockMode === 'stocktake') {
    steps.push(awaiting ? step('allocate', 'blocked', 'opening_stock') : step('allocate', allocating ? 'running' : 'done'));
  }
  steps.push(
    s.stockPushedAt
      ? step('push_stock', 'done')
      : awaiting
        ? step('push_stock', 'blocked', 'opening_stock')
        : !pulled
          ? step('push_stock', 'blocked', 'open_orders')
          : allocating
            ? step('push_stock', 'blocked', 'allocate')
            : step('push_stock', s.listingSyncFailedAt && s.listingSyncFailedAt > pulled ? 'failed' : 'running'),
  );
  const allDone = steps.every((x) => x.status === 'done');
  if (allDone && s.stockPushedAt && now.getTime() - s.stockPushedAt.getTime() > SETUP_VISIBLE_MS) return null;
  return { steps, unmatchedCount: s.unmatchedCount, openOrdersSkipped: s.openOrdersSkipped };
}
