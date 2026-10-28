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
  uuid,
} from 'drizzle-orm/pg-core';
import { approval, approvalCheck, money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module con `inventory` khai báo trong schema của module lớn `product` (Documents/19 D1).
export const inventorySchema = pgSchema('product');

// `variant_id` (catalog), kiện (order), người làm (staff) là uuid thường: không đặt khoá ngoại sang module con khác.

/** Ngăn chứa của một số tồn: hàng bán được, hoặc hàng chờ xử lý (lỗi, hoàn, trả chưa kiểm). */
export const stockBucket = inventorySchema.enum('stock_bucket', ['on_hand', 'quarantine']);

/** Chứng từ gốc của một dòng thẻ kho. */
export const stockSourceType = inventorySchema.enum('stock_source_type', [
  'goods_receipt',
  'stock_document',
  'supplier_return',
]);

/**
 * Các con số lưu của SKU (25 §7.1, Documents/21 mục 15.1). Tạm khoá, đang về, đang thiếu, khả dụng tính khi đọc.
 * Bất biến kiểu "không làm tệ hơn": tồn thực âm hoặc nhỏ hơn đang giữ chỉ được khi bật `invariant_broken`
 * (bàn giao bắt buộc theo sàn, kiểm kê CEO đã duyệt); cờ này là nhãn Tồn âm. `min_qty` là ngưỡng tồn (trống = chưa đặt).
 */
export const stockLevels = inventorySchema.table(
  'stock_levels',
  {
    variantId: uuid('variant_id').notNull(),
    companyId: uuid('company_id').notNull(),
    onHand: integer('on_hand').notNull().default(0),
    reserved: integer('reserved').notNull().default(0),
    quarantine: integer('quarantine').notNull().default(0),
    avgCost: money('avg_cost').notNull().default('0'),
    minQty: integer('min_qty'),
    invariantBroken: boolean('invariant_broken').notNull().default(false),
    ...timestamps,
    ...version,
  },
  // Khoá theo công ty: id biến thể của công ty khác không chiếm được dòng tồn (#16 A17).
  (t) => [
    primaryKey({ columns: [t.companyId, t.variantId] }),
    check('stock_levels_reserved', sql`${t.reserved} >= 0`),
    check('stock_levels_quarantine', sql`${t.quarantine} >= 0`),
    check('stock_levels_min_qty', sql`${t.minQty} >= 0`),
    check('stock_levels_invariant', sql`(${t.onHand} >= 0 and ${t.reserved} <= ${t.onHand}) or ${t.invariantBroken}`),
  ],
);

/**
 * Thẻ kho, chỉ thêm (role ứng dụng không UPDATE/DELETE). Mỗi biến động của tồn thực hoặc chờ xử lý là một dòng trỏ
 * về chứng từ gốc (N2). Đang giữ không ghi thẻ kho: nguồn của nó là dòng kiện. `balance_after` là số của ngăn đó sau
 * biến động, có thể âm trong hai ngoại lệ của `stock_levels`.
 */
export const stockMoves = inventorySchema.table(
  'stock_moves',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    bucket: stockBucket('bucket').notNull(),
    qtyChange: integer('qty_change').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    unitCost: money('unit_cost'),
    sourceType: stockSourceType('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceLineId: uuid('source_line_id'),
    doneAt: timestamp('done_at', { withTimezone: true }).notNull().defaultNow(),
    doneBy: uuid('done_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.variantId, t.id),
    index().on(t.sourceType, t.sourceId),
    check('stock_moves_qty_change', sql`${t.qtyChange} <> 0`),
  ],
);

/**
 * Loại phiếu kho (Documents/21 mục 15). Ba loại đầu do kho lập và CEO duyệt; `return_inspection` hệ thống sinh khi kiện
 * hoặc yêu cầu trả quay về; `shipment`, `shipment_reversal` là phiếu xuất theo kiện và phiếu đảo bàn giao (mục 19).
 */
export const stockDocumentKind = inventorySchema.enum('stock_document_kind', [
  'stocktake',
  'write_off',
  'to_quarantine',
  'return_inspection',
  'shipment',
  'shipment_reversal',
]);
export const stockDocumentStatus = inventorySchema.enum('stock_document_status', [
  'draft',
  'pending',
  'posted',
  'rejected',
  'cancelled',
]);
/** Cách xử lý hàng chờ xử lý khi phiếu xuất huỷ của nó bị từ chối (`/decide`). */
export const rejectDecision = inventorySchema.enum('reject_decision', ['restock', 'supplier_return']);

/**
 * Phiếu kho. Phiếu giảm đang `pending` làm tạm khoá phần giảm (tính khi đọc). Kiểm kê lưu thời điểm đếm và tồn sổ lúc
 * đó để chênh lệch không lẫn biến động giữa lúc đếm và lúc duyệt; `is_opening` là kiểm kê đầu kỳ khi kết nối gian
 * hàng đầu tiên. `source_type`/`source_id` trỏ kiện, yêu cầu trả hoặc phiếu sinh ra phiếu này.
 */
export const stockDocuments = inventorySchema.table(
  'stock_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    kind: stockDocumentKind('kind').notNull(),
    status: stockDocumentStatus('status').notNull().default('draft'),
    area: stockBucket('area').notNull().default('on_hand'),
    countedAt: timestamp('counted_at', { withTimezone: true }),
    isOpening: boolean('is_opening').notNull().default(false),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    claimFlag: boolean('claim_flag').notNull().default(false),
    rejectDecision: rejectDecision('reject_decision'),
    note: text('note'),
    statusReason: text('status_reason'),
    ...approval,
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.kind, t.status),
    index().on(t.sourceType, t.sourceId),
    approvalCheck('stock_documents', t),
    check(
      'stock_documents_shipment_source',
      sql`${t.kind} not in ('shipment', 'shipment_reversal') or ${t.sourceType} is not distinct from 'package'`,
    ),
    check('stock_documents_counted_at', sql`${t.kind} <> 'stocktake' or ${t.countedAt} is not null`),
    check('stock_documents_opening', sql`not ${t.isOpening} or ${t.kind} = 'stocktake'`),
    check('stock_documents_posted', sql`(${t.status} = 'posted') = (${t.postedAt} is not null)`),
  ],
);

