import { z } from 'zod';
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
