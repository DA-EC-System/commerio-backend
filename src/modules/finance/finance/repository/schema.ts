import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
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
import { approval, approvalCheck, money, timestamps, version } from '../../../../shared/db/columns.ts';

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

/** Hoá đơn nhà cung cấp (UC-PF-08); `supplier_id`, `purchase_request_id` trỏ purchasing, không khoá ngoại (19-D1). */
export const supplierInvoices = financeSchema.table(
  'supplier_invoices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    supplierId: uuid('supplier_id').notNull(),
    purchaseRequestId: uuid('purchase_request_id'),
    invoiceNo: text('invoice_no').notNull(),
    invoiceDate: date('invoice_date').notNull(),
    amount: money('amount').notNull(),
    amountDue: money('amount_due').notNull(),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.supplierId),
    index().on(t.purchaseRequestId),
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
    batchId: uuid('batch_id').references((): AnyPgColumn => settlementBatches.id),
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

export const settlementSource = financeSchema.enum('settlement_source', ['api', 'file']);
export const batchStatus = financeSchema.enum('settlement_batch_status', ['running', 'done', 'failed']);

/**
 * Một lần kéo quyết toán của một gian hàng, bằng API hoặc file khi gian hàng đã ngắt. Mốc kéo của gian hàng
 * (`channel.shops.settlement_cursor`) chỉ tiến khi lô `done`: chạy lại an toàn (D4.3).
 */
export const settlementBatches = financeSchema.table(
  'settlement_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id').notNull(),
    source: settlementSource('source').notNull(),
    fileId: uuid('file_id'),
    periodFrom: timestamp('period_from', { withTimezone: true }).notNull(),
    periodTo: timestamp('period_to', { withTimezone: true }).notNull(),
    status: batchStatus('status').notNull().default('running'),
    lineCount: integer('line_count').notNull().default(0),
    /** Giao dịch sàn đã có trong sổ, lần chạy này bỏ qua (#117). */
    duplicates: integer('duplicates').notNull().default(0),
    /** Số dư sàn báo trừ số dư theo sổ khi lô xong; khác 0 thì cờ `wallet_mismatch` (#117). */
    walletDiff: money('wallet_diff'),
    error: text('error'),
    createdBy: uuid('created_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.shopId),
    check('settlement_batches_file', sql`(${t.source} = 'file') = (${t.fileId} is not null)`),
    check('settlement_batches_period', sql`${t.periodFrom} <= ${t.periodTo}`),
  ],
);

/** Loại khoản trong sổ tiền (25 §10.1). Ghi gộp: doanh thu và từng loại phí là dòng riêng, không ghi số thực nhận. */
export const ledgerKind = financeSchema.enum('ledger_kind', [
  'revenue',
  'platform_subsidy',
  'shipping_income',
  'shipping_cost',
  'fee_fixed',
  'fee_transaction',
  'fee_service',
  'fee_optional',
  'withholding_tax',
  'customer_refund',
  'return_fee',
  'lost_compensation',
  'penalty',
  'cogs',
  'cogs_reversal',
  'ads',
  'opex',
  'supplier_payment',
  'supplier_refund',
  'cod_collected',
  'adjustment',
  // Rút từ ví sàn về ngân hàng (#117): tiền chuyển chỗ, không vào lãi.
  'withdrawal',
]);

/**
 * Sổ tiền, chỉ thêm (T1): mỗi khoản một dòng, số có dấu (vào dương, ra âm), cờ ước tính hay thực tế. Có quyết toán
 * thì thêm dòng thực tế trỏ `replaces_entry_id` về dòng ước tính; sai thì thêm dòng `adjustment`, không sửa dòng cũ.
 * Mỗi dòng lưu bản cấu hình phí, thuế đã dùng. Khoản không gắn đơn (quảng cáo, chi vận hành) để trống đơn và kiện.
 */
export const ledgerEntries = financeSchema.table(
  'ledger_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    kind: ledgerKind('kind').notNull(),
    amount: money('amount').notNull(),
    isEstimate: boolean('is_estimate').notNull(),
    occurredOn: date('occurred_on').notNull(),
    orderId: uuid('order_id'),
    packageId: uuid('package_id'),
    returnRequestId: uuid('return_request_id'),
    shopId: uuid('shop_id'),
    sourceType: text('source_type'),
    sourceId: uuid('source_id'),
    replacesEntryId: uuid('replaces_entry_id').references((): AnyPgColumn => ledgerEntries.id),
    configVersionId: uuid('config_version_id'),
    settlementLineId: uuid('settlement_line_id').references(() => settlementLines.id),
    /** Mã giao dịch của sàn trên dòng thực tế; kéo lại cùng kỳ không ghi trùng (#117). */
    externalTransactionId: text('external_transaction_id'),
    reason: text('reason'),
    createdBy: uuid('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.orderId),
    index().on(t.shopId, t.occurredOn),
    index().on(t.occurredOn),
    uniqueIndex('ledger_entries_replaces_uq').on(t.replacesEntryId).where(sql`${t.replacesEntryId} is not null`),
    uniqueIndex('ledger_entries_external_txn_uq')
      .on(t.companyId, t.externalTransactionId)
      .where(sql`${t.externalTransactionId} is not null`),
    check('ledger_entries_amount', sql`${t.amount} <> 0`),
    check('ledger_entries_actual_replaces', sql`${t.replacesEntryId} is null or not ${t.isEstimate}`),
    check('ledger_entries_adjustment_reason', sql`${t.kind} <> 'adjustment' or ${t.reason} is not null`),
  ],
);

