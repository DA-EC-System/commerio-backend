import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, money, timestamps, version } from '../../../../shared/db/columns.ts';
import type {
  AttributeInput,
  AttributeKind,
  AttributeOption,
  AttributeTier,
  CategoryPermission,
  FieldSource,
  RemoteSpecFacts,
  RequiredWhen,
  SpecAttributeValue,
  SpecCategoryStatus,
} from '../domain/product-spec.ts';
import type { RemoteSkusFullError } from '../domain/remote-skus-refresh.ts';
import type { BlockerTarget } from '../domain/blocker.ts';
import type { PushErrorKind } from '../domain/platform-error.ts';

// Mọi bảng của module con `channel` khai báo trong schema của module lớn `channel` (Documents/19 D1).
export const channelSchema = pgSchema('channel');

/**
 * Danh mục sàn dùng chung cho mọi công ty (Documents/19 mục 3.3, thay enum `channel.marketplace` 21/11/2026). Dòng do
 * migration chèn; thêm sàn = adapter + một dòng `INSERT` (`Documents/tich-hop-san/README.md` bước 4). Tên hiển thị không lưu
 * ở đây: nguồn là `adapter.name`. Worker khởi động thì đối chiếu với registry adapter (`verifyMarketplaces`).
 * `commerio_app` chỉ đọc (migration `*_bang-san-fk`).
 */
