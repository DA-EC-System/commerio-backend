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
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `sales` khai báo trong schema này.
export const salesSchema = pgSchema('order');

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
/** Đơn bán chỉ lưu phần của khách (25 §8.2, Documents/21 mục 19.1); tiến độ giao suy ra từ kiện. */
export const orderStatus = salesSchema.enum('order_status', ['unpaid', 'processing', 'completed', 'cancelled']);
/** Kết quả khi đơn hoàn tất, tính trên kiện chưa huỷ. */
export const orderOutcome = salesSchema.enum('order_outcome', ['full', 'partial', 'none']);

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
 * đơn sàn bắt buộc có gian hàng và mã đơn sàn, không trùng (19-D32). Thanh toán qua cổng ở `finance.order_payments`,
 * tiền sàn quyết toán ở `finance.order_settlements`.
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
    // Đơn sàn thanh toán khi nhận hàng (sàn thu hộ). Đơn tự bán dùng `payment_method`, cột này luôn false.
    isCod: boolean('is_cod').notNull().default(false),
    status: orderStatus('status').notNull().default('unpaid'),
    outcome: orderOutcome('outcome'),
    rawMarketplaceStatus: text('raw_marketplace_status'),
    placedAt: timestamp('placed_at', { withTimezone: true }),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    shipBy: timestamp('ship_by', { withTimezone: true }),
    returnWindowEndsAt: timestamp('return_window_ends_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    // Cờ lưu. Cờ suy ra được (chưa ghép SKU, sắp trễ hạn, có yêu cầu trả, lệch COD) không lưu (Documents/19 D4).
    needsAttention: boolean('needs_attention').notNull().default(false),
    attentionNote: text('attention_note'),
    cancelRequested: boolean('cancel_requested').notNull().default(false),
    cancelling: boolean('cancelling').notNull().default(false),
    platformCancelled: boolean('platform_cancelled').notNull().default(false),
    shopDisconnected: boolean('shop_disconnected').notNull().default(false),
    shippingAddress: jsonb('shipping_address'),
    subtotal: money('subtotal').notNull(),
    sellerDiscount: money('seller_discount').notNull().default('0'),
    platformDiscount: money('platform_discount').notNull().default('0'),
    shippingFee: money('shipping_fee').notNull().default('0'),
    total: money('total').notNull(),
    cancelReason: text('cancel_reason'),
    // Số hoá đơn người bán nhập để gửi sàn (Documents/21 §19.3).
    invoiceNumber: text('invoice_number'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.companyId, t.shopId, t.externalOrderId),
    index().on(t.customerId),
    index().on(t.conversationId),
    index().on(t.status),
    check('orders_outcome', sql`(${t.status} = 'completed') = (${t.outcome} is not null)`),
    check('orders_cod', sql`${t.source} = 'marketplace' or not ${t.isCod}`),
    check('orders_amounts', sql`${t.subtotal} >= 0 and ${t.total} >= 0 and ${t.shippingFee} >= 0`),
    check('orders_payment_method', sql`(${t.source} = 'marketplace') = (${t.paymentMethod} is null)`),
    check(
      'orders_marketplace_ref',
      sql`${t.source} <> 'marketplace' or (${t.shopId} is not null and ${t.externalOrderId} is not null)`,
    ),
  ],
);

/**
 * Dòng đơn: chép SKU, tên sản phẩm, đơn giá lúc tạo đơn để đơn cũ không đổi khi sản phẩm đổi. Đơn sàn có SKU chưa
 * ghép thì `variant_id` trống (cờ `unmapped_sku`), chưa giữ hàng tới khi ghép (E11).
 */
export const orderLines = salesSchema.table(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    variantId: uuid('variant_id'),
    externalLineId: text('external_line_id'),
    externalSku: text('external_sku'),
    sku: text('sku'),
    productName: text('product_name').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    sellerDiscount: money('seller_discount').notNull().default('0'),
    platformDiscount: money('platform_discount').notNull().default('0'),
    lineTotal: money('line_total').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.orderId),
    index().on(t.variantId),
    check('order_lines_quantity', sql`${t.quantity} > 0`),
    check('order_lines_unit_price', sql`${t.unitPrice} >= 0`),
    check('order_lines_item', sql`${t.variantId} is not null or ${t.externalSku} is not null`),
    unique().on(t.orderId, t.externalLineId),
  ],
);

/** Yêu cầu trả hàng (25 §9, Documents/21 mục 20). */
export const returnStatus = salesSchema.enum('return_status', [
  'requested',
  'rejected',
  'refund_only',
  'awaiting_return',
  'received',
  'closed',
]);
export const returnCloseResult = salesSchema.enum('return_close_result', ['inspected', 'no_show', 'buyer_cancelled']);

/**
 * Khách trả sau khi đã nhận. Đơn sàn: do sàn đẩy về, khoá (gian hàng, mã yêu cầu sàn); đơn tạo tay: Sale lập.
 * `inspection_id` là phiếu kiểm hàng về (product) sinh khi nhận hàng trả.
 */
export const returnRequests = salesSchema.table(
  'return_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id),
    source: orderSource('source').notNull(),
    shopId: uuid('shop_id'),
    externalReturnId: text('external_return_id'),
    status: returnStatus('status').notNull().default('requested'),
    closeResult: returnCloseResult('close_result'),
    reason: text('reason').notNull(),
    statusReason: text('status_reason'),
    returnTrackingCode: text('return_tracking_code'),
    refundAmount: money('refund_amount').notNull().default('0'),
    refunded: boolean('refunded').notNull().default(false),
    resellCost: money('resell_cost'),
    inspectionId: uuid('inspection_id'),
    needsAttention: boolean('needs_attention').notNull().default(false),
    createdBy: uuid('created_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    unique().on(t.shopId, t.externalReturnId),
    index().on(t.orderId),
    index().on(t.status),
    check('return_requests_closed', sql`(${t.status} = 'closed') = (${t.closeResult} is not null)`),
    check(
      'return_requests_marketplace_ref',
      sql`${t.source} <> 'marketplace' or (${t.shopId} is not null and ${t.externalReturnId} is not null)`,
    ),
    check('return_requests_refund', sql`${t.refundAmount} >= 0`),
  ],
);

/** Dòng yêu cầu trả: gắn dòng đơn và kiện đã giao chứa phần đó; giá vốn là bình quân các dòng kiện (25 §9). */
export const returnRequestLines = salesSchema.table(
  'return_request_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => returnRequests.id),
    orderLineId: uuid('order_line_id')
      .notNull()
      .references(() => orderLines.id),
    packageId: uuid('package_id'),
    variantId: uuid('variant_id'),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    unitCost: money('unit_cost'),
    resellQty: integer('resell_qty'),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.requestId),
    index().on(t.orderLineId),
    check('return_request_lines_quantity', sql`${t.quantity} > 0`),
    check('return_request_lines_resell', sql`${t.resellQty} >= 0 and ${t.resellQty} <= ${t.quantity}`),
  ],
);

/** Bộ đếm mã đơn, cùng dạng `product.doc_counters` (plan chuẩn bị A4/K5). */
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
