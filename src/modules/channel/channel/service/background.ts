// Handler việc nền của gian hàng (#102). Lịch do `shop-jobs.ts` đặt; worker đăng ký ở `startBackground` của channel.
import { HoldJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { findShopRow, recordOpenOrderPullError } from '../repository/shops.ts';
import { pushPending, syncListings } from './listing-sync.ts';
import { pullOpenOrders, pullShopOrders } from './order-pull.ts';
import type { ProductPort } from './product-port.ts';
import type { ShopJob } from './shop-jobs.ts';
import { stopShopJobs } from './shop-jobs.ts';
import { loseShopAuth, refreshShopToken } from './shops.ts';

/**
 * Việc gọi sàn của một gian hàng. Gian hàng không còn `active` (lịch sót sau khi ngắt) thì bỏ lịch, không gọi sàn.
 * Sàn từ chối token thì gian hàng mất uỷ quyền và việc được giữ tới khi nối lại.
 */
async function onActiveShop(job: ShopJob, what: string, fn: () => Promise<unknown>): Promise<void> {
  const shop = await withCompany(job.companyId, () => findShopRow(job.shopId));
  if (shop?.status !== 'active') return stopShopJobs(job.shopId);
  try {
    await fn();
  } catch (err) {
    // Gian hàng vừa ngắt giữa lượt (kéo đơn bỏ đơn của gian hàng đã ngắt, #207): bỏ lịch, không tính là lỗi.
    if (err instanceof AppError && err.code === 'shop_not_connected') {
      const now = await withCompany(job.companyId, () => findShopRow(job.shopId));
      if (now?.status !== 'active') return stopShopJobs(job.shopId);
    }
    if (err instanceof AppError && err.code === 'marketplace_unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, `Sàn từ chối token khi ${what}`);
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    throw err;
  }
}

export function runListingSync(port: ProductPort, job: ShopJob): Promise<void> {
  return onActiveShop(job, 'đồng bộ listing', () => syncListings(port, job.companyId, job.shopId));
}

/**
 * Đẩy tồn, giá đang chờ (#223). Mất uỷ quyền thì không giữ việc: listing vẫn `stock_sync = pending`, nối lại thì lượt
 * `channel.listing_sync` lấy đơn, đối chiếu rồi mới đẩy (25 E28); việc giữ chạy lại lúc nối sẽ đẩy trước khi lấy đơn.
 */
export async function runStockPush(port: ProductPort, job: ShopJob): Promise<void> {
  try {
    await onActiveShop(job, 'đẩy tồn', () => pushPending(port, job.companyId, job.shopId));
  } catch (err) {
    if (!(err instanceof HoldJob)) throw err;
  }
}

export function runOrderPull(job: ShopJob): Promise<void> {
  return onActiveShop(job, 'kéo đơn', () => pullShopOrders(job.companyId, job.shopId));
}

/** Lỗi khác mất token, ngắt gian hàng thì ghi `last_error` rồi ném tiếp để pg-boss thử lại (#198 P3). */
export function runOpenOrderPull(job: ShopJob): Promise<void> {
  return onActiveShop(job, 'kéo đơn còn mở', async () => {
    try {
      await pullOpenOrders(job.companyId, job.shopId);
    } catch (err) {
      const silent = err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected');
      // Người dùng đọc `last_error`: lỗi nghiệp vụ ghi câu của nó, lỗi khác chỉ ghi câu chung, chi tiết ở log việc nền.
      const message = err instanceof AppError ? err.message : 'lỗi hệ thống, đang thử lại';
      if (!silent) await withCompany(job.companyId, () => recordOpenOrderPullError(job.shopId, message));
      throw err;
    }
  });
}

export async function runTokenRefresh(job: ShopJob): Promise<void> {
  if ((await refreshShopToken(job.companyId, job.shopId)) === 'inactive') await stopShopJobs(job.shopId);
}