export const marketplaces = channelSchema.table('marketplaces', {
  code: text('code').primaryKey(),
  /** `false`: sàn không mở cho người dùng ở môi trường này (sàn chưa có adapter, sàn giả lập `mock`). */
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Mã sàn, khoá của `channel.marketplaces`. Khoá ngoại của mọi cột `platform` viết tay ở migration `*_bang-san-fk`
 * (chèn dòng sàn trước rồi mới thêm khoá ngoại, `db:regen` chép migration viết tay ra sau migration sinh).
 */
export type Marketplace = string;
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
    platform: text('platform').notNull(),
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
    /**
     * Lỗi của lần đọc trọn lỗi gần nhất `{ code, platformCode, message }` (#361): `GET remote-skus` trả ở `refresh.error`.
     * Câu của BE, không chép câu thô của sàn. Đọc trọn được thì xoá cùng các mốc lỗi.
     */
    remoteSkusFullError: jsonb('remote_skus_full_error').$type<RemoteSkusFullError>(),
    /** Lượt Tải lại đang chờ hoặc chạy nền (#361); xoá khi xong hay lỗi. Quá 15 phút là kẹt (`refresh_stale`). */
    remoteSkusRefreshRequestedAt: timestamp('remote_skus_refresh_requested_at', { withTimezone: true }),
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
    // Có lỗi đọc trọn thì có giờ lỗi (#361).
    check('shops_remote_skus_full_error', sql`${t.remoteSkusFullError} is null or ${t.remoteSkusFullFailedAt} is not null`),
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
    // Đích của khoá ngoại ghép `shop_category_permissions_shop_company_fk` (#400, migration `*_category-san-quyen`).
    unique('shops_id_company_uq').on(t.id, t.companyId),
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
/**
 * Lỗi lần đẩy, đồng bộ gần nhất (jsonb). Trường sau `at` có từ #567 (Documents/21 §18.6.4): lỗi đẩy listing (#567) và lỗi sàn
 * của đồng bộ tồn, giá (#571) ghi; bản cũ và lỗi do app giữ (`price_missing`, `stock_not_counted`…) không có (API trả `null`).
 */
export interface SyncError {
  code: string;
  message: string;
  at: string;
  kind?: PushErrorKind;
  target?: BlockerTarget | null;
  variantId?: string | null;
  platformCode?: string | null;
  platformMessage?: string | null;
  requestId?: string | null;
}
export const syncState = channelSchema.enum('sync_state', ['synced', 'pending', 'error']);
export const hiddenBy = channelSchema.enum('hidden_by', ['platform', 'zero_stock']);
export const outsideChangeKind = channelSchema.enum('outside_change_kind', ['disabled', 'price_changed']);
/**
 * Ai tạo nội dung (tên, mô tả, ảnh, danh mục) của sản phẩm trên sàn (#399): `app` do app đẩy tạo; `platform` do người
 * bán tạo trên sàn rồi ghép. Đẩy lại listing `platform` chỉ bật lại SKU, không ghi nội dung của app.
 */
export const contentSource = channelSchema.enum('listing_content_source', ['app', 'platform']);
/** Bản sửa nội dung đang chờ sàn duyệt trong lúc listing vẫn bán (#293, Documents/21 §18.3). */
export const revisionStatus = channelSchema.enum('listing_revision_status', ['auditing', 'failed']);
/**
 * Lượt đổi category trên sàn của listing (`apply-category`, commerio-backend#467, Documents/21 §18.5): `queued` đã xếp việc
 * `channel.category_apply`, chưa xong; `failed` sàn từ chối hoặc hết lượt thử; `mismatch` sàn nhận nhưng đọc lại thấy lệch
 * SKU, giá, ảnh. `at` là chuỗi ISO lúc ghi trạng thái (lúc xếp việc với `queued`).
 */
export interface CategoryChange {
  status: 'queued' | 'failed' | 'mismatch';
  toCategoryId: string;
  toCategoryPath: string | null;
  code: string | null;
  message: string | null;
  attempts: number;
  at: string;
}

export const shopProductOrigin = channelSchema.enum('shop_product_origin', ['app', 'match']);
export const shopProductStatus = channelSchema.enum('shop_product_status', ['active', 'delisted', 'failed']);

/**
 * Một sản phẩm cha trên một gian hàng ứng với một sản phẩm trên sàn (commerio-backend#295, Documents/19 câu chốt Q1, 21
 * §18.8.4). `app`: app tạo bằng lần đẩy gom biến thể (`product_id` bắt buộc, mã sàn null tới khi sàn tạo xong); `match`:
 * sản phẩm sàn có sẵn mà listing trỏ tới (ghép SKU, dữ liệu đẩy trước #295), `product_id` null vì một sản phẩm người bán có
 * thể chứa SKU của nhiều sản phẩm Commerio. Luật "một cha một sản phẩm sàn" ép ở unique một phần theo `origin = 'app'`.
 * `failed`: lần tạo của dòng `app` bị sàn từ chối (gom lại, §18.8.4), lỗi ở `push_error`. `delisted`: sản phẩm sàn đã bị
 * thay (gom lại) hoặc sàn đã xoá. RLS `company_isolation`.
 */
export const shopProducts = channelSchema.table(
  'shop_products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    productId: uuid('product_id'),
    externalProductId: text('external_product_id'),
    origin: shopProductOrigin('origin').notNull(),
    status: shopProductStatus('status').notNull().default('active'),
    /** Lỗi của lần tạo gần nhất (`{ code, message, at }`), chỉ dòng `app`. */
    pushError: jsonb('push_error').$type<SyncError>(),
    /** Lúc bấm đẩy của lượt tạo đang chạy (dòng `app`): khoá chống tạo trùng `cm-sp-<id>-<mốc>` giữ qua các lần thử. */
    pushStartedAt: timestamp('push_started_at', { withTimezone: true }),
    /** Lần gọi tạo gần nhất (như `listings.create_attempted_at`, #399): phân biệt sản phẩm của lượt trước với sản phẩm người bán. */
    createAttemptedAt: timestamp('create_attempted_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    uniqueIndex('shop_products_shop_external_uq')
      .on(t.shopId, t.externalProductId)
      .where(sql`${t.externalProductId} is not null and ${t.status} = 'active'`),
    uniqueIndex('shop_products_shop_app_product_uq')
      .on(t.shopId, t.productId)
      .where(sql`${t.origin} = 'app' and ${t.status} = 'active'`),
    // Đích của khoá ngoại ghép từ `listings`: mã sàn của listing phải bằng mã sàn của dòng nó trỏ tới.
    unique('shop_products_id_external_uq').on(t.id, t.externalProductId),
    check('shop_products_origin', sql`(${t.origin} = 'app') = (${t.productId} is not null)`),
    check('shop_products_match_external', sql`${t.origin} = 'app' or ${t.externalProductId} is not null`),
    check('shop_products_failed', sql`${t.status} <> 'failed' or (${t.origin} = 'app' and ${t.externalProductId} is null and ${t.pushError} is not null)`),
  ],
);

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
    /**
     * Category thật của listing trên gian hàng này (#400, Documents/19 mục 3.3): ghi khi đẩy xong, khi ghép SKU đọc sàn và khi
     * đồng bộ thấy sàn đổi. Cột thông tin, ghi không tăng `version` (L029: không làm `runListingPush` bỏ kết quả).
     */
    externalCategoryId: text('external_category_id'),
    /** Lần đầu app gọi `createProduct` cho listing này (#399): mốc phân biệt sản phẩm app tạo với sản phẩm người bán có sẵn. Chỉ ghi khi null, không tăng `version`. */
    createAttemptedAt: timestamp('create_attempted_at', { withTimezone: true }),
    hiddenBy: hiddenBy('hidden_by'),
    /** Sàn đổi listing ngoài app (#360, 21 §18.3 `outsideChange`): dừng bán, chờ CEO quyết. Giá chỉ có khi `price_changed`. */
    outsideChangeKind: outsideChangeKind('outside_change_kind'),
    outsideChangePrice: money('outside_change_price'),
    outsideChangeAt: timestamp('outside_change_at', { withTimezone: true }),
    stockSync: syncState('stock_sync').notNull().default('pending'),
    priceSync: syncState('price_sync').notNull().default('pending'),
    platformStock: integer('platform_stock'),
    /** Lỗi lần đẩy gần nhất của riêng SKU này (§18.4): `{ code, message, at }`, null khi đã đồng bộ. */
    stockSyncError: jsonb('stock_sync_error').$type<SyncError>(),
    priceSyncError: jsonb('price_sync_error').$type<SyncError>(),
    lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
    /**
     * Lần sàn nhận giá app đẩy gần nhất (#360). So giá sàn bị sửa ngoài app chờ 15 phút sau mốc này; không dùng
     * `last_pushed_at` vì lần đẩy tồn cũng ghi mốc đó, SKU đổi tồn mỗi chu kỳ sẽ không bao giờ được so giá.
     */
    lastPricePushedAt: timestamp('last_price_pushed_at', { withTimezone: true }),
    /** Ảnh đã đưa lên sàn (URL trên sàn), dùng lại cho lần đẩy sau. */
    externalImageUrls: text('external_image_urls').array(),
    listedPrice: money('listed_price'),
    manualPrice: money('manual_price'),
    priceCalcId: uuid('price_calc_id').references((): AnyPgColumn => priceCalculations.id),
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
    /**
     * SKU sàn chờ CEO duyệt ghép vào listing lỗi đẩy chưa có mã sàn (#346, Documents/19): đổi SKU người bán mà đã có đơn
     * mang SKU người bán cũ. Duyệt thì chép sang `external_*`, `seller_sku`; từ chối thì xoá cùng bốn cột chờ duyệt.
     */
    pendingExternalSkuId: text('pending_external_sku_id'),
    pendingExternalProductId: text('pending_external_product_id'),
    pendingSellerSku: text('pending_seller_sku'),
    /** Ghép hiện hành do CEO (hoặc công ty một người) tự làm ở bước cần CEO duyệt (25 §11 ngoại lệ tự duyệt). */
    mappingSelfApproved: boolean('mapping_self_approved').notNull().default(false),
    /**
     * Người xin ghép hiện hành, giữ lại sau khi duyệt (`pending_requested_by` bị xoá lúc duyệt) để CSDL ép người duyệt khác
     * người xin (Documents/19 mục 2 "Người duyệt khác", #220). Null với dòng có trước #220 hay chưa từng qua bước duyệt.
     */
    mappingRequestedBy: uuid('mapping_requested_by'),
    /**
     * Bản sửa nội dung chờ sàn duyệt (`pendingRevision`, #293): ghi khi `update_content` mà sàn vẫn bán bản cũ; đồng bộ xoá
     * khi qua duyệt, ghi `failed` kèm lý do khi trượt. Giữ khi ẩn, sàn khoá; xoá khi rời các trạng thái đó.
     */
    revisionStatus: revisionStatus('revision_status'),
    revisionRejectReason: text('revision_reject_reason'),
    revisionAt: timestamp('revision_at', { withTimezone: true }),
    /**
     * Lượt đổi category trên sàn (`categoryChange`, commerio-backend#467): `{ status, toCategoryId, toCategoryPath, code,
     * message, attempts, at }`, null khi không có hoặc sàn đã nhận mà không lệch (trạng thái duyệt ở `revision_*`). Xoá khi gỡ.
     */
    categoryChange: jsonb('category_change').$type<CategoryChange>(),
    /** Mặc định `platform` (không rõ nguồn thì không ghi đè nội dung người bán); mọi chỗ tạo listing ghi rõ giá trị. */
    contentSource: contentSource('content_source').notNull().default('platform'),
    /**
     * Tên trên sàn lúc ghép (#396, 21 §18.3 `remoteTitleChanged`): mốc để biết người bán đổi tên ngoài app. Đặt khi ghép có
     * hiệu lực, thiết lập, xác nhận (từ bản sao) và khi app đẩy, sửa nội dung (tên app vừa gửi). `matched_at` null: tên
     * tiếng Anh lúc ghép chưa biết, lần ghi bản sao kế tiếp lấy `title_en` làm mốc; có giá trị thì chỉ bản sao đọc từ mốc
     * đó trở đi mới được so (lượt đọc bắt đầu trước khi đẩy xong còn tên cũ). `changed_at`: lúc thấy tên khác mốc.
     */
    remoteTitleAtMatch: text('remote_title_at_match'),
    remoteTitleEnAtMatch: text('remote_title_en_at_match'),
    remoteTitleMatchedAt: timestamp('remote_title_matched_at', { withTimezone: true }),
    remoteTitleChangedAt: timestamp('remote_title_changed_at', { withTimezone: true }),
    /** Dòng `delisted` mà dòng này thay (đẩy lại sau khi gỡ, kết nối lại; Documents/19, 25 §6.1). */
    replacesListingId: uuid('replaces_listing_id').references((): AnyPgColumn => listings.id),
    /**
     * Sản phẩm sàn của listing (#295, `shop_products`): có `external_product_id` thì bắt buộc, và hai mã sàn phải bằng nhau
     * (khoá ngoại ghép). Lần đẩy đầu của cha trỏ dòng `app` còn chưa có mã sàn.
     */
    shopProductId: uuid('shop_product_id').references(() => shopProducts.id),
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
    // Một SKU sàn không chờ ghép vào hai listing lỗi cùng lúc (#346).
    uniqueIndex('listings_shop_pending_external_sku_uq')
      .on(t.shopId, t.pendingExternalSkuId)
      .where(sql`${t.pendingExternalSkuId} is not null`),
    index().on(t.variantId),
    index().on(t.shopProductId),
    foreignKey({
      name: 'listings_shop_product_external_fk',
      columns: [t.shopProductId, t.externalProductId],
      foreignColumns: [shopProducts.id, shopProducts.externalProductId],
    }),
    // CHECK `listings_shop_product` (có mã sản phẩm sàn thì có `shop_product_id`, #295) viết tay ở migration `*_san-pham-san-du-lieu`, sau bước điền dữ liệu.
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
    // SKU sàn chờ ghép chỉ có trên listing lỗi đẩy chưa có mã sàn, đang chờ duyệt; ba cột cùng có hoặc cùng trống (#346).
    check(
      'listings_pending_external',
      sql`(${t.pendingExternalSkuId} is null and ${t.pendingExternalProductId} is null and ${t.pendingSellerSku} is null)
        or (${t.pendingExternalSkuId} is not null and ${t.pendingExternalProductId} is not null and ${t.pendingSellerSku} is not null
          and ${t.pendingRequestedBy} is not null and ${t.status} = 'push_failed' and ${t.externalSkuId} is null)`,
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
    check(
      'listings_outside_change',
      sql`(${t.outsideChangeKind} is null and ${t.outsideChangePrice} is null and ${t.outsideChangeAt} is null) or (${t.outsideChangeKind} is not null and ${t.status} = 'hidden' and ${t.outsideChangeAt} is not null and (${t.outsideChangeKind} = 'price_changed') = (${t.outsideChangePrice} is not null))`,
    ),
    check(
      'listings_revision',
      sql`(${t.revisionStatus} is null) = (${t.revisionAt} is null)
        and (${t.revisionRejectReason} is null or ${t.revisionStatus} = 'failed')
        and (${t.revisionStatus} is null or ${t.status} in ('live', 'hidden', 'platform_hold'))`,
    ),
    // Không có mốc tên thì không có mốc tiếng Anh, giờ mốc; cờ chỉ bật khi mốc đã có giờ (mỗi nhánh tự chặn NULL, L024).
    check(
      'listings_remote_title',
      sql`(${t.remoteTitleAtMatch} is not null or (${t.remoteTitleEnAtMatch} is null and ${t.remoteTitleMatchedAt} is null))
        and (${t.remoteTitleChangedAt} is null or ${t.remoteTitleMatchedAt} is not null)`,
    ),
    // Gỡ là trạng thái cuối: lượt đổi category không còn đối tượng (#467).
    check(
      'listings_category_change',
      sql`${t.categoryChange} is null or (${t.status} <> 'delisted' and ${t.categoryChange} ->> 'status' in ('queued', 'failed', 'mismatch'))`,
    ),
    check('listings_reject_reason', sql`${t.status} <> 'rejected' or ${t.rejectReason} is not null`),
    check('listings_push_attempts', sql`${t.pushAttempts} >= 0`),
    check('listings_prices', sql`${t.listedPrice} >= 0 and ${t.manualPrice} >= 0`),
  ],
);

export type CategoryStatus = 'active' | 'removed';
export type SizeChartRule = 'required' | 'optional' | 'unsupported';

/**
 * Bản sao cây category của sàn (#400, Documents/19 mục 3.3). Dữ liệu tham chiếu của nền tảng, giống nhau mọi khách thuê:
 * không `company_id`, không RLS; `commerio_app` chỉ `SELECT` (migration `*_category-san-quyen`), ghi bằng role chủ bảng
 * ngoài `withCompany` (Documents/19 mục 2). Category sàn bỏ thì `status = 'removed'`, không xoá dòng (spec cũ còn trỏ tới).
 * `synced_at` null là dòng tạm (leaf mới thấy khi lấy attribute, trước lượt đồng bộ cây): tìm kiếm bỏ qua, đồng bộ ghi đè.
 * `attributes_fetched_at`: lần lấy attribute gần nhất, kể cả khi leaf không có attribute nào (dùng lại 7 ngày).
 */
export const platformCategories = channelSchema.table(
  'platform_categories',
  {
    platform: text('platform').notNull(),
    externalId: text('external_id').notNull(),
    parentExternalId: text('parent_external_id'),
    name: text('name').notNull(),
    isLeaf: boolean('is_leaf').notNull(),
    path: text('path').notNull(),
    /** Đường dẫn đã bỏ dấu (cả `đ` → `d`), chữ thường: `normalizePath` ở `domain/product-spec.ts`. */
    pathSearch: text('path_search').notNull(),
    status: text('status').$type<CategoryStatus>().notNull().default('active'),
    syncedAt: timestamp('synced_at', { withTimezone: true }),
    /** Luật bảng kích cỡ (#347), lấy cùng lúc với attribute của leaf; null là chưa hỏi. */
    sizeChartRule: text('size_chart_rule').$type<SizeChartRule>(),
    attributesFetchedAt: timestamp('attributes_fetched_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.platform, t.externalId] }),
    index('platform_categories_parent_idx').on(t.platform, t.parentExternalId),
    index('platform_categories_path_search_trgm').using('gin', t.pathSearch.op('gin_trgm_ops')),
    check('platform_categories_status', sql`${t.status} in ('active', 'removed')`),
    check('platform_categories_size_chart_rule', sql`${t.sizeChartRule} in ('required', 'optional', 'unsupported')`),
  ],
);

/**
 * Attribute của một leaf category (#400, Documents/19 mục 3.3). Lấy khi có người mở leaf (route chi tiết, `PUT` spec, việc
 * nền), dùng lại 7 ngày; mỗi lần lấy thay cả tập của leaf (`replaceLeaf`). `code`: Lazada `name`, TikTok id attribute.
 * Không `company_id`, không RLS, `commerio_app` chỉ `SELECT` như `platform_categories`.
 */
export const platformCategoryAttributes = channelSchema.table(
  'platform_category_attributes',
  {
    platform: text('platform').notNull(),
    externalCategoryId: text('external_category_id').notNull(),
    code: text('code').notNull(),
    label: text('label').notNull(),
    kind: text('kind').$type<AttributeKind>().notNull(),
    input: text('input').$type<AttributeInput>().notNull(),
    options: jsonb('options').$type<AttributeOption[]>().notNull().default([]),
    allowCustom: boolean('allow_custom').notNull().default(false),
    required: boolean('required').notNull().default(false),
    requiredWhen: jsonb('required_when').$type<RequiredWhen[] | null>(),
    isKey: boolean('is_key').notNull().default(false),
    tier: text('tier').$type<AttributeTier>().notNull(),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.platform, t.externalCategoryId, t.code] }),
    // Khoá ngoại `platform_category_attributes_category_fk` `(platform, external_category_id)` → `platform_categories` viết tay
    // ở migration `*_bang-san-fk`: đổi cột `platform` từ enum sang text phải gỡ khoá ngoại ghép trước rồi gắn lại (21/11/2026).
    check('platform_category_attributes_kind', sql`${t.kind} in ('sales', 'property')`),
    check(
      'platform_category_attributes_input',
      sql`${t.input} in ('select', 'multiselect', 'text', 'number', 'date', 'image', 'cascade')`,
    ),
    check('platform_category_attributes_tier', sql`${t.tier} in ('category', 'product', 'company')`),
  ],
);

