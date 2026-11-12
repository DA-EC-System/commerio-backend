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
    // Mốc kéo yêu cầu trả (#202): lúc bắt đầu lượt kéo xong trọn gần nhất.
    lastReturnSyncAt: timestamp('last_return_sync_at', { withTimezone: true }),
    settlementCursor: timestamp('settlement_cursor', { withTimezone: true }),
    lastError: text('last_error'),
    disconnectedAt: timestamp('disconnected_at', { withTimezone: true }),
    // Thiết lập theo #198 (Documents/21 §18.6.2, §18.7.7). `opening_stock_mode` null = thiết lập trước #198.
    /** Phiếu kiểm kê đầu kỳ đang chờ ghi sổ; khác null là gian hàng `active` ở chế độ chờ kiểm kê lần đầu. */
    openingStocktakeId: uuid('opening_stocktake_id'),
    openingStocktakeNumber: text('opening_stocktake_number'),
    openingStockMode: text('opening_stock_mode').$type<'push' | 'stocktake'>(),
    /**
     * Lần đọc trọn danh sách SKU của gian hàng gần nhất (bản sao `remote_skus`, #220 đợt 2); null là chưa có bản sao.
     * Số SKU chưa ghép đếm từ bản sao lúc đọc, không lưu cột (bỏ `unmatched_sku_count`).
     */
    remoteSkusSyncedAt: timestamp('remote_skus_synced_at', { withTimezone: true }),
    /** Mốc cho lần đọc "sản phẩm sửa từ lần trước" tiếp theo: giờ bắt đầu của lần làm mới bản sao gần nhất. */
    remoteSkusChangedSince: timestamp('remote_skus_changed_since', { withTimezone: true }),
    /**
     * Lượt đọc trọn định kỳ lỗi liên tiếp, và mốc sớm nhất được thử lại (1 giờ, 2 giờ, … tối đa 24 giờ; review #309 vòng 3
     * R1). Đọc trọn được (kể cả Tải lại) thì về 0 / null. Tải lại không chờ mốc.
     */
    remoteSkusFullFailures: integer('remote_skus_full_failures').notNull().default(0),
    remoteSkusFullRetryAt: timestamp('remote_skus_full_retry_at', { withTimezone: true }),
    /** Lần đọc trọn lỗi gần nhất (định kỳ hay Tải lại): Tải lại trong 10 phút sau đó trả 429 (review #309 vòng 4 B2). */
    remoteSkusFullFailedAt: timestamp('remote_skus_full_failed_at', { withTimezone: true }),
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
    /**
     * Giờ bắt đầu của lượt lấy đơn gần nhất chạy xong trọn (không lỗi, không còn trang), không lùi (#223). Mất uỷ quyền,
     * chưa có mốc này hoặc mốc cũ hơn `ORDERS_STALE_MS` là "đơn chưa cập nhật": SKU có listing trên gian hàng này không
     * được cập nhật tồn lên mọi gian hàng của công ty (`domain/shop.ts` `ordersStale`; Documents/19 `shops`, 21 §18.6.6).
     */
    ordersPulledOkAt: timestamp('orders_pulled_ok_at', { withTimezone: true }),
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
      sql`${t.openingStockMode} is null or ${t.openingStockMode} in ('push', 'stocktake')`,
    ),
    check('shops_open_orders_skipped', sql`${t.openOrdersSkipped} >= 0`),
    check(
      'shops_remote_skus_retry',
      sql`${t.remoteSkusFullFailures} >= 0 and (${t.remoteSkusFullFailures} = 0) = (${t.remoteSkusFullRetryAt} is null)`,
    ),
    check('shops_remote_skus_failed_at', sql`${t.remoteSkusFullFailures} = 0 or ${t.remoteSkusFullFailedAt} is not null`),
    // Chờ phân hàng chỉ có sau khi đã thoát chờ kiểm kê, ở gian hàng đã có mốc (#198).
    check(
      'shops_allocation_pending',
      sql`${t.allocationStocktakeId} is null or (${t.openingStocktakeId} is null and ${t.orderCutoffAt} is not null)`,
    ),
    check('shops_orders_pulled_ok_at', sql`${t.ordersPulledOkAt} is null or ${t.orderCutoffAt} is not null`),
    // Mất uỷ quyền thì xoá mốc: nối lại là "đơn chưa cập nhật" tới khi lấy đơn xong trọn (25 E28, #223).
    check('shops_reauth_orders_pulled', sql`${t.status} <> 'needs_reauth' or ${t.ordersPulledOkAt} is null`),
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
    /**
     * Ghép chờ CEO duyệt (#220, Documents/19, 21 §18.6.5): ghép sang "không quản tồn" hoặc đổi ghép đã có đơn do người
     * không phải CEO làm. `pending_mode = 'unmanaged'` thì `pending_variant_id` trống. Duyệt thì chép sang `mode`,
     * `variant_id`; từ chối thì xoá bốn cột này.
     */
    pendingVariantId: uuid('pending_variant_id'),
    pendingMode: listingMode('pending_mode'),
    pendingRequestedBy: uuid('pending_requested_by'),
    pendingRequestedAt: timestamp('pending_requested_at', { withTimezone: true }),
    /** Ghép hiện hành do CEO (hoặc công ty một người) tự làm ở bước cần CEO duyệt (25 §11 ngoại lệ tự duyệt). */
    mappingSelfApproved: boolean('mapping_self_approved').notNull().default(false),
    /**
     * Người xin ghép hiện hành, giữ lại sau khi duyệt (`pending_requested_by` bị xoá lúc duyệt) để CSDL ép người duyệt khác
     * người xin (Documents/19 mục 2 "Người duyệt khác", #220). Null với dòng có trước #220 hay chưa từng qua bước duyệt.
     */
    mappingRequestedBy: uuid('mapping_requested_by'),
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
    // "Không quản tồn" có hiệu lực phải có CEO duyệt; dòng mới tạo chờ duyệt ghép sang "không quản tồn" (#220) chưa có.
    check(
      'listings_unmanaged_approved',
      sql`${t.mode} = 'mapped' or ${t.approvedBy} is not null or ${t.pendingRequestedBy} is not null`,
    ),
    check(
      'listings_pending_mapping',
      sql`(${t.pendingMode} is null and ${t.pendingVariantId} is null and ${t.pendingRequestedBy} is null and ${t.pendingRequestedAt} is null)
        or (${t.pendingRequestedBy} is not null and ${t.pendingRequestedAt} is not null and ${t.pendingMode} is not null and (${t.pendingMode} = 'mapped') = (${t.pendingVariantId} is not null))`,
    ),
    // Người duyệt khác người xin ghép, trừ tự duyệt (CEO, công ty một người): cùng mẫu với `self_approved` của bảng khác.
    // Gỡ là trạng thái cuối: mọi đường gỡ (tay, sàn xoá, ngắt) phải bỏ ghép chờ duyệt cùng lúc (#220 đợt 2).
    check('listings_delisted_no_pending', sql`${t.status} <> 'delisted' or ${t.pendingRequestedBy} is null`),
    check('listings_self_approved_has_approver', sql`not ${t.mappingSelfApproved} or ${t.approvedBy} is not null`),
    check(
      'listings_mapping_second_person',
      sql`${t.approvedBy} is null or ${t.mappingRequestedBy} is null or ${t.approvedBy} <> ${t.mappingRequestedBy} or ${t.mappingSelfApproved}`,
    ),
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
  (t) => [
    unique().on(t.shopId, t.externalOrderId),
    index().on(t.orderId),
    // "Gian hàng đã nhận đơn có món mang SellerSku này" (`hasOrdersWithSellerSku`, #220): `payload -> 'lines' @> …`.
    index('raw_orders_lines_gin').using('gin', sql`(${t.payload} -> 'lines') jsonb_path_ops`),
  ],
);

