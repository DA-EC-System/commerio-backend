import { sql } from 'drizzle-orm';
import { boolean, check, date, index, integer, jsonb, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { approval, approvalCheck, money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module con `purchasing` khai báo trong schema của module lớn `product` (Documents/19 D1).
// Số chứng từ cấp từ `product.doc_counters` (inventory). `variant_id`, `category_id` (catalog), người làm (staff)
// là uuid thường: không đặt khoá ngoại sang module con khác.
export const purchasingSchema = pgSchema('product');

/** Nhà cung cấp; ngừng giao dịch thì `active = false` (`supplier_inactive`), không xoá. Tên không trùng (chữ thường). */
export const suppliers = purchasingSchema.table(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    name: text('name').notNull(),
    phone: text('phone'),
    email: text('email'),
    address: text('address'),
    note: text('note'),
    active: boolean('active').notNull().default(true),
    ...timestamps,
    ...version,
  },
  (t) => [uniqueIndex('suppliers_company_lower_name_uq').on(t.companyId, sql`lower(${t.name})`)],
);

/** Đề nghị nhập (25 §3.1, Documents/21 mục 16.3). */
export const purchaseRequestStatus = purchasingSchema.enum('purchase_request_status', [
  'draft',
  'pending_approval',
  'changes_requested',
  'rejected',
  'approved',
  'ordered',
  'partially_received',
  'received',
  'closed_short',
  'cancelled',
]);
/** `reorder`: gợi ý nhập lại đưa vào nháp; `replacement`: NCC bù hàng theo phiếu trả (`source_return_id`). */
export const purchaseRequestSource = purchasingSchema.enum('purchase_request_source', ['manual', 'reorder', 'replacement']);

/** Một lần xin nhập hàng của một NCC. Giá chốt cứng khi duyệt; số "đang về" tính từ dòng, không lưu. */
export const purchaseRequests = purchasingSchema.table(
  'purchase_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: purchaseRequestStatus('status').notNull().default('draft'),
    source: purchaseRequestSource('source').notNull().default('manual'),
    sourceReturnId: uuid('source_return_id'),
    expectedDeliveryDate: date('expected_delivery_date'),
    note: text('note'),
    statusReason: text('status_reason'),
    ...approval,
    orderedBy: uuid('ordered_by'),
    orderedAt: timestamp('ordered_at', { withTimezone: true }),
    closedBy: uuid('closed_by'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.status),
    index().on(t.supplierId),
    approvalCheck('purchase_requests', t),
    check('purchase_requests_supplier', sql`${t.status} in ('draft', 'cancelled') or ${t.supplierId} is not null`),
    check('purchase_requests_replacement', sql`(${t.source} = 'replacement') = (${t.sourceReturnId} is not null)`),
  ],
);

/**
 * Dòng đề nghị. Dòng sản phẩm mới chưa có `variant_id`; khi duyệt, hệ thống tạo SKU rồi điền vào.
 * `còn chờ = ordered − received − defective − closed_short` (25 §3.1), luôn ≥ 0. `excluded`: CEO loại dòng khi duyệt.
 */
export const purchaseRequestLines = purchasingSchema.table(
  'purchase_request_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => purchaseRequests.id),
    variantId: uuid('variant_id'),
    newProductName: text('new_product_name'),
    newCategoryId: uuid('new_category_id'),
    newVariantAttrs: jsonb('new_variant_attrs'),
    orderedQty: integer('ordered_qty').notNull(),
    receivedQty: integer('received_qty').notNull().default(0),
    defectiveQty: integer('defective_qty').notNull().default(0),
    closedShortQty: integer('closed_short_qty').notNull().default(0),
    unitPrice: money('unit_price').notNull(),
    excluded: boolean('excluded').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (t) => [
    // Một SKU một dòng trong một đề nghị; dòng sản phẩm mới (`variant_id` trống) không bị chặn.
    unique('purchase_request_lines_request_variant_uq').on(t.requestId, t.variantId),
    index().on(t.variantId),
    check('purchase_request_lines_item', sql`${t.variantId} is not null or ${t.newProductName} is not null`),
    check('purchase_request_lines_ordered', sql`${t.orderedQty} > 0`),
    check(
      'purchase_request_lines_counts',
      sql`${t.receivedQty} >= 0 and ${t.defectiveQty} >= 0 and ${t.closedShortQty} >= 0`,
    ),
    check(
      'purchase_request_lines_outstanding',
      sql`${t.orderedQty} - ${t.receivedQty} - ${t.defectiveQty} - ${t.closedShortQty} >= 0`,
    ),
    check('purchase_request_lines_unit_price', sql`${t.unitPrice} >= 0`),
  ],
);

/** Phiếu nhận (25 §4.1, Documents/21 mục 16.3). */
export const goodsReceiptStatus = purchasingSchema.enum('goods_receipt_status', [
  'counting',
  'matched',
  'short',
  'resolved',
  'cancelled',
]);
export const deliveryMode = purchasingSchema.enum('delivery_mode', ['driver_waiting', 'driver_left']);
export const shortResolution = purchasingSchema.enum('short_resolution', ['follow_up', 'close_short', 'supplier_wrong']);

/**
 * Một đợt NCC giao hàng cho một đề nghị. Ghi sổ một lần (`posted_by` khác người lập đề nghị, service kiểm vì khác
 * bảng); sau đó chỉ theo dõi chỗ giao thiếu. `check_deadline`: người giao đã đi thì phải kiểm xong trong 24 giờ.
 */
