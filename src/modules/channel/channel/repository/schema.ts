import { bigint, index, jsonb, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { bytea, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `channel` khai báo trong schema này.
export const channelSchema = pgSchema('channel');

export const marketplace = channelSchema.enum('marketplace', ['tiktok', 'shopee', 'lazada', 'mock']);
export const shopStatus = channelSchema.enum('shop_status', ['connected', 'expiring', 'deauthorized', 'disconnected']);

// `variant_id` (catalog), `order_id` (sales) là uuid thường, không khoá ngoại chéo schema (19-D1).

/** Gian hàng sàn đã kết nối. Token sàn lưu đã mã hoá. */
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
    status: shopStatus('status').notNull().default('connected'),
    lastOrderSyncAt: timestamp('last_order_sync_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.externalShopId)],
);

/** Ghép SKU của sàn với biến thể. */
export const channelListings = channelSchema.table(
  'channel_listings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id')
      .notNull()
      .references(() => shops.id),
    variantId: uuid('variant_id').notNull(),
    externalProductId: text('external_product_id').notNull(),
    externalSkuId: text('external_sku_id').notNull(),
    listingStatus: text('listing_status'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.externalSkuId), index().on(t.shopId), index().on(t.variantId)],
);

/** Dữ liệu gốc của đơn sàn; `order_id` có khi đã tạo đơn trong sales. */
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
  (t) => [unique().on(t.companyId, t.externalOrderId), index().on(t.shopId), index().on(t.orderId)],
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
  (t) => [unique().on(t.companyId, t.notificationId)],
);
