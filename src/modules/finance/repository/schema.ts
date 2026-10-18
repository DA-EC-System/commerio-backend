import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  check,
  date,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `finance` khai báo trong schema này.
export const financeSchema = pgSchema('finance');

export const invoiceStatus = financeSchema.enum('invoice_status', ['posted', 'reversed']);
export const unmatchedReason = financeSchema.enum('unmatched_reason', [
  'no_payment_code',
  'amount_mismatch',
  'order_cancelled',
]);
export const unmatchedStatus = financeSchema.enum('unmatched_status', ['open', 'assigned', 'refunded']);
export const receiptSource = financeSchema.enum('receipt_source', ['gateway', 'cod', 'settlement', 'unmatched_assignment']);
export const voucherStatus = financeSchema.enum('voucher_status', ['draft', 'posted', 'reversed']);
export const voucherPurpose = financeSchema.enum('voucher_purpose', [
  'supplier_payment',
  'customer_refund',
  'unmatched_refund',
]);
export const matchStatus = financeSchema.enum('match_status', ['matched', 'discrepancy', 'refund_tagged']);
export const settlementLineKind = financeSchema.enum('settlement_line_kind', ['order', 'adjustment', 'reserve']);
export const discrepancyReason = financeSchema.enum('discrepancy_reason', [
  'order_not_found',
  'revenue_mismatch',
  'formula_mismatch',
]);

// `order_id`, `order_line_id` (sales), `variant_id` (catalog), `payment_transaction_id` (payment), người lập (staff) là
// uuid thường, không khoá ngoại chéo schema (19-D1).
//
// Chứng từ đảo (19-D20, D14): dòng mới cùng bảng, `reversal_of_id` trỏ gốc (mỗi chứng từ đảo một lần), số tiền âm,
// bắt buộc có lý do.

/** Hoá đơn bán, tự sinh khi xuất kho. Một đơn tối đa một hoá đơn `posted` chưa bị đảo (plan chuẩn bị A7). */
export const salesInvoices = financeSchema.table(
  'sales_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    orderId: uuid('order_id').notNull(),
    status: invoiceStatus('status').notNull().default('posted'),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    total: money('total').notNull(),
    reversalOfId: uuid('reversal_of_id')
      .unique()
      .references((): AnyPgColumn => salesInvoices.id),
    reversalReason: text('reversal_reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.orderId),
    uniqueIndex('sales_invoices_one_posted_per_order')
      .on(t.orderId)
      .where(sql`${t.reversalOfId} is null and ${t.status} = 'posted'`),
    check('sales_invoices_reversal_reason', sql`(${t.reversalOfId} is null) = (${t.reversalReason} is null)`),
  ],
);

/** Dòng hoá đơn: chép từ dòng đơn; dòng của hoá đơn đảo mang số âm. */
export const salesInvoiceLines = financeSchema.table(
  'sales_invoice_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    invoiceId: uuid('invoice_id')
      .notNull()
      .references(() => salesInvoices.id),
    orderLineId: uuid('order_line_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitPrice: money('unit_price').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.invoiceId)],
);

/** Tiền về không gán được vào đơn (không có mã, lệch tiền, đơn đã huỷ); gán hoặc hoàn sau (UC-PF-07). */
export const unmatchedReceipts = financeSchema.table(
  'unmatched_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    paymentTransactionId: uuid('payment_transaction_id'),
    amount: money('amount').notNull(),
    transferContent: text('transfer_content'),
    reason: unmatchedReason('reason').notNull(),
    status: unmatchedStatus('status').notNull().default('open'),
    assignedOrderId: uuid('assigned_order_id'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.paymentTransactionId), index().on(t.assignedOrderId)],
);

