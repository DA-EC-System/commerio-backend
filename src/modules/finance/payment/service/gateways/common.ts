// Kiểu và tiện ích chung của các cổng (Strategy, docs/16 #9; plan #23 A11).
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import { AppError } from '../../../../../shared/errors/app-error.ts';
import type { Credentials } from '../../domain/gateways.ts';

export interface PaymentInput {
  paymentCode: string;
  orderCode: string;
  /** Số nguyên đồng (luật theo đơn đã kiểm). */
  amount: Decimal;
  createdAt: Date;
  expiresAt: Date;
  /** IP của người tạo mã (VNPay đòi `vnp_IpAddr`). */
  clientIp: string;
  /** `<gốc API>/api/v1/payment/webhooks`; cổng gọi về `<ipnBaseUrl>/<cổng>`. */
  ipnBaseUrl: string;
  /** Trang FE báo "đã nhận yêu cầu" sau khi khách trả (§12.4). */
  returnUrl: string;
}

export interface CreatedPayment {
  payUrl: string | null;
  /** Chuỗi để FE vẽ QR (§12.8). */
  qrContent: string;
  /** Mã đơn bên cổng, #27 dùng để tra cứu quá hạn. */
  gatewayOrderRef: string | null;
}

/** Request cổng gọi về (webhook): query đã giải mã, body JSON, header viết thường. */
export interface CallbackInput {
  query: Record<string, unknown>;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

/** Kết quả cổng báo (webhook hoặc tra cứu), đã kiểm chữ ký. `eventKey` = `gatewayTxnId` = khoá chống trùng (§12.4). */
export interface GatewayResult {
  paymentCode: string | null;
  eventKey: string;
  gatewayTxnId: string;
  amount: Decimal;
  succeeded: boolean;
  occurredAt: Date;
  /** Payload của cổng, đã bỏ trường chữ ký. */
  rawPayload: Record<string, unknown>;
}

/** Điều cần báo lại cho cổng; mỗi cổng đổi thành mã và body riêng (§12.4, T6). */
export type CallbackOutcome = 'recorded' | 'duplicate' | 'unmatched' | 'failed' | 'bad_signature' | 'not_found' | 'error';

/** Mã thanh toán đang chờ tra cứu: đủ để hỏi cổng. */
export interface QueryTarget {
  paymentCode: string;
  gatewayOrderRef: string | null;
  createdAt: Date;
}

/** Strategy của một cổng (docs/16 #9; `Documents/03` mục 6): tạo mã, đọc và kiểm chữ ký callback, phản hồi, tra cứu lại. */
export interface PaymentGateway {
  createPayment(input: PaymentInput, credentials: Credentials, signal: AbortSignal): Promise<CreatedPayment>;
  /** Mã thanh toán trong callback, đọc **trước** khi biết công ty (để tìm khoá, D16); không có thì `null`. */
  codeOf(input: CallbackInput): string | null;
  /** Kiểm chữ ký bằng khoá của công ty rồi đọc kết quả. */
  readCallback(input: CallbackInput, credentials: Credentials): GatewayResult | 'bad_signature';
  respond(outcome: CallbackOutcome): { status: number; body: unknown };
  /** Hỏi cổng mã đã quá hạn (§12.4 tra cứu quá hạn): đã trả → kết quả; chưa trả → `pending`; cổng không biết mã → `not_found`. */
  queryPayment(target: QueryTarget, credentials: Credentials, signal: AbortSignal): Promise<GatewayResult | 'pending' | 'not_found'>;
}

export const hmacHex = (algorithm: 'sha256' | 'sha512', key: string, data: string) =>
  createHmac(algorithm, key).update(data, 'utf8').digest('hex');

/** So chuỗi bí mật (chữ ký hex, API key) không lộ thời gian; khác độ dài thì sai, không ném. */
export function sameSecret(a: unknown, b: string, ignoreCase = false): boolean {
  if (typeof a !== 'string') return false;
  const x = Buffer.from(ignoreCase ? a.toLowerCase() : a);
  const y = Buffer.from(ignoreCase ? b.toLowerCase() : b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Bỏ các trường chữ ký trước khi lưu payload (plan #27 A18). */
export function withoutSignature(payload: Record<string, unknown>, ...fields: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !fields.includes(k)));
}

/** `yyyyMMddHHmmss` (VNPay) hoặc `yyyy-MM-dd HH:mm:ss` (SePay) theo giờ Việt Nam → `Date`; sai định dạng thì `null`. */
export function fromVnTime(value: unknown): Date | null {
  const m = typeof value === 'string' ? /^(\d{4})-?(\d{2})-?(\d{2})[ T]?(\d{2}):?(\d{2}):?(\d{2})$/.exec(value) : null;
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+07:00`) : null;
}

export const asRecord = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Khoá chống trùng: mã giao dịch của cổng; cổng báo `0` (giao dịch thất bại) thì gắn mã thanh toán và mã lỗi (A7). */
export const txnKey = (txnId: unknown, paymentCode: string, resultCode: unknown) =>
  txnId === undefined || txnId === null || String(txnId) === '0' ? `0:${paymentCode}:${String(resultCode)}` : String(txnId);

/** Mô tả đơn không dấu, không ký tự đặc biệt (VNPay cấm, các cổng khác hiện cho khách). */
export const orderInfo = (orderCode: string) => `Thanh toan don ${orderCode.replace(/[^A-Za-z0-9]/g, '')}`;

/** Ngày giờ theo giờ Việt Nam (GMT+7), dạng `yyyyMMddHHmmss`. */
export function vnTimestamp(date: Date): string {
  return new Date(date.getTime() + 7 * 3600_000).toISOString().slice(0, 19).replace(/\D/g, '');
}

export function gatewayUnavailable(detail: string): AppError {
  return new AppError(502, 'gateway_unavailable', detail);
}

/** POST tới cổng và đọc JSON, kể cả khi HTTP không 2xx (MoMo trả 400 kèm `resultCode`). Lỗi mạng, quá hạn → 502. */
export async function postJson(
  name: string,
  url: string,
  init: { body: string; contentType: string },
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': init.contentType }, body: init.body, signal });
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw gatewayUnavailable(`Không gọi được ${name} (lỗi mạng hoặc quá 10 giây)`);
  }
}
