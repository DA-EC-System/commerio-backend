import { z } from 'zod';
import { vnDayParam } from '../../../shared/http/vn-day.ts';
import { GATEWAYS, type Gateway } from '../domain/gateways.ts';

const text = (label: string) =>
  z.string(`Nhập ${label}`).trim().min(1, `Nhập ${label}`).max(200, `${label} tối đa 200 ký tự`);
// Ô bí mật tối thiểu 8 ký tự để `last4` không lộ gần hết giá trị (plan #23 A4).
const secret = (label: string) => text(label).min(8, `${label} tối thiểu 8 ký tự`);
const digits = (label: string, pattern: RegExp, rule: string) => text(label).regex(pattern, `${label} ${rule}`);

/** `GatewayCredentialsInput` (Documents/21 §12.8): gửi đủ các ô của cổng mỗi lần lưu (T11). Ô thừa bị bỏ. */
export const CredentialsByGateway = {
  vnpay: z.object({ tmnCode: text('mã website (vnp_TmnCode)'), hashSecret: secret('khoá bí mật (vnp_HashSecret)') }),
  momo: z.object({
    partnerCode: text('partnerCode'),
    accessKey: text('accessKey'),
    secretKey: secret('secretKey'),
  }),
  zalopay: z.object({ appId: digits('app_id', /^\d+$/, 'chỉ gồm chữ số'), key1: secret('key1'), key2: secret('key2') }),
  vietqr: z.object({
    bankBin: digits('mã BIN ngân hàng', /^\d{6}$/, 'gồm đúng 6 chữ số'),
    accountNo: digits('số tài khoản', /^\d{6,19}$/, 'gồm 6–19 chữ số'),
    accountName: text('tên chủ tài khoản').max(50, 'Tên chủ tài khoản tối đa 50 ký tự'),
    sepayApiKey: secret('API key SePay'),
  }),
} as const satisfies Record<Gateway, z.ZodObject>;

const version = z.number('version phải là số nguyên').int('version phải là số nguyên').min(0, 'version không âm').meta({ description: '0 khi cổng chưa cấu hình' });

/** Body của `PUT /gateways/:gateway` theo từng cổng. */
export const gatewayConfigBodyOf = (gateway: Gateway) => z.object({ credentials: CredentialsByGateway[gateway], version });

/** Chỉ cho Swagger: một trong bốn dạng body. */
export const GatewayConfigRequest = z
  .union(GATEWAYS.map(gatewayConfigBodyOf))
  .meta({ id: 'GatewayConfigRequest', description: '`credentials` gồm đủ các ô của cổng trong đường dẫn' });

// Schema trả về, chỉ dùng cho Swagger.
const GatewaySchema = z.enum(GATEWAYS).meta({ id: 'Gateway' });

export const GatewayConfig = z
  .object({
    gateway: GatewaySchema,
    configured: z.boolean(),
    version: z.number().int().meta({ description: 'Chưa cấu hình: 0' }),
    updatedAt: z.string().nullable(),
    updatedBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
    credentials: z
      .record(z.string(), z.object({ last4: z.string() }))
      .nullable()
      .meta({ description: 'Mỗi ô khoá chỉ trả 4 ký tự cuối; API không bao giờ trả khoá (T4)' }),
    display: z.object({ bankBin: z.string(), bankName: z.string(), accountName: z.string() }).nullable(),
    webhookUrl: z.string().nullable().meta({ description: 'Chỉ `vietqr`: URL webhook SePay riêng của công ty' }),
  })
  .meta({ id: 'GatewayConfig' });

export const GatewaySummary = z.object({ gateway: GatewaySchema, configured: z.boolean() }).meta({ id: 'GatewaySummary' });

export const GatewayParams = z.object({ gateway: GatewaySchema });

// `orderId` sai định dạng trả 404 ở service (như đơn không có), nên ở đây chỉ là chuỗi.
export const OrderParams = z.object({ orderId: z.string() });

export const CreateLinkBody = z
  .object({ gateway: z.enum(GATEWAYS, 'Chọn một trong 4 cổng: vnpay, momo, zalopay, vietqr') })
  .meta({ id: 'CreatePaymentLinkRequest' });

const linkStatus = z.enum(['active', 'paid', 'expired', 'cancelled']);

