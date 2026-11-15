// Khoá cổng đã lưu (UC-PF-11; Documents/21 mục 12 cũ). Webhook và tra cứu quá hạn đọc khoá ở đây; route xem, lưu khoá
// cổng (`GET`, `PUT /payment/gateways`) đã gỡ ở #235.
import type { Credentials, Gateway } from '../domain/gateways.ts';
import { findGatewayConfig } from '../repository/gateway-configs.ts';
import { decryptCredentials } from './credentials-cipher.ts';

const aadOf = (companyId: string, gateway: Gateway) => `${companyId}:${gateway}`;

/** Khoá đã giải mã của một cổng trong công ty đang mở giao dịch; `undefined` khi chưa cấu hình. */
export async function loadGatewayCredentials(gateway: Gateway): Promise<Credentials | undefined> {
  const row = await findGatewayConfig(gateway);
  return row?.credentialsEnc ? decryptCredentials(row.credentialsEnc, aadOf(row.companyId, gateway)) : undefined;
}
