import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `purchasing` khai báo trong schema này.
export const purchasingSchema = pgSchema('purchasing');

export const poStatus = purchasingSchema.enum('po_status', [
  'draft',
  'pending_approval',
  'approved',
  'receiving',
  'received',
  'cancelled',
]);
export const poSource = purchasingSchema.enum('po_source', ['manual', 'auto_reorder']);

// `variant_id` (catalog), người lập/duyệt (staff) là uuid thường, không khoá ngoại chéo schema (19-D1).

/** Nhà cung cấp; ngừng giao dịch thì lưu trữ (`archived_at`), không xoá. */
export const suppliers = purchasingSchema.table('suppliers', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull(),
  name: text('name').notNull(),
  phone: text('phone'),
  email: text('email'),
  address: text('address'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  ...timestamps,
  ...version,
});

/** Đơn đặt hàng nhà cung cấp; nháp tạo tay hoặc từ ngưỡng tồn (`auto_reorder`) chưa cần nhà cung cấp. */
export const purchaseOrders = purchasingSchema.table(
  'purchase_orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: poStatus('status').notNull().default('draft'),
    statusReason: text('status_reason'),
    source: poSource('source').notNull().default('manual'),
    total: money('total').notNull().default('0'),
    createdBy: uuid('created_by').notNull(),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    index().on(t.supplierId),
    check(
      'purchase_orders_supplier_required',
      sql`${t.status} in ('draft', 'cancelled') or ${t.supplierId} is not null`,
    ),
  ],
);

export const purchaseOrderLines = purchasingSchema.table(
  'purchase_order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    poId: uuid('po_id')
      .notNull()
      .references(() => purchaseOrders.id),
    variantId: uuid('variant_id').notNull(),
    orderedQty: integer('ordered_qty').notNull(),
    receivedQty: integer('received_qty').notNull().default(0),
    unitPrice: money('unit_price').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.poId),
    check('purchase_order_lines_ordered_qty', sql`${t.orderedQty} > 0`),
    check('purchase_order_lines_received_qty', sql`${t.receivedQty} >= 0`),
    check('purchase_order_lines_unit_price', sql`${t.unitPrice} >= 0`),
  ],
);