/**
 * Dòng phiếu kho. Kiểm kê: `book_qty`, `counted_qty` (chênh lệch = đếm − sổ). Kiểm hàng về: `expected_qty`,
 * `scanned_qty` chia thành bán lại, hỏng, trả NCC; `actual_variant_id` khi sai mẫu. Loại khác dùng `quantity`.
 */
export const stockDocumentLines = inventorySchema.table(
  'stock_document_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => stockDocuments.id),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity'),
    bookQty: integer('book_qty'),
    countedQty: integer('counted_qty'),
    expectedQty: integer('expected_qty'),
    scannedQty: integer('scanned_qty'),
    resellQty: integer('resell_qty'),
    damagedQty: integer('damaged_qty'),
    toSupplierQty: integer('to_supplier_qty'),
    actualVariantId: uuid('actual_variant_id'),
    unitCost: money('unit_cost'),
    reason: text('reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.documentId),
    index().on(t.variantId),
    check('stock_document_lines_quantity', sql`${t.quantity} > 0`),
    check('stock_document_lines_counted', sql`${t.countedQty} >= 0`),
    check(
      'stock_document_lines_inspection',
      sql`${t.expectedQty} >= 0 and ${t.scannedQty} >= 0 and ${t.resellQty} >= 0 and ${t.damagedQty} >= 0
        and ${t.toSupplierQty} >= 0`,
    ),
    check(
      'stock_document_lines_inspection_sum',
      sql`${t.scannedQty} is null or ${t.resellQty} + ${t.damagedQty} + ${t.toSupplierQty} = ${t.scannedQty}`,
    ),
  ],
);

/**
 * Bộ đếm số chứng từ của cả module lớn `product` (phiếu kho, đề nghị nhập, phiếu nhận, phiếu trả NCC): cấp số bằng
 * `UPDATE … SET next_number = next_number + 1 RETURNING` trong giao dịch. `period` trống khi đánh số không theo kỳ.
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
