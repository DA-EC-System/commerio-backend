import { bigint, index, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `fulfillment` khai báo trong schema này.
export const fulfillmentSchema = pgSchema('fulfillment');

/** Bản riêng của schema này, cùng giá trị với `sales.fulfillment_status` (plan chuẩn bị A5; test so `pg_enum`). */
export const fulfillmentStatus = fulfillmentSchema.enum('fulfillment_status', [
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
export const changeSource = fulfillmentSchema.enum('change_source', ['user', 'marketplace', 'system']);
export const batchStatus = fulfillmentSchema.enum('batch_status', ['open', 'picking', 'packed', 'done']);

// `order_id` (sales), `actor_id`, `created_by` (staff) là uuid thường, không khoá ngoại chéo schema (19-D1).

/**
 * Lịch sử chuyển trạng thái đơn, chỉ thêm (role ứng dụng không UPDATE/DELETE, migration RLS).
 * `from_status` trống ở lần ghi đầu tiên của đơn.
 */
export const orderStatusHistory = fulfillmentSchema.table(
  'order_status_history',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    orderId: uuid('order_id').notNull(),
    fromStatus: fulfillmentStatus('from_status'),
    toStatus: fulfillmentStatus('to_status').notNull(),
    actorId: uuid('actor_id'),
    source: changeSource('source').notNull(),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.orderId, t.id)],
);

/** Lô nhặt hàng. */
export const pickBatches = fulfillmentSchema.table(
  'pick_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    status: batchStatus('status').notNull().default('open'),
    createdBy: uuid('created_by'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.code)],
);

/** Đơn trong lô: mỗi đơn thuộc tối đa một lô. */
export const pickBatchOrders = fulfillmentSchema.table(
  'pick_batch_orders',
  {
    orderId: uuid('order_id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => pickBatches.id),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.batchId)],
);
