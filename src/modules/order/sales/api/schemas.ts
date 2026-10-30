// Schema Zod của route đơn (Documents/21 §19.1, §19.3). Tên `.meta({ id })` trùng kiểu ở FE `src/types/sales.ts`.
import { z } from 'zod';
import { vnDayParam } from '../../../../shared/http/vn-day.ts';

const iso = z.iso.datetime();
/** Tiền: số nguyên đồng (Documents/21 §1.1 R1). */
const money = z.number().int();

const ORDER_STATUS = ['unpaid', 'processing', 'completed', 'cancelled'] as const;
const PACKAGE_STATUS = [
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
] as const;
export const ORDER_FLAGS = [
  'needs_attention',
  'unmapped_sku',
  'cancel_requested',
  'cancelling',
  'platform_cancelled',
  'due_soon',
  'return_requested',
  'cod_mismatch',
  'shop_disconnected',
] as const;
const ORDER_STAGES = [
  'awaiting_payment',
  'awaiting_confirmation',
  'unmapped',
  'cancelling',
  'awaiting_completion',
  'completed',
  'cancelled',
  ...PACKAGE_STATUS.filter((s) => s !== 'cancelled'),
] as const;

export const OrderListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(100).optional().meta({ description: 'Mã đơn hoặc mã đơn sàn' }),
  status: z.enum(ORDER_STATUS).optional(),
  source: z.enum(['marketplace', 'inbox', 'manual']).optional(),
  shopId: z.uuid('Gian hàng không hợp lệ').optional(),
  paymentMethod: z.enum(['prepaid', 'cod']).optional(),
  stage: z.enum(ORDER_STAGES).optional(),
  flag: z.enum(ORDER_FLAGS).optional(),
  customerId: z.uuid('Khách hàng không hợp lệ').optional(),
  from: vnDayParam('Từ ngày'),
  to: vnDayParam('Đến ngày', true),
});

export const OrderParams = z.object({ id: z.string() });

const ShopRef = z.object({ id: z.uuid(), shopName: z.string(), platform: z.string() }).meta({ id: 'OrderShopRef' });

export const OrderSummary = z
  .object({
    id: z.uuid(),
    code: z.string(),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    shop: ShopRef.nullable(),
    customer: z.object({ id: z.uuid(), name: z.string(), phone: z.string() }).nullable(),
    status: z.enum(ORDER_STATUS),
    display: z.object({
      stage: z.enum(ORDER_STAGES),
      delivered: z.number().int().meta({ description: 'Kiện đã giao' }),
      packages: z.number().int().meta({ description: 'Kiện chưa huỷ' }),
    }),
    flags: z.array(z.enum(ORDER_FLAGS)),
    outcome: z.enum(['full', 'partial', 'none']).nullable(),
    rawMarketplaceStatus: z.string().nullable().meta({ description: 'Trạng thái gốc trên sàn, chỉ để hiện (R11)' }),
    paymentMethod: z.enum(['prepaid', 'cod']).nullable(),
    shipBy: iso.nullable(),
    total: money,
    lineCount: z.number().int(),
    createdAt: iso,
    createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'OrderSummary' });

export const OrderSummaryPage = z
  .object({ items: z.array(OrderSummary), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'OrderSummaryPage' });

const OrderLine = z
  .object({
    id: z.uuid(),
    variantId: z.uuid().nullable().meta({ description: 'null: dòng sàn chưa ghép SKU (cờ `unmapped_sku`)' }),
    sku: z.string(),
    productName: z.string(),
    attributesLabel: z.string(),
    quantity: z.number().int(),
    unitPrice: money,
    lineTotal: money,
    externalSku: z.string().nullable(),
  })
  .strict()
  .meta({ id: 'OrderLine' });

export const PackageSummary = z
  .object({
    id: z.uuid(),
    code: z.string(),
    order: z.object({ id: z.uuid(), code: z.string(), status: z.enum(ORDER_STATUS) }),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    shop: ShopRef.nullable(),
    customerName: z.string().nullable(),
    status: z.enum(PACKAGE_STATUS),
    flags: z.array(z.enum(['needs_open', 'needs_attention', 'lost_reported'])),
    flagNote: z.string().nullable(),
    openPurpose: z.enum(['cancel', 'edit', 'resplit']).nullable(),
    selfDelivery: z.boolean(),
    paymentMethod: z.enum(['prepaid', 'cod']).nullable(),
    paymentStatus: z.string().nullable().meta({ description: 'Chưa có: luôn null tới khi có trạng thái tiền theo đơn tay' }),
    trackingCode: z.string().nullable(),
    platformPackageCode: z.string().nullable(),
    carrier: z.object({ code: z.string(), name: z.string() }).nullable().meta({ description: 'Chọn lúc đóng gói (#106)' }),
    shipBy: iso.nullable(),
    lines: z.array(
      z.object({ variantId: z.uuid().nullable(), sku: z.string(), productName: z.string(), attributesLabel: z.string(), quantity: z.number().int() }),
    ),
    totalQty: z.number().int(),
    handedOverAt: iso.nullable(),
    deliveredAt: iso.nullable(),
    deliveredBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    lostReport: z.object({ by: z.object({ id: z.uuid(), name: z.string() }), at: iso, claimCode: z.string() }).nullable(),
    createdAt: iso,
    version: z.number().int(),
  })
  .strict()
  .meta({ id: 'PackageSummary' });

const StatusChange = z
  .object({
    at: iso,
    from: z.string().nullable(),
    to: z.string(),
    by: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    source: z.enum(['user', 'marketplace', 'system']),
    reason: z.string().nullable(),
  })
  .strict();

export const Order = OrderSummary.extend({
  shippingAddress: z.object({ name: z.string(), phone: z.string(), address: z.string() }).nullable(),
  subtotal: money,
  shippingFee: money,
  note: z.string(),
  cancelReason: z.string().nullable(),
  invoiceNumber: z.string().nullable(),
  lines: z.array(OrderLine),
  packages: z.array(PackageSummary),
  returnWindowEndsAt: iso.nullable().meta({ description: 'Hết hạn trả hàng, tính từ kiện giao cuối' }),
  completionBlocker: z
    .enum(['packages_open', 'return_window', 'return_requested', 'cod_unconfirmed'])
    .nullable()
    .meta({ description: 'Lý do chưa hoàn tất; null khi đơn đã dừng hoặc hoàn tất được' }),
  statusHistory: z.array(StatusChange),
})
  .strict()
  .meta({ id: 'Order' });
