import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `sales` khai báo trong schema này.
export const salesSchema = pgSchema('sales');

export const channelKind = salesSchema.enum('channel_kind', [
  'tiktok',
  'shopee',
  'lazada',
  'mock',
  'messenger',
  'email',
  'zalo_oa',
]);
export const orderSource = salesSchema.enum('order_source', ['marketplace', 'inbox', 'manual']);
export const paymentMethod = salesSchema.enum('payment_method', ['prepaid', 'cod']);
/** Trạng thái duyệt đơn. `fulfillment.order_status_history` có bản riêng cùng giá trị (plan chuẩn bị A5). */
export const fulfillmentStatus = salesSchema.enum('fulfillment_status', [
  'pending_confirmation',
  'confirmed',
  'picking',
  'packing',
  'issued',
  'in_transit',
  'delivered',
  'delivery_failed',
  'cancelled',
]);

// `shop_id` (channel), `conversation_id` (inbox), `variant_id` (catalog) là uuid thường, không khoá ngoại chéo schema (19-D1).

export const customers = salesSchema.table('customers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  name: text('name'),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  note: text('note'),
  ...timestamps,
  ...version,
});

/** Danh tính của khách trên một kênh (sàn, hộp thư), gộp về một hồ sơ khách. */
export const customerIdentities = salesSchema.table(
  'customer_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    channelKind: channelKind('channel_kind').notNull(),
    externalUserId: text('external_user_id').notNull(),
    displayName: text('display_name'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.channelKind, t.externalUserId), index().on(t.customerId)],
);

/**
 * Đơn hàng. Đơn sàn không có `payment_method` (sàn thu hộ), đơn hộp thư và đơn tạo tay bắt buộc có (19-D11);
 * đơn sàn bắt buộc có gian hàng và mã đơn sàn, không trùng (19-D32). Trạng thái tiền ở `payment.order_payments`.
 */
export const orders = salesSchema.table(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    customerId: uuid('customer_id').references(() => customers.id),
    source: orderSource('source').notNull(),
    shopId: uuid('shop_id'),
    externalOrderId: text('external_order_id'),
    conversationId: uuid('conversation_id'),
    paymentMethod: paymentMethod('payment_method'),
    status: fulfillmentStatus('status').notNull().default('pending_confirmation'),
    isShortStock: boolean('is_short_stock').notNull().default(false),
    shippingAddress: jsonb('shipping_address'),
    subtotal: money('subtotal').notNull(),
    shippingFee: money('shipping_fee').notNull().default('0'),
    total: money('total').notNull(),
    cancelReason: text('cancel_reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.companyId, t.shopId, t.externalOrderId),
    index().on(t.customerId),
    index().on(t.conversationId),
    check('orders_payment_method', sql`(${t.source} = 'marketplace') = (${t.paymentMethod} is null)`),
    check(
      'orders_marketplace_ref',
      sql`${t.source} <> 'marketplace' or (${t.shopId} is not null and ${t.externalOrderId} is not null)`,
    ),
  ],
);

/** Dòng đơn: chép SKU, tên sản phẩm, đơn giá lúc tạo đơn để đơn cũ không đổi khi sản phẩm đổi. */
export const orderLines = salesSchema.table(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    variantId: uuid('variant_id').notNull(),
    sku: text('sku').notNull(),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    lineTotal: money('line_total').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.orderId),
    index().on(t.variantId),
    check('order_lines_quantity', sql`${t.quantity} > 0`),
    check('order_lines_unit_price', sql`${t.unitPrice} >= 0`),
  ],
);

/** Bộ đếm mã đơn, cùng dạng `inventory.doc_counters` (plan chuẩn bị A4/K5). */
export const docCounters = salesSchema.table(
  'doc_counters',
  {
    companyId: uuid('company_id').notNull(),
    docType: text('doc_type').notNull(),
    period: text('period').notNull().default(''),
    nextNumber: integer('next_number').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.docType, t.period] })],
);
