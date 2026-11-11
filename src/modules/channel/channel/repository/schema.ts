import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module con `channel` khai báo trong schema của module lớn `channel` (Documents/19 D1).
export const channelSchema = pgSchema('channel');

export const marketplace = channelSchema.enum('marketplace', ['lazada', 'shopee', 'tiktok', 'mock']);
export type Marketplace = (typeof marketplace.enumValues)[number];
/** Mã sàn có trong enum DB (thêm sàn phải thêm giá trị enum, `Documents/tich-hop-san/README.md` bước 4). */
export const isMarketplace = (value: string): value is Marketplace => (marketplace.enumValues as readonly string[]).includes(value);
/** Gian hàng (25 §6.1, Documents/21 mục 18.1). "Sắp hết hạn" là nhãn phụ khi `active`, không phải trạng thái. */
export const shopStatus = channelSchema.enum('shop_status', ['connecting', 'active', 'needs_reauth', 'disconnected']);

// `variant_id` (product), `order_id` (order), bản cấu hình (finance) là uuid thường: không khoá ngoại chéo schema.

/**
 * Gian hàng sàn đã kết nối, định danh bằng (sàn, mã shop của sàn); kết nối lại cùng shop dùng lại bản ghi.
 * Token lưu đã mã hoá. `order_cutoff_at` là mốc kéo đơn chọn lúc thiết lập; `settlement_cursor` là mốc kéo quyết toán.
 */
export const shops = channelSchema.table(
  'shops',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    platform: marketplace('platform').notNull(),
    externalShopId: text('external_shop_id').notNull(),
    shopName: text('shop_name').notNull(),
    region: text('region'),
    accessTokenEnc: bytea('access_token_enc'),
    refreshTokenEnc: bytea('refresh_token_enc'),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true }),
    /** Hạn uỷ quyền seller chọn trên sàn, null khi sàn không có hạn riêng (Documents/19, 21 §18.4, #201). */
    authExpiresAt: timestamp('auth_expires_at', { withTimezone: true }),
    status: shopStatus('status').notNull().default('connecting'),
    orderCutoffAt: timestamp('order_cutoff_at', { withTimezone: true }),
    /** Hạn trả hàng (ngày) Admin nhập lúc thiết lập, cho sàn `returnWindow = 'days'` (Documents/21 §18.6.2). */
    returnWindowDays: integer('return_window_days'),
    lastOrderSyncAt: timestamp('last_order_sync_at', { withTimezone: true }),
    settlementCursor: timestamp('settlement_cursor', { withTimezone: true }),
    lastError: text('last_error'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    // Thiết lập theo #198 (Documents/21 §18.6.2, §18.7.7). `opening_stock_mode` null = thiết lập trước #198.
    /** Phiếu kiểm kê đầu kỳ đang chờ ghi sổ; khác null là gian hàng `active` ở chế độ chờ kiểm kê lần đầu. */
    openingStocktakeId: uuid('opening_stocktake_id'),
    openingStocktakeNumber: text('opening_stocktake_number'),
    openingStockMode: text('opening_stock_mode').$type<'push' | 'stocktake'>(),
    /** SKU sàn không tạo listing lúc thiết lập, kể cả SKU người dùng bỏ qua. */
    unmatchedSkuCount: integer('unmatched_sku_count'),
    /** Lượt kéo đơn còn mở sau thiết lập đã xong; null thì chưa đẩy tồn (A10). */
    openOrdersPulledAt: timestamp('open_orders_pulled_at', { withTimezone: true }),
    /** Số đơn còn mở cũ hơn không kéo về vì vượt trần `OPEN_ORDER_PULL_MAX`. */
    openOrdersSkipped: integer('open_orders_skipped').notNull().default(0),
    /** Lượt đẩy tồn đầu tiên sau thiết lập đã chạy. */
    stockPushedAt: timestamp('stock_pushed_at', { withTimezone: true }),
    /**
     * Phiếu đầu kỳ đã ghi sổ, gian hàng đang chờ phân hàng: thoát chờ khi nhận `fulfillment.allocation_done` có
     * `cause.documentId` trùng id này (Documents/21 §11.3, §18.6.11; Documents/19 `shops`). Giữ id vì
     * `opening_stocktake_id` đã về null. Sự kiện do `settleOpeningStocktake` phát trong chính giao dịch thoát chờ kiểm kê
     * nên không tới trước cột này; nhận trùng thì cột đã null, tự bị bỏ qua.
     */
    allocationStocktakeId: uuid('allocation_stocktake_id'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.platform, t.externalShopId),
    // Một seller chỉ gắn một công ty tại một thời điểm (#103 B3); đã ngắt thì công ty khác nối được.
    uniqueIndex('shops_platform_external_live_uq')
      .on(t.platform, t.externalShopId)
      .where(sql`${t.status} <> 'disconnected'`),
    check('shops_active_cutoff', sql`${t.status} <> 'active' or ${t.orderCutoffAt} is not null`),
    check('shops_return_window_days', sql`${t.returnWindowDays} between 1 and 60`),
    check(
      'shops_opening_stocktake',
      sql`(${t.openingStocktakeId} is null) = (${t.openingStocktakeNumber} is null) and (${t.openingStocktakeId} is null or ${t.orderCutoffAt} is not null)`,
    ),
    check(
      'shops_setup_mode',
      sql`(${t.openingStockMode} is null) = (${t.unmatchedSkuCount} is null) and (${t.openingStockMode} is null or ${t.openingStockMode} in ('push', 'stocktake'))`,
    ),
    check('shops_open_orders_skipped', sql`${t.openOrdersSkipped} >= 0`),
    // Chờ phân hàng chỉ có sau khi đã thoát chờ kiểm kê, ở gian hàng đã có mốc (#198).
    check(
      'shops_allocation_pending',
      sql`${t.allocationStocktakeId} is null or (${t.openingStocktakeId} is null and ${t.orderCutoffAt} is not null)`,
    ),
    // Một công ty một kho: hai phiếu đếm toàn kho có thể áp chênh lệch hai lần (#198 A12).
    uniqueIndex('shops_one_opening_stocktake_uq').on(t.companyId).where(sql`${t.openingStocktakeId} is not null`),
  ],
);

