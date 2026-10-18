import { z } from 'zod';

// Danh mục sự kiện giữa các module (plan chuẩn bị 4.4, Documents/21 D4). Tiền tố của type là module phát.
// Tiền trong payload là chuỗi thập phân ("150000.00") để không mất chính xác. Đổi danh mục là sửa file
// dùng chung: làm bằng PR riêng, báo các bên nghe.

const id = z.uuid();
const money = z.string().regex(/^-?\d+(\.\d+)?$/, 'Tiền là chuỗi thập phân');
const timestamp = z.iso.datetime({ offset: true });
const fulfillmentStatus = z.enum([
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

export const EVENT_SCHEMAS = {
  'inventory.stock_changed': z.object({ variantId: id, onHand: z.int(), reserved: z.int(), available: z.int() }),
  'inventory.below_threshold': z.object({ variantId: id, available: z.int(), minQty: z.int() }),
  'inventory.receipt_posted': z.object({
    receiptId: id,
    number: z.string(),
    kind: z.enum(['purchase', 'manual', 'delivery_return']),
    lines: z.array(z.object({ variantId: id, quantity: z.int().positive() })),
  }),
  'inventory.issue_posted': z.object({
    issueId: id,
    number: z.string(),
    kind: z.enum(['manual', 'order']),
    orderId: id.nullable(),
    postedAt: timestamp,
  }),
  'sales.order_created': z.object({
    orderId: id,
    code: z.string(),
    source: z.enum(['marketplace', 'inbox', 'manual']),
    total: money,
  }),
  'fulfillment.order_status_changed': z.object({
    orderId: id,
    from: fulfillmentStatus.nullable(),
    to: fulfillmentStatus,
    isShortStock: z.boolean(),
  }),
  'payment.succeeded': z.object({
    orderId: id,
    paymentTransactionId: id,
    gateway: z.enum(['vnpay', 'momo', 'zalopay', 'vietqr']),
    amount: money,
  }),
  'finance.invoice_posted': z.object({
    invoiceId: id,
    orderId: id,
    total: money,
    issuedAt: timestamp,
    reversalOf: id.nullable(),
  }),
  'finance.receipt_posted': z.object({
    receiptId: id,
    orderId: id.nullable(),
    amount: money,
    source: z.enum(['gateway', 'cod', 'settlement', 'unmatched_assignment']),
    postedAt: timestamp,
    reversalOf: id.nullable(),
  }),
  'finance.voucher_posted': z.object({
    voucherId: id,
    purpose: z.enum(['supplier_payment', 'customer_refund', 'unmatched_refund']),
    orderId: id.nullable(),
    amount: money,
    paidOn: z.iso.date(),
    reversalOf: id.nullable(),
  }),
  'purchasing.order_submitted': z.object({ purchaseOrderId: id, code: z.string() }),
} as const;

export type EventType = keyof typeof EVENT_SCHEMAS;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[T]>;
export const EVENT_TYPES = Object.keys(EVENT_SCHEMAS) as EventType[];