/**
 * Quyền đăng category của một gian hàng, cho sàn có quyền category theo gian hàng (adapter khai, #400 A17). Ghi từ gợi ý và lần kiểm trước
 * khi đẩy, `checked_at` quá 7 ngày thì kiểm lại. RLS `company_isolation` (migration `*_category-san-quyen`).
 */
export const shopCategoryPermissions = channelSchema.table(
  'shop_category_permissions',
  {
    companyId: uuid('company_id').notNull(),
    // Khoá ngoại ghép `(shop_id, company_id) → shops(id, company_id)` (`shop_category_permissions_shop_company_fk`) viết
    // trong migration `*_category-san-quyen` (drizzle-kit sinh khoá ngoại trước unique đích, db/CLAUDE.md): RLS không chặn
    // role chủ bảng ghi `company_id` khác công ty của gian hàng (review BE1 P2-11).
    shopId: uuid('shop_id').notNull(),
    externalCategoryId: text('external_category_id').notNull(),
    status: text('status').$type<CategoryPermission>().notNull(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.shopId, t.externalCategoryId] }),
    check('shop_category_permissions_status', sql`${t.status} in ('available', 'invite_only', 'non_main_category', 'prohibited')`),
  ],
);

export type SpecSource = 'push' | 'match';

/**
 * Thông tin sàn của một sản phẩm cha, một bộ mỗi sàn, mọi gian hàng của sàn dùng chung (#400, Documents/19 mục 3.3). Thay
 * bảng spec cũ của catalog và ghép danh mục Commerio (xoá ở BE3, migration `*_bo-ghep-danh-muc`). `product_id` là uuid
 * thường (không khoá ngoại chéo schema).
 * `attributes` chỉ giữ attribute `tier = 'category'` (xuất xứ, thương hiệu ở catalog). `axis_map`: attributeId của trục
 * Commerio → mã sales attribute của sàn hoặc `__custom`; `value_map`: attributeValueId → mã lựa chọn của sàn.
 * `version = 0` là bản chép từ ghép danh mục cũ chưa ai lưu lại (#400 A18, migration `*_chep-spec-lan-cuoi`); `PUT` spec luôn
 * ra `version ≥ 1`. RLS.
 */
