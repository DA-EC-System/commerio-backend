// Lịch việc nền của gian hàng (#102 A3): sinh khi gian hàng `active`, bỏ khi ngắt hoặc mất token.
import { z } from 'zod';
import { defineQueue, JobDataSchema, scheduleForShop, sendJob, unscheduleForShop } from '../../../core/index.ts';
import { withCompany } from '../../../../shared/db/client.ts';
import { REFRESH_STALE_MS } from '../domain/remote-skus-refresh.ts';
import { findActiveShopsAnyCompany, findShopRow } from '../repository/shops.ts';

/** Số ảnh tối đa của một sản phẩm khi đẩy: 8 ảnh catalog đầu (Lazada nhận tối đa 8 ảnh mỗi `Image`; #303). */
export const PUSH_IMAGE_MAX = 8;

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

/**
 * Đẩy tồn, giá đang chờ của gian hàng (`pushPending`, #223, Documents/21 §14.5): xếp khi `fulfillment.allocation_done` đổi
 * số có thể bán, hoặc listing vừa đẩy lại. Không đọc sàn, không đối chiếu; đọc số mới nhất lúc chạy nên `stately` theo
 * gian hàng là đủ (việc đang chờ sẽ đọc cả lần đổi sau).
 */
export const stockPushQueue = defineQueue('channel.stock_push', ShopJobSchema, { policy: 'stately' });

/** Việc đẩy một listing (#219, Documents/21 §18.6.4): `imageUrls` là URL ảnh catalog của sản phẩm lúc bấm đẩy (#303). */
export const ListingPushJobSchema = JobDataSchema.extend({
  shopId: z.uuid(),
  listingId: z.uuid(),
  imageUrls: z.array(z.string()).max(PUSH_IMAGE_MAX),
  /** Link ảnh bảng kích cỡ của sản phẩm lúc bấm đẩy (#347); việc xếp trước #347 không có. */
  sizeChartUrl: z.string().nullish(),
  /** CEO ghi nội dung Commerio lên sản phẩm người bán (`take-over-content`, #399): ghi nội dung dù listing `platform`. */
  takeOver: z.boolean().optional(),
});
export type ListingPushJob = z.infer<typeof ListingPushJobSchema>;
/**
 * Đẩy một listing lên sàn (`runListingPush`). Hàng `standard`, không khoá theo gian hàng: chống trùng nằm ở CSDL (chỉ
 * dòng vừa chuyển `pushing` mới xếp việc), còn `stately` khoá một việc mỗi trạng thái và `releaseHeld` gửi lại việc giữ
 * với khoá gian hàng sẽ làm rơi việc của các listing khác (#219 A3). Thử 5 lần, lần đầu sau 30 giây, gấp đôi (pg-boss
 * nhân thêm `1 + random()`): lần thứ 5 rơi trong khoảng 15 phút, trước mốc 30 phút của đồng bộ.
 */
export const listingPushQueue = defineQueue('channel.listing_push', ListingPushJobSchema, { attempts: 5, retryDelaySeconds: 30 });

/**
 * Việc đẩy các SKU của một sản phẩm cha thành phân loại của **một** sản phẩm sàn (#295, Documents/21 §18.8.4): dòng
 * `shop_products` `app` chưa có mã sàn thì tạo sản phẩm nhiều phân loại, có rồi thì thêm phân loại (`addVariants`). Listing
 * của lượt là các dòng `pushing` trỏ `shopProductId` chưa có SKU sàn; `pushStartedAt` (ISO) là mốc lượt: lượt mới hơn ghi đè
 * mốc trên dòng thì việc cũ bỏ. Hàng, số lần thử như `channel.listing_push`.
 */
export const ProductPushJobSchema = JobDataSchema.extend({
  shopId: z.uuid(),
  shopProductId: z.uuid(),
  pushStartedAt: z.iso.datetime(),
  imageUrls: z.array(z.string()).max(PUSH_IMAGE_MAX),
  sizeChartUrl: z.string().nullish(),
});
export type ProductPushJob = z.infer<typeof ProductPushJobSchema>;
export const productPushQueue = defineQueue('channel.product_push', ProductPushJobSchema, { attempts: 5, retryDelaySeconds: 30 });

/**
 * Đổi category của một sản phẩm trên một gian hàng (`apply-category`, #467, Documents/21 §18.5): `listingIds` là các listing
 * của sản phẩm sàn `externalProductId` vừa chuyển `category_change = queued`, `toCategoryId` là category của spec lúc bấm.
 */