export const PaymentLink = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    gateway: GatewaySchema,
    paymentCode: z.string().meta({ example: 'CMABCDEFGH23' }),
    amount: z.number().int(),
    payUrl: z.string().nullable(),
    qrContent: z.string().meta({ description: 'Chuỗi để vẽ QR: VietQR là chuỗi EMVCo; MoMo là `qrCodeUrl` (momo://…); ZaloPay `qr_code` hoặc `order_url`; VNPay bằng `payUrl`' }),
    bankTransfer: z
      .object({ bankBin: z.string(), bankName: z.string(), accountNo: z.string(), accountName: z.string(), content: z.string() })
      .nullable(),
    expiresAt: z.string(),
    status: linkStatus,
    createdAt: z.string(),
    createdBy: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  })
  .meta({ id: 'PaymentLink' });

export const OrderPayment = z
  .object({
    orderId: z.uuid(),
    method: z.enum(['prepaid', 'cod']),
    status: z.enum(['unpaid', 'paid', 'cod_pending', 'cod_collected', 'not_collected']),
    refundStatus: z.enum(['none', 'pending_refund', 'refunded']),
    amount: z.number().int(),
    paidAt: z.string().nullable(),
    activeLink: PaymentLink.nullable(),
    links: z.array(
      PaymentLink.pick({ id: true, gateway: true, paymentCode: true, amount: true, status: true, expiresAt: true, createdAt: true }),
    ),
  })
  .meta({ id: 'OrderPayment' });

// — Đơn chưa thu cho hộp gán khoản thu chưa khớp (#27 R1, §12.11)

export const UnpaidOrderListQuery = z.object({
  page: z.coerce.number('Trang là số nguyên từ 1').int('Trang là số nguyên từ 1').min(1, 'Trang là số nguyên từ 1').default(1),
  pageSize: z.coerce
    .number('Cỡ trang từ 1 đến 100')
    .int('Cỡ trang từ 1 đến 100')
    .min(1, 'Cỡ trang từ 1 đến 100')
    .max(100, 'Cỡ trang từ 1 đến 100')
    .default(20),
  status: z.literal('unpaid', 'Chỉ hỗ trợ status=unpaid').default('unpaid'),
  search: z.string().trim().max(100, 'Từ khoá tối đa 100 ký tự').optional(),
});

export const UnpaidOrderPage = z
  .object({
    items: z.array(z.object({ order: z.object({ id: z.uuid(), code: z.string(), customerName: z.string().nullable() }), amount: z.number().int() })),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'UnpaidOrderPage' });

// — Giao dịch cổng (#27, §12.3 hai dòng cuối, §12.8 PaymentTransaction)

export const TransactionListQuery = z.object({
  page: z.coerce.number('Trang là số nguyên từ 1').int('Trang là số nguyên từ 1').min(1, 'Trang là số nguyên từ 1').default(1),
  pageSize: z.coerce
    .number('Cỡ trang từ 1 đến 100')
    .int('Cỡ trang từ 1 đến 100')
    .min(1, 'Cỡ trang từ 1 đến 100')
    .max(100, 'Cỡ trang từ 1 đến 100')
    .default(20),
  gateway: z.enum(GATEWAYS, 'Cổng là vnpay, momo, zalopay hoặc vietqr').optional(),
  status: z.enum(['pending', 'succeeded', 'failed', 'needs_review'], 'Trạng thái không hợp lệ').optional(),
  from: vnDayParam('Từ ngày'),
  to: vnDayParam('Đến ngày', true),
  search: z.string().trim().max(100, 'Từ khoá tối đa 100 ký tự').optional(),
});

export const TransactionParams = z.object({ id: z.string() });

const DocRef = z.object({ id: z.uuid(), number: z.string() });

export const PaymentTransaction = z
  .object({
    id: z.uuid(),
    gateway: GatewaySchema,
    gatewayTxnId: z.string(),
    paymentCode: z.string().nullable(),
    order: z.object({ id: z.uuid(), code: z.string(), customerName: z.string().nullable() }).nullable(),
    amount: z.number().int(),
    source: z.enum(['webhook', 'query', 'sepay']),
    status: z.enum(['pending', 'succeeded', 'failed', 'needs_review']),
    occurredAt: z.string(),
    receipt: DocRef.nullable(),
    unmatchedReceiptId: z.uuid().nullable(),
  })
  .meta({ id: 'PaymentTransaction' });

export const PaymentTransactionDetail = PaymentTransaction.extend({
  rawPayload: z.unknown().meta({ description: 'Payload của cổng, đã bỏ trường chữ ký' }),
}).meta({ id: 'PaymentTransactionDetail' });

export const TransactionPage = z
  .object({ items: z.array(PaymentTransaction), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'PaymentTransactionPage' });