export const productSpecs = channelSchema.table(
  'product_specs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id').notNull(),
    platform: text('platform').notNull(),
    externalCategoryId: text('external_category_id').notNull(),
    attributes: jsonb('attributes').$type<Record<string, SpecAttributeValue>>().notNull().default({}),
    axisMap: jsonb('axis_map').$type<Record<string, string>>().notNull().default({}),
    valueMap: jsonb('value_map').$type<Record<string, string>>().notNull().default({}),
    source: text('source').$type<SpecSource>().notNull(),
    categoryStatus: text('category_status').$type<SpecCategoryStatus>().notNull().default('ok'),
    /** Nguồn từng attribute trong `attributes` (#497): `push`, `match`, `user`. */
    fieldSources: jsonb('field_sources').$type<Record<string, FieldSource>>().notNull().default({}),
    /** Bản sàn đang ghi ở lần đọc gần nhất khi ghép SKU (#497); bản có `remote_read_at` sau thắng. */
    remoteFacts: jsonb('remote_facts').$type<RemoteSpecFacts>(),
    remoteReadAt: timestamp('remote_read_at', { withTimezone: true }),
    /** Gian hàng đã đọc; xoá gian hàng thì null, tên còn trong `remote_facts.shopName`. */
    remoteShopId: uuid('remote_shop_id').references(() => shops.id, { onDelete: 'set null' }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique('product_specs_product_platform_uq').on(t.productId, t.platform),
    // Sản phẩm của công ty đang dùng một leaf (route chi tiết leaf), spec trỏ tới category bị bỏ (đồng bộ cây).
    index('product_specs_category_idx').on(t.platform, t.externalCategoryId),
    check('product_specs_source', sql`${t.source} in ('push', 'match')`),
    check('product_specs_category_status', sql`${t.categoryStatus} in ('ok', 'changed', 'removed')`),
    check('product_specs_version', sql`${t.version} >= 0`),
    check('product_specs_remote', sql`(${t.remoteFacts} is null) = (${t.remoteReadAt} is null)`),
  ],
);

