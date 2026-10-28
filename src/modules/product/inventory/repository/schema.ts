import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module `inventory` khai báo trong schema này.
export const inventorySchema = pgSchema('inventory');

export const receiptKind = inventorySchema.enum('receipt_kind', ['purchase', 'manual', 'delivery_return']);
export const issueKind = inventorySchema.enum('issue_kind', ['manual', 'order']);
export const docStatus = inventorySchema.enum('doc_status', ['draft', 'done', 'cancelled']);
export const reservationStatus = inventorySchema.enum('reservation_status', ['active', 'consumed', 'released']);

// `variant_id` (catalog), `order_id` (sales), `purchase_order_id` (purchasing), `created_by`/`posted_by`/`done_by`
// (staff) là uuid thường, không đặt khoá ngoại chéo schema (19-D1).

/** Phiếu nhập: loại phiếu khớp với chứng từ gốc (19-D34); mỗi đơn tối đa một phiếu nhập hoàn chưa huỷ (19-D35). */
export const stockReceipts = inventorySchema.table(
  'stock_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    kind: receiptKind('kind').notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    orderId: uuid('order_id'),
    status: docStatus('status').notNull().default('draft'),
    note: text('note'),
    reference: text('reference'),
    createdBy: uuid('created_by'),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.purchaseOrderId),
    index().on(t.orderId),
    uniqueIndex('stock_receipts_one_return_per_order')
      .on(t.orderId)
      .where(sql`${t.kind} = 'delivery_return' and ${t.status} <> 'cancelled'`),
    check('stock_receipts_purchase_order', sql`(${t.kind} = 'purchase') = (${t.purchaseOrderId} is not null)`),
    check('stock_receipts_return_order', sql`(${t.kind} = 'delivery_return') = (${t.orderId} is not null)`),
  ],
);

/** Dòng phiếu nhập. `unit_cost` trống được: nhập hoàn lấy giá vốn hiện tại lúc ghi sổ (Documents/21 K2). */
export const stockReceiptLines = inventorySchema.table(
  'stock_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => stockReceipts.id),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitCost: money('unit_cost'),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.receiptId), index().on(t.variantId), check('stock_receipt_lines_quantity', sql`${t.quantity} > 0`)],
);

/** Tồn của biến thể: `available = on_hand − reserved` (Documents/21 K1). */
export const stockLevels = inventorySchema.table(
  'stock_levels',
  {
    variantId: uuid('variant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    avgCost: money('avg_cost').notNull().default('0'),
    ...timestamps,
    ...version,
  },
  // Khoá theo công ty: id biến thể của công ty khác không chiếm được dòng tồn (#16 A17).
  (t) => [
    primaryKey({ columns: [t.companyId, t.variantId] }),
    check('stock_levels_on_hand', sql`${t.onHand} >= 0`),
    check('stock_levels_reserved', sql`${t.reserved} >= 0`),
    check('stock_levels_reserved_le_on_hand', sql`${t.reserved} <= ${t.onHand}`),
  ],
);

/** Phiếu xuất: tay hoặc theo đơn; mỗi đơn tối đa một phiếu xuất chưa huỷ (19-D35). */
export const stockIssues = inventorySchema.table(
  'stock_issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    kind: issueKind('kind').notNull(),
    orderId: uuid('order_id'),
    status: docStatus('status').notNull().default('draft'),
    note: text('note'),
    reference: text('reference'),
    createdBy: uuid('created_by'),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    uniqueIndex('stock_issues_one_per_order').on(t.orderId).where(sql`${t.status} <> 'cancelled'`),
    check('stock_issues_order', sql`(${t.kind} = 'order') = (${t.orderId} is not null)`),
  ],
);

/** Dòng phiếu xuất. `unit_cost` là giá vốn lúc ghi sổ, nên trống khi phiếu còn nháp (K2). */
export const stockIssueLines = inventorySchema.table(
  'stock_issue_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => stockIssues.id),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitCost: money('unit_cost'),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.issueId), index().on(t.variantId), check('stock_issue_lines_quantity', sql`${t.quantity} > 0`)],
);

/**
 * Thẻ kho, chỉ thêm (role ứng dụng không UPDATE/DELETE, migration RLS). Mỗi dòng trỏ đúng một dòng phiếu;
 * `on_hand_after` ghi lúc tạo (19-D38), `done_by` là người ghi sổ (D8).
 */
export const stockMoves = inventorySchema.table(
  'stock_moves',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    qtyChange: integer('qty_change').notNull(),
    onHandAfter: integer('on_hand_after').notNull(),
    receiptLineId: uuid('receipt_line_id').references(() => stockReceiptLines.id),
    issueLineId: uuid('issue_line_id').references(() => stockIssueLines.id),
    unitCost: money('unit_cost'),
    doneAt: timestamp('done_at', { withTimezone: true }).notNull().defaultNow(),
    doneBy: uuid('done_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.variantId, t.id),
    index().on(t.receiptLineId),
    index().on(t.issueLineId),
    check('stock_moves_qty_change', sql`${t.qtyChange} <> 0`),
    check('stock_moves_on_hand_after', sql`${t.onHandAfter} >= 0`),
    check('stock_moves_one_source', sql`num_nonnulls(${t.receiptLineId}, ${t.issueLineId}) = 1`),
  ],
);

/** Giữ hàng của đơn, một dòng mỗi (đơn, biến thể) (19-D38); `reserved` của tồn là tổng giữ chỗ `active` (K1). */
export const reservations = inventorySchema.table(
  'reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    orderId: uuid('order_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    status: reservationStatus('status').notNull().default('active'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.orderId, t.variantId),
    index().on(t.variantId),
    check('reservations_quantity', sql`${t.quantity} > 0`),
  ],
);

/** Ngưỡng tồn của biến thể (K7); `alert_active` chống gửi lại cảnh báo khi vẫn dưới ngưỡng. */
export const reorderRules = inventorySchema.table(
  'reorder_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    minQty: integer('min_qty').notNull(),
    alertActive: boolean('alert_active').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.variantId), check('reorder_rules_min_qty', sql`${t.minQty} >= 0`)],
);

/**
 * Bộ đếm số chứng từ (D8, plan chuẩn bị A4/K5): cấp số bằng `UPDATE … SET next_number = next_number + 1 RETURNING`
 * trong giao dịch. `period` trống khi đánh số không theo kỳ. Cùng dạng với `finance.doc_counters`, `sales.doc_counters`.
 */
export const docCounters = inventorySchema.table(
  'doc_counters',
  {
    companyId: uuid('company_id').notNull(),
    docType: text('doc_type').notNull(),
    period: text('period').notNull().default(''),
    nextNumber: integer('next_number').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.docType, t.period] })],
);