/** Phiếu thu, không có nháp. Chỉ phiếu đảo mang số âm. */
export const receipts = financeSchema.table(
  'receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    orderId: uuid('order_id'),
    source: receiptSource('source').notNull(),
    paymentTransactionId: uuid('payment_transaction_id').unique(),
    unmatchedReceiptId: uuid('unmatched_receipt_id').references(() => unmatchedReceipts.id),
    settlementLineId: uuid('settlement_line_id')
      .unique()
      .references(() => settlementLines.id),
    amount: money('amount').notNull(),
    status: voucherStatus('status').notNull().default('posted'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    reversalOfId: uuid('reversal_of_id')
      .unique()
      .references((): AnyPgColumn => receipts.id),
    reversalReason: text('reversal_reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.orderId),
    index().on(t.unmatchedReceiptId),
    check('receipts_amount_sign', sql`${t.amount} <> 0 and (${t.reversalOfId} is null) = (${t.amount} > 0)`),
    check('receipts_reversal_reason', sql`(${t.reversalOfId} is null) = (${t.reversalReason} is null)`),
    check('receipts_not_draft', sql`${t.status} <> 'draft'`),
  ],
);

/** Phiếu chi: nháp → ghi sổ → (đảo). Trỏ tối đa một chứng từ gốc theo `purpose`. Chỉ phiếu đảo mang số âm. */
export const paymentVouchers = financeSchema.table(
  'payment_vouchers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    purpose: voucherPurpose('purpose').notNull(),
    supplierInvoiceId: uuid('supplier_invoice_id').references(() => supplierInvoices.id),
    orderId: uuid('order_id'),
    unmatchedReceiptId: uuid('unmatched_receipt_id').references(() => unmatchedReceipts.id),
    amount: money('amount').notNull(),
    paidOn: date('paid_on').notNull(),
    note: text('note'),
    status: voucherStatus('status').notNull().default('draft'),
    createdBy: uuid('created_by').notNull(),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    reversalOfId: uuid('reversal_of_id')
      .unique()
      .references((): AnyPgColumn => paymentVouchers.id),
    reversalReason: text('reversal_reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.orderId),
    index().on(t.unmatchedReceiptId),
    check('payment_vouchers_one_source', sql`num_nonnulls(${t.supplierInvoiceId}, ${t.orderId}, ${t.unmatchedReceiptId}) <= 1`),
    check('payment_vouchers_amount_sign', sql`${t.amount} <> 0 and (${t.reversalOfId} is null) = (${t.amount} > 0)`),
    check('payment_vouchers_reversal_reason', sql`(${t.reversalOfId} is null) = (${t.reversalReason} is null)`),
  ],
);

/** Hoá đơn nhà cung cấp (UC-PF-08); `supplier_id`, `purchase_order_id` trỏ purchasing, không khoá ngoại (19-D1). */
export const supplierInvoices = financeSchema.table(
  'supplier_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    purchaseOrderId: uuid('purchase_order_id'),
    invoiceNo: text('invoice_no').notNull(),
    invoiceDate: date('invoice_date').notNull(),
    amount: money('amount').notNull(),
    amountDue: money('amount_due').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.supplierId),
    index().on(t.purchaseOrderId),
    check('supplier_invoices_amount', sql`${t.amount} > 0`),
  ],
);

/** Bảng kê thanh toán của sàn; `shop_id` trỏ channel, `payment_status` giữ nguyên chữ của sàn (PAID, PROCESSING…). */
export const settlementStatements = financeSchema.table(
  'settlement_statements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id').notNull(),
    externalStatementId: text('external_statement_id').notNull(),
    statementTime: timestamp('statement_time', { withTimezone: true }).notNull(),
    settlementAmount: money('settlement_amount').notNull(),
    paymentStatus: text('payment_status').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.externalStatementId), index().on(t.shopId)],
);

/**
 * Dòng đối soát, một dòng mỗi giao dịch của bảng kê; chạy lại đối soát không sinh trùng nhờ `external_transaction_id`.
 * Khớp khi `revenue − Σfees − shipping_cost ± adjustment = settlement` (API 12.8, T23); `raw` là bản gốc của sàn.
 */
export const settlementLines = financeSchema.table(
  'settlement_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    statementId: uuid('statement_id')
      .notNull()
      .references(() => settlementStatements.id),
    kind: settlementLineKind('kind').notNull(),
    externalTransactionId: text('external_transaction_id').notNull(),
    orderId: uuid('order_id'),
    externalOrderId: text('external_order_id'),
    revenue: money('revenue').notNull(),
    fees: jsonb('fees').notNull(),
    shippingCost: money('shipping_cost').notNull().default('0'),
    adjustment: money('adjustment').notNull().default('0'),
    settlement: money('settlement').notNull(),
    matchStatus: matchStatus('match_status').notNull(),
    discrepancyReason: discrepancyReason('discrepancy_reason'),
    raw: jsonb('raw').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.externalTransactionId),
    index().on(t.statementId),
    index().on(t.orderId),
    check(
      'settlement_lines_discrepancy_reason',
      sql`(${t.matchStatus} = 'discrepancy') = (${t.discrepancyReason} is not null)`,
    ),
  ],
);

/** Bộ đếm số hoá đơn, phiếu thu, phiếu chi; `period` theo tháng nếu #27 đánh số theo kỳ (plan chuẩn bị A4/K5). */
export const docCounters = financeSchema.table(
  'doc_counters',
  {
    companyId: uuid('company_id').notNull(),
    docType: text('doc_type').notNull(),
    period: text('period').notNull().default(''),
    nextNumber: integer('next_number').notNull().default(1),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.docType, t.period] })],
);