/**
 * Ánh xạ thuộc tính phân loại của công ty sang sales attribute của sàn (#448, Documents/19 §3.3, Documents/21 §18.8.3 nguồn
 * 2): mỗi (thuộc tính, sàn) một danh sách mã theo `priority` (1 là ưu tiên nhất). Thuộc tính có `platform_kind` không cần
 * dòng: dùng mặc định của adapter; có dòng thì dòng thắng. `attribute_id` trỏ `product.attributes`, không có khoá ngoại chéo
 * schema. RLS (migration `*_anh-xa-truc-rls`).
 */
export const axisMappings = channelSchema.table(
  'axis_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL: ánh xạ nền tảng của thuộc tính chuẩn, dùng chung mọi công ty, chỉ migration ghi; có giá trị: của công ty. */
    companyId: uuid('company_id'),
    attributeId: uuid('attribute_id').notNull(),
    platform: text('platform').notNull(),
    /** Mã sales attribute của sàn (`platform_category_attributes.code`, `kind = 'sales'`). */
    attributeCode: text('attribute_code').notNull(),
    priority: smallint('priority').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('axis_mappings_code_uq').on(t.companyId, t.attributeId, t.platform, t.attributeCode),
    unique('axis_mappings_priority_uq').on(t.companyId, t.attributeId, t.platform, t.priority),
    // Hai unique trên chỉ giữ tầng công ty (NULL khác nhau); tầng nền tảng dùng partial index riêng.
    uniqueIndex('axis_mappings_platform_code_uq').on(t.attributeId, t.platform, t.attributeCode).where(sql`${t.companyId} IS NULL`),
    uniqueIndex('axis_mappings_platform_priority_uq').on(t.attributeId, t.platform, t.priority).where(sql`${t.companyId} IS NULL`),
    check('axis_mappings_priority', sql`${t.priority} >= 1`),
  ],
);

