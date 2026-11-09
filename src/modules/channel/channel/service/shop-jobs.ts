// Lịch việc nền của gian hàng (#102 A3): sinh khi gian hàng `active`, bỏ khi ngắt hoặc mất token.
import { z } from 'zod';
import { defineQueue, JobDataSchema, scheduleForShop, sendJob, unscheduleForShop } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { findActiveShopsAnyCompany, findShopRow } from '../repository/shops.ts';

export const ShopJobSchema = JobDataSchema.extend({ shopId: z.uuid() });
export type ShopJob = z.infer<typeof ShopJobSchema>;

/** Đồng bộ trạng thái listing và đẩy giá, tồn chờ (`syncListings`). Mỗi gian hàng một việc chờ (stately). */
export const listingSyncQueue = defineQueue('channel.listing_sync', ShopJobSchema, { policy: 'stately' });
/** Kéo đơn từ mốc của gian hàng (`pullShopOrders`, #105). */
export const orderPullQueue = defineQueue('channel.order_pull', ShopJobSchema, { policy: 'stately' });
/**
 * Lượt kéo đơn còn mở, một lần sau thiết lập (`pullOpenOrders`, #198). Không có lịch: gửi khi thiết lập, khi nối lại và
 * khi worker khởi động nếu `open_orders_pulled_at` còn null. Lượt đi hết các trạng thái mở nên cho chạy tới 30 phút.
 */
export const openOrderPullQueue = defineQueue('channel.open_order_pull', ShopJobSchema, { policy: 'stately', expireInSeconds: 1800 });
/**
 * Làm mới token khi tới `refreshDueAt` của adapter (#201). Chạy mỗi giờ vì ngưỡng theo sàn: access sống 4 giờ (Shopee) cần
 * kiểm dày; lượt chưa tới hạn chỉ đọc một dòng, không gọi sàn.
 */
export const tokenRefreshQueue = defineQueue('channel.token_refresh', ShopJobSchema, { policy: 'stately' });

const LISTING_SYNC_CRON = '*/15 * * * *';
const ORDER_PULL_CRON = '*/5 * * * *';
const TOKEN_REFRESH_CRON = '7 * * * *';

export async function startShopJobs(companyId: string, shopId: string): Promise<void> {
  await scheduleForShop(listingSyncQueue, LISTING_SYNC_CRON, { companyId, shopId });
  await scheduleForShop(orderPullQueue, ORDER_PULL_CRON, { companyId, shopId });
  await scheduleForShop(tokenRefreshQueue, TOKEN_REFRESH_CRON, { companyId, shopId });
}

export async function stopShopJobs(shopId: string): Promise<void> {
  await unscheduleForShop(listingSyncQueue, shopId);
  await unscheduleForShop(orderPullQueue, shopId);
  await unscheduleForShop(tokenRefreshQueue, shopId);
}

/** Xếp lượt kéo đơn còn mở; đã có việc chờ cùng gian hàng thì không thêm (`stately`). Đi chung giao dịch đang mở. */
export async function sendOpenOrderPull(companyId: string, shopId: string): Promise<void> {
  await sendJob(openOrderPullQueue, { companyId, shopId }, { key: shopId });
}

/** Xếp một lượt đồng bộ listing ngay (đẩy tồn lần đầu sau khi fulfillment phân hàng xong, #198); đi chung giao dịch đang mở. */
export async function sendListingSync(companyId: string, shopId: string): Promise<void> {
  await sendJob(listingSyncQueue, { companyId, shopId }, { key: shopId });
}

/** Xếp một lượt kéo đơn ngay (nối lại gian hàng, US-GH-14 dòng 1); đã có việc chờ cùng gian hàng thì không thêm. */
export async function sendOrderPull(companyId: string, shopId: string): Promise<void> {
  await sendJob(orderPullQueue, { companyId, shopId }, { key: shopId });
}

/** Gian hàng `active` đã thiết lập mà lượt kéo đơn còn mở chưa xong (việc mất khi gian hàng ngắt, mất token) thì xếp lại. */
export async function resumeOpenOrderPull(companyId: string, shopId: string): Promise<void> {
  const row = await withCompany(companyId, () => findShopRow(shopId));
  if (row?.status === 'active' && row.orderCutoffAt && !row.openOrdersPulledAt) await sendOpenOrderPull(companyId, shopId);
}

/** Worker khởi động: gian hàng `active` nào thiếu lịch thì đặt lại (đặt trùng thì thay, không sinh thêm). */
export async function reconcileShopJobs(): Promise<void> {
  for (const shop of await findActiveShopsAnyCompany()) {
    await startShopJobs(shop.companyId, shop.id);
    if (shop.orderCutoffAt && !shop.openOrdersPulledAt) await sendOpenOrderPull(shop.companyId, shop.id);
  }
}