/** Listing (25 §6.4, Documents/21 mục 18.3). Chưa có dòng nghĩa là `not_listed`. */
export const listingStatus = channelSchema.enum('listing_status', [
  'pushing',
  'push_failed',
  'under_review',
  'rejected',
  'live',
  'hidden',
  'platform_hold',
  'delisted',
]);
/** `unmanaged`: SKU sàn ghép vào "không quản tồn" (combo), CEO duyệt; không trừ tồn, không đẩy tồn. */
export const listingMode = channelSchema.enum('listing_mode', ['mapped', 'unmanaged']);
export interface SyncError {
  code: string;
  message: string;
  at: string;
}
export const syncState = channelSchema.enum('sync_state', ['synced', 'pending', 'error']);
export const hiddenBy = channelSchema.enum('hidden_by', ['platform', 'zero_stock']);

/**
 * Một SKU trên một gian hàng, đồng thời là bảng ghép SKU sàn → SKU app. Mã sàn trống khi chưa đẩy lần nào.
 * Tồn và giá đồng bộ riêng (`stock_sync`, `price_sync`). `delisted_by_disconnect`: gỡ do ngắt, kết nối lại thì đưa lên.
 */
export const listings = channelSchema.table(
  'listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    mode: listingMode('mode').notNull().default('mapped'),
    variantId: uuid('variant_id'),
    externalProductId: text('external_product_id'),
    externalSkuId: text('external_sku_id'),
    sellerSku: text('seller_sku'),
    status: listingStatus('status').notNull().default('pushing'),
    rejectReason: text('reject_reason'),
    /** Lỗi của lượt đẩy (§18.6.4): `{ code, message, at }`; `code` là mã lỗi sàn hoặc mã chặn khi việc chạy (mô tả ở `ChannelListing.pushError`). */
    pushError: jsonb('push_error').$type<SyncError>(),
    pushAttempts: integer('push_attempts').notNull().default(0),
    pushStartedAt: timestamp('push_started_at', { withTimezone: true }),
    hiddenBy: hiddenBy('hidden_by'),
    stockSync: syncState('stock_sync').notNull().default('pending'),
    priceSync: syncState('price_sync').notNull().default('pending'),
    platformStock: integer('platform_stock'),
    /** Lỗi lần đẩy gần nhất của riêng SKU này (§18.4): `{ code, message, at }`, null khi đã đồng bộ. */
    stockSyncError: jsonb('stock_sync_error').$type<SyncError>(),
    priceSyncError: jsonb('price_sync_error').$type<SyncError>(),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    /** Ảnh đã đưa lên sàn (URL trên sàn), dùng lại cho lần đẩy sau. */
    externalImageUrls: text('external_image_urls').array(),
    listedPrice: money('listed_price'),
    manualPrice: money('manual_price'),
    priceCalcId: uuid('price_calc_id'),
    delistedByDisconnect: boolean('delisted_by_disconnect').notNull().default(false),
    approvedBy: uuid('approved_by'),
    /** Dòng `delisted` mà dòng này thay (đẩy lại sau khi gỡ, kết nối lại; Documents/19, 25 §6.1). */
    replacesListingId: uuid('replaces_listing_id').references((): AnyPgColumn => listings.id),
    ...timestamps,
    ...version,
  },
  (t) => [
    // `delisted` là trạng thái cuối: đẩy lại tạo dòng mới, nên hai ràng buộc chỉ áp cho dòng chưa gỡ (25 §6.4, #219).
    uniqueIndex('listings_shop_variant_uq')
      .on(t.shopId, t.variantId)
      .where(sql`${t.variantId} is not null and ${t.status} <> 'delisted'`),
    uniqueIndex('listings_shop_external_sku_uq')
      .on(t.shopId, t.externalSkuId)
      .where(sql`${t.externalSkuId} is not null and ${t.status} <> 'delisted'`),
    index().on(t.variantId),
    check('listings_mode', sql`(${t.mode} = 'mapped') = (${t.variantId} is not null)`),
    check('listings_unmanaged_approved', sql`${t.mode} = 'mapped' or ${t.approvedBy} is not null`),
    check('listings_hidden_by', sql`${t.hiddenBy} is null or ${t.status} in ('hidden', 'live')`),
    check('listings_reject_reason', sql`${t.status} <> 'rejected' or ${t.rejectReason} is not null`),
    check('listings_push_attempts', sql`${t.pushAttempts} >= 0`),
    check('listings_prices', sql`${t.listedPrice} >= 0 and ${t.manualPrice} >= 0`),
  ],
);