export const CategoryApplyJobSchema = JobDataSchema.extend({
  shopId: z.uuid(),
  productId: z.uuid(),
  externalProductId: z.string().min(1),
  listingIds: z.array(z.uuid()).min(1),
  toCategoryId: z.string().min(1),
});
export type CategoryApplyJob = z.infer<typeof CategoryApplyJobSchema>;
/**
 * Việc đổi category (`runCategoryApply`, `category-apply.ts`). Như `channel.listing_push`: hàng `standard` (chống trùng ở CSDL:
 * chỉ listing vừa chuyển `queued` mới xếp việc), thử 5 lần, lần đầu sau 30 giây, gấp đôi; lần thứ 5 trước mốc 30 phút.
 */
export const categoryApplyQueue = defineQueue('channel.category_apply', CategoryApplyJobSchema, { attempts: 5, retryDelaySeconds: 30 });

/** Xếp việc đổi category, đi chung giao dịch vừa ghi `queued` (rollback thì không còn việc). */
export async function sendCategoryApply(job: CategoryApplyJob): Promise<void> {
  await sendJob(categoryApplyQueue, job);
}

/**
 * Lượt Tải lại SKU sàn chạy nền (`runRemoteSkusRefresh`, #361, Documents/21 §18.3): đọc sản phẩm sửa từ lần trước rồi đọc
 * trọn. Không lịch: xếp khi bấm Tải lại hay mở trang ghép lần đầu. Mỗi gian hàng một lượt (`stately`, khoá gian hàng). Thử
 * 2 lần, lần sau cách 30 giây (lỗi `incomplete_list` do danh sách đổi giữa chừng hay qua ở lần sau); cho chạy tới 15 phút,
 * đúng mốc `refresh_stale` (`REFRESH_STALE_MS`).
 */
export const remoteSkusRefreshQueue = defineQueue('channel.remote_skus_refresh', ShopJobSchema, {
  policy: 'stately',
  attempts: 2,
  retryDelaySeconds: 30,
  expireInSeconds: REFRESH_STALE_MS / 1000,
});

/** Ghép SKU dựng spec từ sàn (#400 lát 12): các listing vừa ghép có hiệu lực của một gian hàng. */
export const SpecFromMatchJobSchema = JobDataSchema.extend({ shopId: z.uuid(), listingIds: z.array(z.uuid()).min(1).max(200) });
export type SpecFromMatchJob = z.infer<typeof SpecFromMatchJobSchema>;
/**
 * Đọc category, attribute của sản phẩm trên sàn cho listing vừa ghép (`runSpecFromMatch`). Hàng `standard` (mỗi lần ghép
 * một việc, chạy lại vô hại: chỉ ghi cột thông tin và chèn spec khi chưa có). Thử 3 lần, cách 60 giây.
 */
export const specFromMatchQueue = defineQueue('channel.spec_from_match', SpecFromMatchJobSchema, { attempts: 3, retryDelaySeconds: 60 });

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
export async function sendListingSync(companyId: string, shopId: string): Promise<boolean> {
  return (await sendJob(listingSyncQueue, { companyId, shopId }, { key: shopId })) !== null;
}

/** Xếp một lượt đẩy tồn, giá đang chờ của gian hàng; đã có việc chờ cùng gian hàng thì không thêm. Đi chung giao dịch đang mở. */
export async function sendStockPush(companyId: string, shopId: string): Promise<void> {
  await sendJob(stockPushQueue, { companyId, shopId }, { key: shopId });
}

/** Xếp việc đẩy một listing, đi chung giao dịch vừa chuyển listing sang `pushing` (rollback thì không còn việc). */
export async function sendListingPush(job: ListingPushJob): Promise<void> {
  await sendJob(listingPushQueue, job);
}

/** Xếp việc đẩy theo cha (#295), đi chung giao dịch vừa chuyển các listing sang `pushing`. */
export async function sendProductPush(job: ProductPushJob): Promise<void> {
  await sendJob(productPushQueue, job);
}

/** Xếp một lượt Tải lại SKU sàn; đã có việc chờ cùng gian hàng thì không thêm. Đi chung giao dịch đang mở. */
export async function sendRemoteSkusRefresh(companyId: string, shopId: string): Promise<void> {
  await sendJob(remoteSkusRefreshQueue, { companyId, shopId }, { key: shopId });
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
