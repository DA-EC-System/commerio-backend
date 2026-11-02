// Lịch việc nền của gian hàng (#102 A3): sinh khi gian hàng `active`, bỏ khi ngắt hoặc mất token.
import { z } from 'zod';
import { defineQueue, JobDataSchema, scheduleForShop, unscheduleForShop } from '../../../core/index.ts';
import { listActiveShopRefs } from '../repository/shops.ts';

export const ShopJobSchema = JobDataSchema.extend({ shopId: z.uuid() });
export type ShopJob = z.infer<typeof ShopJobSchema>;

/** Đồng bộ trạng thái listing và đẩy giá, tồn chờ (`syncListings`). Mỗi gian hàng một việc chờ (stately). */
export const listingSyncQueue = defineQueue('channel.listing_sync', ShopJobSchema, { policy: 'stately' });
/** Làm mới token khi access còn dưới 48 giờ; access Lazada sống 7 ngày nên chạy hằng ngày là đủ. */
export const tokenRefreshQueue = defineQueue('channel.token_refresh', ShopJobSchema, { policy: 'stately' });

const LISTING_SYNC_CRON = '*/15 * * * *';
const TOKEN_REFRESH_CRON = '0 3 * * *';

export async function startShopJobs(companyId: string, shopId: string): Promise<void> {
  await scheduleForShop(listingSyncQueue, LISTING_SYNC_CRON, { companyId, shopId });
  await scheduleForShop(tokenRefreshQueue, TOKEN_REFRESH_CRON, { companyId, shopId });
}

export async function stopShopJobs(shopId: string): Promise<void> {
  await unscheduleForShop(listingSyncQueue, shopId);
  await unscheduleForShop(tokenRefreshQueue, shopId);
}

/** Worker khởi động: gian hàng `active` nào thiếu lịch thì đặt lại (đặt trùng thì thay, không sinh thêm). */
export async function reconcileShopJobs(): Promise<void> {
  for (const shop of await listActiveShopRefs()) await startShopJobs(shop.companyId, shop.id);
}
