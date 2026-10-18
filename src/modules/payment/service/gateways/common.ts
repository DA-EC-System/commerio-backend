// Kiểu và tiện ích chung của các cổng (Strategy, docs/16 #9; plan #23 A11).
import { createHmac } from 'node:crypto';
import type { Decimal } from 'decimal.js';
import { AppError } from '../../../../shared/errors/app-error.ts';
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

/** Strategy của một cổng. #27 thêm xác minh chữ ký, ánh xạ trạng thái, truy vấn lại (`Documents/03` mục 6). */
export interface PaymentGateway {
  createPayment(input: PaymentInput, credentials: Credentials, signal: AbortSignal): Promise<CreatedPayment>;
}

export const hmacHex = (algorithm: 'sha256' | 'sha512', key: string, data: string) =>
  createHmac(algorithm, key).update(data, 'utf8').digest('hex');

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