export const goodsReceipts = purchasingSchema.table(
  'goods_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => purchaseRequests.id),
    deliveryMode: deliveryMode('delivery_mode').notNull(),
    boxCount: integer('box_count'),
    status: goodsReceiptStatus('status').notNull().default('counting'),
    checkDeadline: timestamp('check_deadline', { withTimezone: true }),
    shortResolution: shortResolution('short_resolution'),
    followUpReceiptId: uuid('follow_up_receipt_id'),
    resolutionNote: text('resolution_note'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    note: text('note'),
    statusReason: text('status_reason'),
    createdBy: uuid('created_by'),
    postedBy: uuid('posted_by'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.requestId),
    check('goods_receipts_box_count', sql`${t.boxCount} > 0`),
    check('goods_receipts_resolved', sql`(${t.status} = 'resolved') = (${t.shortResolution} is not null)`),
    check(
      'goods_receipts_follow_up',
      sql`(${t.shortResolution} = 'follow_up') = (${t.followUpReceiptId} is not null)`,
    ),
    check(
      'goods_receipts_posted',
      sql`(${t.status} in ('matched', 'short', 'resolved')) = (${t.postedAt} is not null)`,
    ),
  ],
);

/**
 * Dòng phiếu nhận: số NCC báo giao, số đạt (vào tồn thực), số lỗi giữ lại (vào chờ xử lý), số trả tại chỗ.
 * `shortage_qty` tự tính. `đạt + lỗi ≤ còn chờ` của dòng đề nghị do service kiểm (khác bảng, `over_outstanding`).
 */
export const goodsReceiptLines = purchasingSchema.table(
  'goods_receipt_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    receiptId: uuid('receipt_id')
      .notNull()
      .references(() => goodsReceipts.id),
    requestLineId: uuid('request_line_id')
      .notNull()
      .references(() => purchaseRequestLines.id),
    variantId: uuid('variant_id').notNull(),
    declaredQty: integer('declared_qty').notNull().default(0),
    acceptedQty: integer('accepted_qty').notNull().default(0),
    defectiveQty: integer('defective_qty').notNull().default(0),
    returnedOnSpotQty: integer('returned_on_spot_qty').notNull().default(0),
    shortageQty: integer('shortage_qty').generatedAlwaysAs(
      sql`declared_qty - accepted_qty - defective_qty - returned_on_spot_qty`,
    ),
    reason: text('reason'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.receiptId, t.requestLineId),
    index().on(t.variantId),
    check(
      'goods_receipt_lines_counts',
      sql`${t.declaredQty} >= 0 and ${t.acceptedQty} >= 0 and ${t.defectiveQty} >= 0 and ${t.returnedOnSpotQty} >= 0`,
    ),
    check(
      'goods_receipt_lines_within_declared',
      sql`${t.acceptedQty} + ${t.defectiveQty} + ${t.returnedOnSpotQty} <= ${t.declaredQty}`,
    ),
  ],
);

/** Phiếu trả NCC (25 §4.3, Documents/21 mục 16.3). */
export const supplierReturnStatus = purchasingSchema.enum('supplier_return_status', [
  'draft',
  'pending_approval',
  'sent',
  'refunded',
  'replaced',
  'returned_to_us',
  'cancelled',
]);
export const supplierReturnSource = purchasingSchema.enum('supplier_return_source', [
  'receipt_defect',
  'quarantine',
  'customer_return',
  'write_off_rejected',
  'manual',
]);
export const cancelDecision = purchasingSchema.enum('cancel_decision', ['restock', 'write_off']);

/**
 * Hàng lỗi trả NCC. Gửi xong thì chờ xử lý giảm. Người ghi kết quả khác người gửi; hoàn tiền bắt buộc số tiền;
 * huỷ bắt buộc chọn nhập lại tồn hoặc xuất huỷ.
 */
export const supplierReturns = purchasingSchema.table(
  'supplier_returns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    number: text('number').notNull(),
    supplierId: uuid('supplier_id').references(() => suppliers.id),
    status: supplierReturnStatus('status').notNull().default('draft'),
    source: supplierReturnSource('source').notNull(),
    sourceId: uuid('source_id'),
    refundAmount: money('refund_amount'),
    replacementRequestId: uuid('replacement_request_id'),
    cancelDecision: cancelDecision('cancel_decision'),
    note: text('note'),
    statusReason: text('status_reason'),
    ...approval,
    sentBy: uuid('sent_by'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    resultBy: uuid('result_by'),
    resultAt: timestamp('result_at', { withTimezone: true }),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.number),
    index().on(t.status),
    approvalCheck('supplier_returns', t),
    check('supplier_returns_supplier', sql`${t.status} in ('draft', 'cancelled') or ${t.supplierId} is not null`),
    check('supplier_returns_refund', sql`(${t.status} = 'refunded') = (${t.refundAmount} is not null)`),
    check('supplier_returns_refund_amount', sql`${t.refundAmount} >= 1`),
    check('supplier_returns_cancel', sql`(${t.status} = 'cancelled') = (${t.cancelDecision} is not null)`),
    check('supplier_returns_result_by', sql`${t.resultBy} is null or ${t.resultBy} is distinct from ${t.sentBy}`),
  ],
);

export const supplierReturnLines = purchasingSchema.table(
  'supplier_return_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    returnId: uuid('return_id')
      .notNull()
      .references(() => supplierReturns.id),
    variantId: uuid('variant_id').notNull(),
    quantity: integer('quantity').notNull(),
    unitCost: money('unit_cost'),
    sourceLineId: uuid('source_line_id'),
    ...timestamps,
    ...version,
  },
  (t) => [index().on(t.returnId), index().on(t.variantId), check('supplier_return_lines_quantity', sql`${t.quantity} > 0`)],
);