/**
 * Ánh xạ một thông số của công ty (`catalog.spec_fields`, uuid thường) sang attribute của một sàn (#509, Documents/19 mục
 * 3.3, 21 §18.8.1). Một thông số có thể ứng với nhiều mã trên cùng sàn (mã đổi theo category): lúc đẩy lấy mã có `priority`
 * nhỏ nhất mà leaf có; một mã của sàn chỉ nhận từ một thông số. Gợi ý ánh xạ tính lúc đọc, không lưu (§18.8.1). RLS.
 */
export const specFieldMappings = channelSchema.table(
  'spec_field_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** NULL: ánh xạ nền tảng của thông số chuẩn, dùng chung mọi công ty, chỉ migration ghi; có giá trị: của công ty. */
    companyId: uuid('company_id'),
    fieldId: uuid('field_id').notNull(),
    platform: text('platform').notNull(),
    /** Mã attribute của sàn: TikTok `attribute_id`, Lazada `name`. */
    attributeCode: text('attribute_code').notNull(),
    priority: integer('priority').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('spec_field_mappings_code_uq').on(t.companyId, t.fieldId, t.platform, t.attributeCode),
    unique('spec_field_mappings_priority_uq').on(t.companyId, t.fieldId, t.platform, t.priority),
    unique('spec_field_mappings_attribute_uq').on(t.companyId, t.platform, t.attributeCode),
    // `code_uq`, `priority_uq`, `attribute_uq` chỉ giữ tầng công ty (NULL khác nhau). `field_code_uq` giữ cả hai tầng (mỗi
    // thông số thuộc đúng một tầng) và là đích khoá ngoại của `spec_option_mappings`; `code_uq` thừa so với nó nhưng giữ lại vì
    // khoá ngoại cũ trỏ vào và drizzle bỏ unique trước khi bỏ khoá ngoại. Chéo tầng (thông số riêng lấy mã của thông số chuẩn)
    // do service kiểm, vì công ty đọc được cả hai tầng.
    unique('spec_field_mappings_field_code_uq').on(t.fieldId, t.platform, t.attributeCode),
    uniqueIndex('spec_field_mappings_platform_priority_uq').on(t.fieldId, t.platform, t.priority).where(sql`${t.companyId} IS NULL`),
    uniqueIndex('spec_field_mappings_platform_attribute_uq').on(t.platform, t.attributeCode).where(sql`${t.companyId} IS NULL`),
    check('spec_field_mappings_priority', sql`${t.priority} >= 1`),
  ],
);

