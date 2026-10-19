import { z } from 'zod';

// Hợp đồng /finance (Documents/21 §12.5, §12.8, C1, C3, C6, V8; plan #27 PR3). Tiền là số nguyên đồng (T1).

export const page = {
  page: z.coerce.number('Trang là số nguyên từ 1').int('Trang là số nguyên từ 1').min(1, 'Trang là số nguyên từ 1').default(1),
  pageSize: z.coerce
    .number('Cỡ trang từ 1 đến 100')
    .int('Cỡ trang từ 1 đến 100')
    .min(1, 'Cỡ trang từ 1 đến 100')
    .max(100, 'Cỡ trang từ 1 đến 100')
    .default(20),
  search: z.string().trim().max(100, 'Từ khoá tối đa 100 ký tự').optional(),
};

const isoDay = (label: string) => z.iso.date(`${label} dạng yyyy-mm-dd`);
/** Ngày `yyyy-mm-dd` → đầu ngày (hoặc đầu ngày hôm sau, cho `to`) theo giờ Việt Nam (C6). */
const dayVn = (label: string, nextDay = false) =>
  isoDay(label)
    .transform((d) => new Date(Date.parse(`${d}T00:00:00+07:00`) + (nextDay ? 86_400_000 : 0)))
    .optional();
export const range = { from: dayVn('Từ ngày'), to: dayVn('Đến ngày', true) };

export const IdParams = z.object({ id: z.string() });

export const InvoiceListQuery = z.object({
  ...page,
  ...range,
  status: z.enum(['posted', 'reversed'], 'Trạng thái là posted hoặc reversed').optional(),
});

export const ReceiptListQuery = z.object({
  ...page,
  ...range,
  source: z.enum(['gateway', 'cod', 'settlement', 'unmatched_assignment'], 'Nguồn phiếu thu không hợp lệ').optional(),
  status: z.enum(['posted', 'reversed'], 'Trạng thái là posted hoặc reversed').optional(),
  orderId: z.string().optional(),
});

export const VoucherListQuery = z.object({
  ...page,
  // Phiếu chi lọc theo `paidOn` (cột ngày): giữ chuỗi ngày.
  from: isoDay('Từ ngày').optional(),
  to: isoDay('Đến ngày').optional(),
  purpose: z.enum(['supplier_payment', 'customer_refund', 'unmatched_refund'], 'Mục đích không hợp lệ').optional(),
  status: z.enum(['draft', 'posted', 'reversed'], 'Trạng thái không hợp lệ').optional(),
});

export const CodListQuery = z.object({
  ...page,
  ...range,
  status: z.enum(['cod_pending', 'cod_collected', 'not_collected'], 'Trạng thái COD không hợp lệ').default('cod_pending'),
});

export const RefundListQuery = z.object({
  ...page,
  status: z.enum(['pending_refund', 'refunded'], 'Trạng thái là pending_refund hoặc refunded').default('pending_refund'),
});

const amount = z
  .number('Số tiền là số nguyên đồng lớn hơn 0')
  .int('Số tiền là số nguyên đồng lớn hơn 0')
  .positive('Số tiền là số nguyên đồng lớn hơn 0');
const paidOn = isoDay('Ngày chi');
const note = z.string('Ghi chú là chuỗi').max(500, 'Ghi chú tối đa 500 ký tự').default('');
const version = z.number('Thiếu version').int('Thiếu version').min(0, 'Thiếu version');

export const CreateVoucherBody = z
  .object({
    purpose: z.enum(['supplier_payment', 'customer_refund', 'unmatched_refund'], 'Mục đích không hợp lệ'),
    orderId: z.string().toLowerCase().optional(),
    unmatchedReceiptId: z.string().toLowerCase().optional(),
    amount,
    paidOn,
    note,
  })
  .meta({ id: 'CreatePaymentVoucherRequest' });

export const UpdateVoucherBody = z.object({ amount, paidOn, note, version }).meta({ id: 'UpdatePaymentVoucherRequest' });
export const VersionBody = z.object({ version }).meta({ id: 'FinanceVersionRequest' });
export const VersionQuery = z.object({ version: z.coerce.number('Thiếu version').int('Thiếu version').positive('Thiếu version') });

export const CodConfirmationBody = z
  .object({
    orderIds: z
      .array(z.string(), 'Danh sách đơn là mảng mã đơn')
      .min(1, 'Chọn ít nhất 1 đơn')
      .max(100, 'Tối đa 100 đơn mỗi lần')
      .refine((ids) => new Set(ids).size === ids.length, 'Danh sách đơn bị trùng')
      .refine((ids) => ids.every((id) => z.uuid().safeParse(id).success), 'Mã đơn không hợp lệ')
      .transform((ids) => ids.map((id) => id.toLowerCase())),
  })
  .meta({ id: 'CodConfirmationRequest' });

