// Handler việc nền của gian hàng (#102). Lịch do `shop-jobs.ts` đặt; worker đăng ký ở `startBackground` của channel.
import { HoldJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { findShopRow, recordOpenOrderPullError, recordOrderPullError } from '../repository/shops.ts';
import { pushPending, syncListings } from './listing-sync.ts';
import { pullOpenOrders, pullShopOrders } from './order-pull.ts';
import { pullShopReturns } from './return-pull.ts';
import type { ProductPort } from './product-port.ts';
import { refreshRemoteSkusQuietly } from './remote-skus.ts';
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

/**
 * Đồng bộ listing rồi làm mới bản sao SKU sàn (#220 đợt 2: sản phẩm sửa từ lần trước, mỗi ngày đọc trọn). Bước sau chỉ
 * đọc sàn và ghi `remote_skus`, không đẩy tồn; lỗi của nó chỉ ghi log, không làm hỏng lượt đồng bộ.
 */
export function runListingSync(port: ProductPort, job: ShopJob): Promise<void> {
  return onActiveShop(job, 'đồng bộ listing', async () => {
    await syncListings(port, job.companyId, job.shopId);
    await refreshRemoteSkusQuietly(job.companyId, job.shopId);
  });
}

/**
 * Đẩy tồn, giá đang chờ (#223). Sàn từ chối token thì việc được giữ (`HoldJob`, đếm vào `Shop.pendingJobs`, 21 §18.6.6):
 * nối lại chạy tiếp nhưng chỉ đẩy giá, vì gian hàng mất mốc lấy đơn (`untrustedVariants`) tới khi lấy đơn xong trọn (25 E28).
 */
export function runStockPush(port: ProductPort, job: ShopJob): Promise<void> {
  return onActiveShop(job, 'đẩy tồn', () => pushPending(port, job.companyId, job.shopId));
}

/**
 * Kéo đơn định kỳ. Lỗi khác mất token, ngắt gian hàng thì ghi `last_error` (`Kéo đơn lỗi: …`, hiện ở `Shop.orderPullError`)
 * rồi ném để pg-boss thử lại; lượt chạy trọn thì xoá (#223: đơn chưa cập nhật giữ tồn của mọi gian hàng, phải có lý do).
 */
export function runOrderPull(job: ShopJob): Promise<void> {
  // Yêu cầu trả kéo sau đơn (#202): đơn mới về trước thì yêu cầu của nó gắn được ngay trong lượt.
  return onActiveShop(job, 'kéo đơn', async () => {
    try {
      await pullShopOrders(job.companyId, job.shopId);
    } catch (err) {
      if (!silentPullError(err)) await withCompany(job.companyId, () => recordOrderPullError(job.shopId, pullErrorMessage(err)));
      throw err;
    }
    try {
      await pullShopReturns(job.companyId, job.shopId);
    } catch (err) {
      // Lỗi kéo yêu cầu trả không làm hỏng lượt kéo đơn (lượt sau kéo lại từ mốc cũ); mất token, gian hàng ngắt thì
      // `onActiveShop` xử lý như kéo đơn.
      if (err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected')) throw err;
      logger.warn({ err, shopId: job.shopId }, 'kéo yêu cầu trả lỗi');
    }
  });
}

/** Mất token, ngắt gian hàng: đã có trạng thái riêng báo người dùng, không ghi `last_error`. */
const silentPullError = (err: unknown) =>
  err instanceof AppError && (err.code === 'marketplace_unauthorized' || err.code === 'shop_not_connected');
/** Người dùng đọc `last_error`: lỗi nghiệp vụ ghi câu của nó, lỗi khác chỉ ghi câu chung, chi tiết ở log việc nền. */
const pullErrorMessage = (err: unknown) => (err instanceof AppError ? err.message : 'lỗi hệ thống, đang thử lại');

/** Lỗi khác mất token, ngắt gian hàng thì ghi `last_error` rồi ném tiếp để pg-boss thử lại (#198 P3). */
export function runOpenOrderPull(job: ShopJob): Promise<void> {
  return onActiveShop(job, 'kéo đơn còn mở', async () => {
    try {
      await pullOpenOrders(job.companyId, job.shopId);
    } catch (err) {
      if (!silentPullError(err)) await withCompany(job.companyId, () => recordOpenOrderPullError(job.shopId, pullErrorMessage(err)));
      throw err;
    }
  });
}

export async function runTokenRefresh(job: ShopJob): Promise<void> {
  if ((await refreshShopToken(job.companyId, job.shopId)) === 'inactive') await stopShopJobs(job.shopId);
}