/**
 * Bản sao danh sách SKU của gian hàng trên sàn (#220 đợt 2, Documents/21 §18.3 "đọc từ lần đồng bộ gần nhất"): trang
 * ghép, kiểm SKU khi ghép và số SKU chưa ghép đọc từ đây, không gọi sàn mỗi lần. Ghi bằng `service/remote-skus.ts`: đọc
 * trọn (thiết lập, Tải lại, mỗi ngày) hoặc đọc sản phẩm sửa từ lần trước (sau lượt đồng bộ listing). SKU sàn đã xoá thì
 * xoá dòng.
 */
export const remoteSkus = channelSchema.table(
  'remote_skus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    externalProductId: text('external_product_id').notNull(),
    externalSkuId: text('external_sku_id').notNull(),
    /** SKU người bán trên sàn; rỗng khi sàn không có (không ghép được tới khi đặt trên sàn). */
    sellerSku: text('seller_sku').notNull(),
    title: text('title').notNull(),
    state: text('state').notNull().$type<'review' | 'live' | 'rejected' | 'hold' | 'inactive'>(),
    quantity: integer('quantity').notNull(),
    /** Lần gần nhất đọc thấy SKU này trên sàn. */
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('remote_skus_shop_external_sku_uq').on(t.shopId, t.externalSkuId),
    check('remote_skus_state', sql`${t.state} in ('review', 'live', 'rejected', 'hold', 'inactive')`),
    check('remote_skus_quantity', sql`${t.quantity} >= 0`),
  ],
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