/**
 * Ánh xạ một lựa chọn của thông số sang lựa chọn chuẩn của sàn, theo đúng mã attribute (#509). `company_id` là tầng của lựa
 * chọn: NULL là lựa chọn chuẩn (nền tảng, chỉ migration ghi); công ty là lựa chọn riêng, kể cả lựa chọn riêng thêm vào thông số
 * chuẩn (dòng mã là dòng nền tảng). Khoá ngoại `spec_option_mappings_field_fk` `(field_id, platform, attribute_code)` →
 * `spec_field_mappings_field_code_uq` `ON DELETE CASCADE` (bỏ mã thì bỏ luôn ánh xạ lựa chọn của mã đó) không kèm
 * `company_id`, vì lựa chọn riêng trỏ dòng mã nền tảng. Khoá ngoại đặt ở migration viết tay `*_anh-xa-hai-tang-du-lieu`, không
 * khai ở đây: drizzle sinh câu thêm khoá ngoại trước câu tạo unique nó trỏ tới. RLS.
 */
export const specOptionMappings = channelSchema.table(
  'spec_option_mappings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id'),
    fieldId: uuid('field_id').notNull(),
    optionId: uuid('option_id').notNull(),
    platform: text('platform').notNull(),
    attributeCode: text('attribute_code').notNull(),
    platformOptionId: text('platform_option_id').notNull(),
    ...timestamps,
  },
  // Mỗi lựa chọn thuộc đúng một tầng nên không kèm company_id.
  (t) => [unique('spec_option_mappings_option_uq').on(t.optionId, t.platform, t.attributeCode)],
);

export type PriceCalcTrigger = 'push' | 'target_changed' | 'config_activated' | 'cost';
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
    /** Bản `tax_rules` đã dùng. */
    taxVersionId: uuid('tax_version_id'),
    taxRegimeVersionId: uuid('tax_regime_version_id'),
    minMarginVersionId: uuid('min_margin_version_id'),
    /** Giá vốn bước 5 (#225); null khi chưa có, khi đó không có cờ Dưới giá thấp nhất. */
    cost: money('cost'),
    targetNet: money('target_net').notNull(),
    perItemFee: money('per_item_fee').notNull().default('0'),
    feePct: numeric('fee_pct', { precision: 5, scale: 2 }).notNull(),
    taxPct: numeric('tax_pct', { precision: 7, scale: 4 }).notNull(),
    minMarginPct: numeric('min_margin_pct', { precision: 5, scale: 2 }),
    rawPrice: money('raw_price').notNull(),
    roundedPrice: money('rounded_price').notNull(),
    netReceived: money('net_received').notNull(),
    marginPct: numeric('margin_pct', { precision: 7, scale: 2 }),
    belowFloor: boolean('below_floor'),
    /**
     * Vì sao có lần tính: đẩy lần đầu, đổi giá muốn bán, kích hoạt cấu hình, giá vốn tăng làm giá đang bán dưới giá thấp
     * nhất (`cost`, #225: `target_net` là max(giá muốn bán, giá thấp nhất làm tròn lên đồng)).
     */
    trigger: text('trigger').$type<PriceCalcTrigger>().notNull(),
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
    check('price_calculations_cost_floor', sql`(${t.cost} is null) = (${t.belowFloor} is null)`),
    check('price_calculations_trigger', sql`${t.trigger} in ('push', 'target_changed', 'config_activated', 'cost')`),
    uniqueIndex('price_calculations_one_pending').on(t.shopId, t.variantId).where(sql`${t.status} = 'pending_confirm'`),
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
    /** Tên tiếng Anh trên sàn (Lazada `name_en`, #396); null khi sàn không có. */
    titleEn: text('title_en'),
    state: text('state').notNull().$type<'review' | 'live' | 'rejected' | 'hold' | 'inactive'>(),
    quantity: integer('quantity').notNull(),
    /**
     * Giá gốc trên sàn lúc đọc (`RemoteSku.price`: Lazada `skus[].price`, TikTok `tax_exclusive_price`), để hộp ghép so với
     * giá app (#460). null khi sàn không trả hoặc bản sao đọc trước #460.
     */
    price: money('price'),
    /** Lần gần nhất đọc thấy SKU này trên sàn. */
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('remote_skus_shop_external_sku_uq').on(t.shopId, t.externalSkuId),
    check('remote_skus_state', sql`${t.state} in ('review', 'live', 'rejected', 'hold', 'inactive')`),
    check('remote_skus_quantity', sql`${t.quantity} >= 0`),
    check('remote_skus_price', sql`${t.price} >= 0`),
  ],
);