/**
 * Khớp dòng sổ (rút tiền, NCC hoàn tiền, bồi thường) với sao kê ngân hàng (#117, Documents/21 §21.3). Bảng riêng vì
 * sổ chỉ thêm, không cập nhật dòng; mỗi dòng sổ khớp tối đa một lần. RLS ở migration `--custom`.
 */
export const bankMatches = financeSchema.table(
  'bank_matches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    entryId: uuid('entry_id')
      .notNull()
      .references(() => ledgerEntries.id),
    bankRef: text('bank_ref').notNull(),
    matchedBy: uuid('matched_by').notNull(),
    matchedAt: timestamp('matched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bank_matches_entry_uq').on(t.entryId), check('bank_matches_ref', sql`length(trim(${t.bankRef})) > 0`)],
);

/** Trạng thái tiền của đơn (25 §10.3, Hình 14 báo cáo 28/10), tách khỏi trạng thái đơn (N1). */
export const settlementState = financeSchema.enum('settlement_state', ['none', 'pending', 'settled', 'mismatch', 'resolved']);

/**
 * Một dòng mỗi đơn sàn. `diff` = thực tế − ước tính; lệch vượt ngưỡng thì `mismatch`. Chốt lệch ghi người và lý do;
 * lệch vượt ngưỡng chốt cần CEO duyệt (`approved_by`). `resolved_diff_base` là lệch lúc chốt, để lần điều chỉnh sau
 * tính lệch từ đó.
 */
export const orderSettlements = financeSchema.table(
  'order_settlements',
  {
    orderId: uuid('order_id').primaryKey(),
    companyId: uuid('company_id').notNull(),
    shopId: uuid('shop_id'),
    status: settlementState('status').notNull().default('none'),
    estimatedTotal: money('estimated_total').notNull().default('0'),
    settledTotal: money('settled_total'),
    diff: money('diff'),
    resolvedDiffBase: money('resolved_diff_base'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedReason: text('resolved_reason'),
    approvedBy: uuid('approved_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.status),
    check(
      'order_settlements_resolved',
      sql`${t.status} <> 'resolved' or (${t.resolvedBy} is not null and ${t.resolvedReason} is not null)`,
    ),
    check('order_settlements_settled', sql`${t.status} not in ('settled', 'resolved') or ${t.settledTotal} is not null`),
    check('order_settlements_approver', sql`${t.approvedBy} is null or ${t.approvedBy} is distinct from ${t.resolvedBy}`),
  ],
);

/** Loại cấu hình tiền có phiên bản (25 §10, T5): không cứng hoá mức phí, thuế suất, ngưỡng. */
export const configKind = financeSchema.enum('config_kind', ['fee', 'tax_regime', 'tax_rules', 'mismatch_threshold', 'min_margin']);
/** Vòng đời phiên bản (Hình 15 báo cáo 28/10). */
export const configStatus = financeSchema.enum('config_status', [
  'draft',
  'pending_approval',
  'rejected',
  'scheduled',
  'active',
  'expired',
  'cancelled',
]);

/**
 * Phiên bản cấu hình phí (theo gian hàng), loại hình thuế, quy tắc thuế, ngưỡng lệch, biên tối thiểu. Nội dung
 * trong `payload`, Zod kiểm theo `kind`. Chọn phiên bản theo ngày kiện giao. Không có hai bản `active` chồng ngày
 * cho cùng (công ty, loại, gian hàng): ràng buộc EXCLUDE viết tay trong migration RLS (drizzle không sinh được).
 */
export const configVersions = financeSchema.table(
  'config_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    kind: configKind('kind').notNull(),
    shopId: uuid('shop_id'),
    status: configStatus('status').notNull().default('draft'),
    payload: jsonb('payload').notNull(),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    supersedesId: uuid('supersedes_id').references((): AnyPgColumn => configVersions.id),
    isCorrection: boolean('is_correction').notNull().default(false),
    retroactiveFrom: date('retroactive_from'),
    dryRunResult: jsonb('dry_run_result'),
    statusReason: text('status_reason'),
    ...approval,
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.kind, t.shopId, t.status),
    approvalCheck('config_versions', t),
    check('config_versions_fee_shop', sql`(${t.kind} = 'fee') = (${t.shopId} is not null)`),
    check(
      'config_versions_effective',
      sql`${t.status} not in ('scheduled', 'active', 'expired') or ${t.effectiveFrom} is not null`,
    ),
    check('config_versions_range', sql`${t.effectiveTo} is null or ${t.effectiveTo} >= ${t.effectiveFrom}`),
    check('config_versions_retroactive', sql`${t.retroactiveFrom} is null or ${t.isCorrection}`),
    check('config_versions_approved', sql`${t.status} not in ('scheduled', 'active', 'expired') or ${t.approvedBy} is not null`),
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
