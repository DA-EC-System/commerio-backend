import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgSchema, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { money, timestamps, version } from '../../../../shared/db/columns.ts';

// Mọi bảng của module con `fulfillment` khai báo trong schema của module lớn `order` (Documents/19 D1).
// `order_id`, `order_line_id` (sales) và `variant_id` (product), người làm (staff) là uuid thường.
export const fulfillmentSchema = pgSchema('order');

/** Kiện (25 §8.3, Documents/21 mục 19.2). Lịch sử chuyển ở `core.state_transitions`. */
export const packageStatus = fulfillmentSchema.enum('package_status', [
  'backordered',
  'reserved',
  'packed',
  'awaiting_pickup',
  'self_delivering',
  'in_transit',
  'delivered',
  'delivery_failed',
  'returning',
  'returned',
  'lost',
  'cancelled',
]);
export const openPurpose = fulfillmentSchema.enum('open_purpose', ['cancel', 'edit', 'resplit']);

/**
 * Một gói hàng đi chung một mã vận đơn, gồm món của một đơn. Đơn vị giữ hàng, đóng gói, bàn giao, giao, hoàn.
 * Kiện tạm (sàn chưa gửi danh sách kiện) chưa có `platform_package_code`. Sàn gộp nhiều đơn vào một gói thì mỗi đơn
 * một kiện, chung mã kiện sàn và mã vận đơn (nhóm gói). Thất lạc bằng tay cần mã khiếu nại và người thứ hai; xác nhận
 * COD tự giao do người khác người giao.
 */
export const packages = fulfillmentSchema.table(
  'packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    orderId: uuid('order_id').notNull(),
    shopId: uuid('shop_id'),
    platformPackageCode: text('platform_package_code'),
    trackingCode: text('tracking_code'),
    selfDelivery: boolean('self_delivery').notNull().default(false),
    status: packageStatus('status').notNull(),
    needsOpen: boolean('needs_open').notNull().default(false),
    openPurpose: openPurpose('open_purpose'),
    needsAttention: boolean('needs_attention').notNull().default(false),
    flagNote: text('flag_note'),
    shipBy: timestamp('ship_by', { withTimezone: true }),
    packedBy: uuid('packed_by'),
    packedAt: timestamp('packed_at', { withTimezone: true }),
    handedOverBy: uuid('handed_over_by'),
    handedOverAt: timestamp('handed_over_at', { withTimezone: true }),
    deliveredBy: uuid('delivered_by'),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    codExpected: money('cod_expected'),
    codCollected: money('cod_collected'),
    codConfirmedBy: uuid('cod_confirmed_by'),
    codConfirmedAt: timestamp('cod_confirmed_at', { withTimezone: true }),
    lostReportedBy: uuid('lost_reported_by'),
    lostReportedAt: timestamp('lost_reported_at', { withTimezone: true }),
    lostClaimCode: text('lost_claim_code'),
    lostConfirmedBy: uuid('lost_confirmed_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    uniqueIndex('packages_platform_code_order_uq')
      .on(t.shopId, t.platformPackageCode, t.orderId)
      .where(sql`${t.platformPackageCode} is not null`),
    index().on(t.orderId),
    index().on(t.status),
    index().on(t.trackingCode),
    check('packages_open', sql`${t.needsOpen} = (${t.openPurpose} is not null)`),
    check('packages_cod_second_person', sql`${t.codConfirmedBy} is null or ${t.codConfirmedBy} is distinct from ${t.deliveredBy}`),
    check(
      'packages_lost_second_person',
      sql`${t.lostConfirmedBy} is null or ${t.lostConfirmedBy} is distinct from ${t.lostReportedBy}`,
    ),
    check('packages_lost_report', sql`(${t.lostReportedBy} is null) = (${t.lostClaimCode} is null)`),
    check('packages_handed_over', sql`${t.status} in ('backordered', 'reserved', 'packed', 'awaiting_pickup', 'cancelled') or ${t.handedOverAt} is not null`),
    check('packages_cod', sql`${t.codExpected} >= 0 and ${t.codCollected} >= 0`),
  ],
);

/**
 * Dòng kiện. Giữ nguyên dòng: `reserved_qty` là 0 hoặc đủ `quantity` (25 §7.4). `unit_cost` chốt lúc bàn giao;
 * `stock_deducted` bảo đảm trừ tồn đúng một lần, kể cả khi sàn báo nhảy cóc. Dòng chưa ghép SKU thì `variant_id` trống.
 */
export const packageLines = fulfillmentSchema.table(
  'package_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    packageId: uuid('package_id')
      .notNull()
      .references(() => packages.id),
    orderLineId: uuid('order_line_id').notNull(),
    variantId: uuid('variant_id'),
    quantity: integer('quantity').notNull(),
    reservedQty: integer('reserved_qty').notNull().default(0),
    packedQty: integer('packed_qty').notNull().default(0),
    unitCost: money('unit_cost'),
    stockDeducted: boolean('stock_deducted').notNull().default(false),
    ...timestamps,
    ...version,
  },
  (t) => [
    index().on(t.packageId),
    index().on(t.variantId),
    check('package_lines_quantity', sql`${t.quantity} > 0`),
    check('package_lines_reserved_whole', sql`${t.reservedQty} in (0, ${t.quantity})`),
    check('package_lines_packed', sql`${t.packedQty} >= 0 and ${t.packedQty} <= ${t.quantity}`),
    check('package_lines_unmapped', sql`${t.variantId} is not null or ${t.reservedQty} = 0`),
    check('package_lines_deducted_cost', sql`not ${t.stockDeducted} or ${t.unitCost} is not null`),
  ],
);

export const unmatchedParcelStatus = fulfillmentSchema.enum('unmatched_parcel_status', ['open', 'attached', 'dismissed']);

/** Kiện hàng trả quét được mà không khớp yêu cầu trả nào; hàng nằm ở chờ xử lý tới khi gắn hoặc bỏ (Documents/21 mục 20). */
export const unmatchedReturnParcels = fulfillmentSchema.table(
  'unmatched_return_parcels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    code: text('code').notNull(),
    scannedCode: text('scanned_code').notNull(),
    status: unmatchedParcelStatus('status').notNull().default('open'),
    returnRequestId: uuid('return_request_id'),
    note: text('note'),
    statusReason: text('status_reason'),
    receivedBy: uuid('received_by'),
    ...timestamps,
    ...version,
  },
  (t) => [
    unique().on(t.companyId, t.code),
    index().on(t.status),
    check('unmatched_return_parcels_attached', sql`(${t.status} = 'attached') = (${t.returnRequestId} is not null)`),
    check('unmatched_return_parcels_dismissed', sql`${t.status} <> 'dismissed' or ${t.statusReason} is not null`),
  ],
);