/**
 * Webhook sàn đã nhận, chống xử lý lặp theo `notification_id`.
 * @deprecated Không dùng: MVP không nhận push của sàn (#133, #135), kéo định kỳ là đường nhận đơn duy nhất. Xoá ở migration sau.
 */
export const webhookEvents = channelSchema.table(
  'webhook_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    platform: text('platform').notNull(),
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
 * Số lời gọi sàn trong một ngày (giờ Việt Nam) (#102 A7, #215). Dòng `company_id` trống là tổng của cả app, mọi công ty
 * cộng chung: hạn mức gọi do sàn đặt cho app (Lazada 10.000/ngày). Dòng có `company_id` là phần công ty đó đã dùng
 * (Documents/21 §18.6.8). Một lượt gọi cộng cả hai dòng trong một giao dịch (`repository/api-usage.ts`). Chỉ đọc ghi
 * bằng role chủ bảng ngoài `withCompany`; RLS bật theo luật bảng có `company_id` (migration `rls-han-muc-cong-ty`).
 */
export const apiUsage = channelSchema.table(
  'api_usage',
  {
    platform: text('platform').notNull(),
    day: date('day').notNull(),
    companyId: uuid('company_id'),
    calls: integer('calls').notNull(),
  },
  (t) => [unique('api_usage_platform_day_company_uq').on(t.platform, t.day, t.companyId).nullsNotDistinct()],
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
    // Xoá gian hàng đã ngắt (#398) xoá luôn thư: `commerio_app` không có DELETE trên bảng này, hành động khoá ngoại chạy
    // bằng quyền chủ bảng.
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
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

/** Một dòng lỗi của lượt đồng bộ (Documents/21 §18 "Kết quả lượt đồng bộ", `SyncRunError`). */
export interface SyncRunErrorRow {
  listingId: string;
  variantId: string | null;
  productId: string | null;
  productName: string | null;
  attributesLabel: string | null;
  sku: string | null;
  code: string;
  message: string;
  /** Có từ #571; dòng ghi trước không có (đọc ra `null`). */
  kind?: PushErrorKind | null;
  target?: BlockerTarget | null;
  platformCode?: string | null;
  platformMessage: string | null;
  at: string;
  fix: 'variant_price' | 'stocktake' | 'platform' | 'shop_reconnect' | null;
}

/**
 * Lượt đồng bộ do người bấm (Documents/21 §18 "Kết quả lượt đồng bộ", thiết kế `trang-san-pham-tab/design/v2.html` Màn 2).
 * Lượt định kỳ 15 phút không ghi. `queued` lúc bấm; việc `channel.listing_sync` bắt đầu thì nhận mọi lượt `queued` của gian
 * hàng (`running`, `started_at`), mỗi lô đẩy xong tăng `processed`, `succeeded`, `failed` và nối `errors` (tối đa 200 dòng),
 * xong thì `done` hoặc `failed` kèm `error`. `total` null khi chưa biết (đang đọc sàn). Một lượt `queued` mỗi gian hàng
 * (`listing_sync_runs_one_queued_uq`): bấm khi đang có lượt chờ thì dùng lại lượt đó.
 */
export const listingSyncRuns = channelSchema.table(
  'listing_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    status: text('status').$type<'queued' | 'running' | 'done' | 'failed'>().notNull().default('queued'),
    requestedBy: uuid('requested_by'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    total: integer('total'),
    processed: integer('processed').notNull().default(0),
    succeeded: integer('succeeded').notNull().default(0),
    failed: integer('failed').notNull().default(0),
    errors: jsonb('errors').$type<SyncRunErrorRow[]>().notNull().default([]),
    /** Lỗi cả lượt `{ code, message }` (sàn lỗi cả lô, mất uỷ quyền, gian hàng ngắt). */
    error: jsonb('error').$type<{ code: string; message: string }>(),
  },
  (t) => [
    check('listing_sync_runs_status', sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
    check('listing_sync_runs_counts', sql`${t.processed} >= 0 and ${t.succeeded} >= 0 and ${t.failed} >= 0 and ${t.succeeded} + ${t.failed} = ${t.processed}`),
    check('listing_sync_runs_total', sql`${t.total} is null or ${t.processed} <= ${t.total}`),
    check('listing_sync_runs_started', sql`(${t.status} = 'queued') = (${t.startedAt} is null)`),
    check('listing_sync_runs_finished', sql`(${t.status} in ('done', 'failed')) = (${t.finishedAt} is not null)`),
    check('listing_sync_runs_error', sql`${t.error} is null or ${t.status} = 'failed'`),
    uniqueIndex('listing_sync_runs_one_queued_uq').on(t.shopId).where(sql`${t.status} = 'queued'`),
    index('listing_sync_runs_shop_idx').on(t.shopId, t.requestedAt),
  ],
);