/**
 * Thư báo gian hàng sắp hết hoặc đã mất uỷ quyền đã xếp (#312, Documents/19). Mỗi dòng là một thư cho CEO, Admin.
 * `deadline` là hạn đang tính: `expiring_3d`, `expiring_1d` lấy hạn gần hơn trong `auth_expires_at`, `refresh_expires_at`;
 * `lost` lấy lúc chuyển sang `needs_reauth` (`core.state_transitions`), `seq` là nhịp 6 giờ thứ mấy kể từ lúc đó.
 * Chống trùng ép ở CSDL, dù việc nền chạy lại hay chạy trùng:
 * - unique `(shop_id, deadline, stage, seq)`;
 * - EXCLUDE `shop_reauth_mails_deadline_drift` (migration viết tay, Drizzle không sinh được): hai thư trước hạn cùng gian
 *   hàng, cùng mốc mà hạn cách nhau dưới 1 giờ là một mốc. Hạn tính lại từ "số giây còn lại" sau mỗi lần làm mới token
 *   lệch vài mili giây tới vài giây; hạn gia hạn thật hay nối lại thì cách xa, tính lại từ đầu.
 * Kết quả gửi: `outcome` null là chưa xong (`sent` đã gửi, `stale` bỏ vì gian hàng đã đổi hoặc mốc sau đã thay, `failed`
 * lỗi vĩnh viễn, không có người nhận, hoặc hết lượt xếp lại). `attempts` là số lần đã phát sự kiện, `queued_at` lần
 * phát gần nhất: việc nền phát lại thư chưa xong khi outbox đã bỏ cuộc (SMTP hỏng lâu). `commerio_app` chỉ UPDATE được
 * bốn cột kết quả, không DELETE (migration viết tay).
 */
export const shopReauthMails = channelSchema.table(
  'shop_reauth_mails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    stage: text('stage').$type<'expiring_3d' | 'expiring_1d' | 'lost'>().notNull(),
    deadline: timestamp('deadline', { withTimezone: true }).notNull(),
    seq: integer('seq').notNull().default(0),
    outcome: text('outcome').$type<'sent' | 'stale' | 'failed'>(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(1),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('shop_reauth_mails_milestone_uq').on(t.shopId, t.deadline, t.stage, t.seq),
    check('shop_reauth_mails_stage', sql`${t.stage} in ('expiring_3d', 'expiring_1d', 'lost')`),
    // Thư trước hạn chỉ một thư mỗi mốc; chỉ thư sau khi mất quyền mới lặp theo nhịp.
    check('shop_reauth_mails_seq', sql`${t.seq} >= 0 and (${t.stage} = 'lost' or ${t.seq} = 0)`),
    check('shop_reauth_mails_outcome', sql`${t.outcome} in ('sent', 'stale', 'failed')`),
    check('shop_reauth_mails_finished', sql`(${t.outcome} is null) = (${t.finishedAt} is null)`),
    // Trần `REAUTH_MAIL_MAX_ATTEMPTS` (8) ở `service/reauth-mail.ts`.
    check('shop_reauth_mails_attempts', sql`${t.attempts} between 1 and 8`),
    // Việc nền tìm thư chưa xong.
    index('shop_reauth_mails_pending_idx').on(t.queuedAt).where(sql`${t.outcome} is null`),
  ],
);