export const RefundBody = z.object({ orderId: z.string('Chọn đơn cần hoàn').toLowerCase(), paidOn, note }).meta({ id: 'RefundRequest' });

// — Response (Swagger)

export const OrderRef = z.object({ id: z.uuid(), code: z.string(), customerName: z.string().nullable() });
const OrderRefPhone = OrderRef.extend({ customerPhone: z.string().nullable() });
export const DocRef = z.object({ id: z.uuid(), number: z.string() });
const UserRef = z.object({ id: z.uuid(), name: z.string() });
export const pageOf = <T extends z.ZodType>(item: T, id: string) =>
  z.object({ items: z.array(item), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() }).meta({ id });

export const InvoiceSummary = z
  .object({
    id: z.uuid(),
    number: z.string(),
    order: OrderRef.nullable(),
    status: z.enum(['posted', 'reversed']),
    issuedAt: z.string(),
    total: z.number().int(),
    reversalOf: DocRef.nullable(),
    reversedBy: DocRef.nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'InvoiceSummary' });
export const Invoice = InvoiceSummary.extend({
  lines: z.array(
    z.object({
      variantId: z.uuid(),
      sku: z.string(),
      productName: z.string(),
      attributesLabel: z.string(),
      quantity: z.number().int(),
      unitPrice: z.number().int(),
      lineTotal: z.number().int(),
    }),
  ),
  shippingFee: z.number().int().meta({ description: 'Tổng hoá đơn trừ tổng dòng hàng (plan #27 A20)' }),
  reversalReason: z.string().nullable(),
}).meta({ id: 'Invoice' });
export const Receipt = z
  .object({
    id: z.uuid(),
    number: z.string(),
    source: z.enum(['gateway', 'cod', 'settlement', 'unmatched_assignment']),
    order: OrderRef.nullable(),
    amount: z.number().int(),
    status: z.enum(['posted', 'reversed']),
    postedAt: z.string(),
    gateway: z.enum(['vnpay', 'momo', 'zalopay', 'vietqr']).nullable(),
    paymentTransactionId: z.uuid().nullable(),
    settlementLineId: z.uuid().nullable(),
    unmatchedReceiptId: z.uuid().nullable(),
    reversalOf: DocRef.nullable(),
    reversedBy: DocRef.nullable(),
    reversalReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'Receipt' });
export const PaymentVoucher = z
  .object({
    id: z.uuid(),
    number: z.string(),
    purpose: z.enum(['supplier_payment', 'customer_refund', 'unmatched_refund']),
    order: OrderRef.nullable(),
    unmatchedReceipt: z.object({ id: z.uuid(), amount: z.number().int(), transferContent: z.string().nullable() }).nullable(),
    supplierInvoiceId: z.uuid().nullable(),
    amount: z.number().int(),
    paidOn: z.string(),
    note: z.string(),
    status: z.enum(['draft', 'posted', 'reversed']),
    createdBy: UserRef.nullable(),
    createdAt: z.string(),
    postedBy: UserRef.nullable(),
    postedAt: z.string().nullable(),
    reversalOf: DocRef.nullable(),
    reversedBy: DocRef.nullable(),
    reversalReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: 'PaymentVoucher' });
export const CodOrder = z
  .object({
    order: OrderRefPhone.nullable(),
    amount: z.number().int(),
    deliveredAt: z.string().nullable(),
    status: z.enum(['cod_pending', 'cod_collected', 'not_collected']),
    receipt: DocRef.nullable(),
  })
  .meta({ id: 'CodOrder' });
export const RefundItem = z
  .object({
    order: OrderRefPhone.nullable(),
    paidAmount: z.number().int(),
    paidVia: z.string().nullable(),
    paidAt: z.string().nullable(),
    cancelledAt: z.string().nullable().meta({ description: 'Lúc chuyển chờ hoàn; `null` khi đã hoàn (plan #27 A11)' }),
    refundStatus: z.enum(['pending_refund', 'refunded']),
    voucher: DocRef.nullable(),
  })
  .meta({ id: 'RefundItem' });
export const CodConfirmationResult = z
  .object({ receipts: z.array(z.object({ orderId: z.uuid(), receipt: DocRef })) })
  .meta({ id: 'CodConfirmationResult' });

export const InvoicePage = pageOf(InvoiceSummary, 'InvoicePage');
export const ReceiptPage = pageOf(Receipt, 'ReceiptPage');
export const VoucherPage = pageOf(PaymentVoucher, 'PaymentVoucherPage');
export const CodPage = pageOf(CodOrder, 'CodOrderPage');
export const RefundPage = pageOf(RefundItem, 'RefundItemPage');