/**
 * Ghép danh mục Commerio → danh mục lá của sàn, kèm thuộc tính bắt buộc của danh mục đó (#104 A2). Đẩy sản phẩm thuộc
 * danh mục chưa ghép thì lỗi theo dòng `category_unmapped`.
 */
export const categoryMaps = channelSchema.table(
  'category_maps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    platform: marketplace('platform').notNull(),
    categoryId: uuid('category_id').notNull(),
    externalCategoryId: text('external_category_id').notNull(),
    attributes: jsonb('attributes').$type<Record<string, string>>().notNull().default({}),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.platform, t.categoryId)],
);

export const priceCalcStatus = channelSchema.enum('price_calc_status', ['pending_confirm', 'confirmed', 'pushed', 'superseded']);

/**
 * Một lần chạy bộ lọc giá cho một SKU trên một gian hàng (25 §6.2): lưu đầu vào, kết quả từng bước và phiên bản cấu
 * hình phí, thuế đã dùng, để biết giá trên sàn ra từ đâu. Đổi phí thì sinh lần mới `pending_confirm`, chờ xác nhận.
 */
export const priceCalculations = channelSchema.table(
  'price_calculations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    variantId: uuid('variant_id').notNull(),
    feeVersionId: uuid('fee_version_id'),
    taxVersionId: uuid('tax_version_id'),
    cost: money('cost').notNull(),
    targetNet: money('target_net').notNull(),
    rawPrice: money('raw_price').notNull(),
    roundedPrice: money('rounded_price').notNull(),
    netReceived: money('net_received').notNull(),
    marginPct: numeric('margin_pct', { precision: 7, scale: 2 }).notNull(),
    belowFloor: boolean('below_floor').notNull(),
    status: priceCalcStatus('status').notNull().default('pending_confirm'),
    confirmedBy: uuid('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.shopId, t.variantId),
    // Chặn đáy: giá dưới biên tối thiểu không được xác nhận để đẩy (E8).
    check('price_calculations_floor', sql`not ${t.belowFloor} or ${t.status} in ('pending_confirm', 'superseded')`),
    check('price_calculations_confirmed', sql`${t.status} not in ('confirmed', 'pushed') or ${t.confirmedBy} is not null`),
  ],
);

/** Dữ liệu gốc của đơn sàn mỗi lần cập nhật; `order_id` có khi đã tạo đơn trong `order`. */
export const rawOrders = channelSchema.table(
  'raw_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    orderId: uuid('order_id'),
    externalOrderId: text('external_order_id').notNull(),
    externalStatus: text('external_status'),
    payload: jsonb('payload').notNull(),
    externalUpdateTime: timestamp('external_update_time', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.shopId, t.externalOrderId), index().on(t.orderId)],
);

/** Webhook sàn đã nhận, chống xử lý lặp theo `notification_id`. */
export const webhookEvents = channelSchema.table(
  'webhook_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    platform: marketplace('platform').notNull(),
    notificationId: text('notification_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId, t.platform, t.notificationId)],
);

/**
 * Số lời gọi sàn trong một ngày (giờ Việt Nam) của cả app, mọi công ty cộng chung (#102 A7): hạn mức gọi do sàn đặt
 * cho app (Lazada 10.000/ngày). Không có `company_id` nên không RLS.
 */
export const apiUsage = channelSchema.table(
  'api_usage',
  {
    platform: marketplace('platform').notNull(),
    day: date('day').notNull(),
    calls: integer('calls').notNull(),
  },
  (t) => [primaryKey({ columns: [t.platform, t.day] })],
);
