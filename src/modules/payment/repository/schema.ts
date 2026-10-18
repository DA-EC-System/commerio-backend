import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, money, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `payment` khai báo trong schema này.
export const paymentSchema = pgSchema('payment');

export const paymentStatus = paymentSchema.enum('payment_status', [
  'unpaid',
  'paid',
  'cod_pending',
  'cod_collected',
  'not_collected',
]);
export const refundStatus = paymentSchema.enum('refund_status', ['none', 'pending_refund', 'refunded']);
export const gateway = paymentSchema.enum('gateway', ['vnpay', 'momo', 'zalopay', 'vietqr']);
export const linkStatus = paymentSchema.enum('link_status', ['active', 'paid', 'expired', 'cancelled']);
export const txnSource = paymentSchema.enum('txn_source', ['webhook', 'query', 'sepay']);
export const txnStatus = paymentSchema.enum('txn_status', ['pending', 'succeeded', 'failed', 'needs_review']);

// `order_id` (sales), `created_by`, `updated_by` (staff) là uuid thường, không khoá ngoại chéo schema (19-D1).

/**
 * Trạng thái tiền của đơn hộp thư, đơn tạo tay (đơn sàn không có dòng, 19-D11). Phương thức, số tiền đọc từ đơn
 * (`sales.getOrderForPayment`). `paid_at` ghi khi sang `paid`/`cod_collected`; `delivered_at` do fulfillment ghi
 * qua `markDelivered` khi giao xong, tab COD đọc cột này (R2).
 */
export const orderPayments = paymentSchema.table('order_payments', {
  orderId: uuid('order_id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  status: paymentStatus('status').notNull(),
  refundStatus: refundStatus('refund_status').notNull().default('none'),
  paidAt: timestamp('paid_at', { withTimezone: true }),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  ...timestamps,
  ...version,
});

/**
 * Khoá cổng của công ty, mã hoá AES-256-GCM. `webhook_receiver_key` là phần cuối URL webhook SePay riêng của công ty,
 * unique toàn hệ thống vì webhook đến trước khi biết công ty (D16); tra bằng role chủ bảng.
 */
export const gatewayConfigs = paymentSchema.table(
  'gateway_configs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    gateway: gateway('gateway').notNull(),
    credentialsEnc: bytea('credentials_enc'),
    isConfigured: boolean('is_configured').notNull().default(false),
    webhookReceiverKey: text('webhook_receiver_key').unique(),
    updatedBy: uuid('updated_by'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.gateway)],
);

/**
 * Mã thanh toán. `payment_code` unique toàn hệ thống (D14) vì webhook tìm mã trước khi biết công ty (D16);
 * mỗi đơn tối đa một mã `active` (19-D21).
 */
export const paymentLinks = paymentSchema.table(
  'payment_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    orderId: uuid('order_id').notNull(),
    gateway: gateway('gateway').notNull(),
    paymentCode: text('payment_code').notNull().unique(),
    gatewayOrderRef: text('gateway_order_ref'),
    amount: money('amount').notNull(),
    payUrl: text('pay_url'),
    qrContent: text('qr_content'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: linkStatus('status').notNull().default('active'),
    createdBy: uuid('created_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.orderId),
    uniqueIndex('payment_links_one_active_per_order').on(t.orderId).where(sql`${t.status} = 'active'`),
    check('payment_links_amount', sql`${t.amount} > 0`),
  ],
);

/**
 * Giao dịch cổng báo về, ghi một lần (19-D19). Chống trùng theo `(gateway, gateway_txn_id)` toàn hệ thống
 * (plan chuẩn bị A7). `fee` là phí cổng nếu cổng trả (QT-45), trống khi không biết.
 */
export const paymentTransactions = paymentSchema.table(
  'payment_transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    paymentLinkId: uuid('payment_link_id').references(() => paymentLinks.id),
    orderId: uuid('order_id'),
    gateway: gateway('gateway').notNull(),
    gatewayTxnId: text('gateway_txn_id').notNull(),
    amount: money('amount').notNull(),
    fee: money('fee'),
    source: txnSource('source').notNull(),
    status: txnStatus('status').notNull().default('pending'),
    rawPayload: jsonb('raw_payload'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.gateway, t.gatewayTxnId), index().on(t.paymentLinkId), index().on(t.orderId)],
);

/**
 * Webhook cổng đã nhận (sau khi kiểm chữ ký), chống xử lý lặp. Khoá gồm cả `gateway`: mã sự kiện của hai cổng
 * đều là số, có thể trùng nhau trong một công ty.
 */
export const webhookEvents = paymentSchema.table(
  'webhook_events',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    gateway: gateway('gateway').notNull(),
    eventKey: text('event_key').notNull(),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique().on(t.companyId, t.gateway, t.eventKey)],
);
