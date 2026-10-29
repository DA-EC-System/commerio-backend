// Handler việc nền của gian hàng (#102). Lịch do `shop-jobs.ts` đặt; worker đăng ký ở `startBackground` của channel.
import { HoldJob } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { findShopRow } from '../repository/shops.ts';
import { syncListings } from './listing-sync.ts';
import type { ProductPort } from './product-port.ts';
import type { ShopJob } from './shop-jobs.ts';
import { stopShopJobs } from './shop-jobs.ts';
import { loseShopAuth, refreshShopToken } from './shops.ts';

/**
 * Đồng bộ listing định kỳ. Gian hàng không còn `active` (lịch sót sau khi ngắt) thì bỏ lịch, không gọi sàn.
 * Sàn từ chối token thì gian hàng mất uỷ quyền và việc được giữ tới khi nối lại.
 */
export async function runListingSync(port: ProductPort, job: ShopJob): Promise<void> {
  const shop = await withCompany(job.companyId, () => findShopRow(job.shopId));
  if (shop?.status !== 'active') return stopShopJobs(job.shopId);
  try {
    await syncListings(port, job.companyId, job.shopId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'marketplace_unauthorized') {
      await loseShopAuth(job.companyId, job.shopId, 'Sàn từ chối token khi đồng bộ listing');
      throw new HoldJob('gian hàng mất uỷ quyền');
    }
    throw err;
  }
}

export async function runTokenRefresh(job: ShopJob): Promise<void> {
  if ((await refreshShopToken(job.companyId, job.shopId)) === 'inactive') await stopShopJobs(job.shopId);
}
