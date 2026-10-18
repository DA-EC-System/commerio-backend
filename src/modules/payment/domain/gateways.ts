// Cổng thanh toán và che khoá (Documents/21 §12.8, T4). Thuần, không I/O.

/** Bốn cổng, đúng thứ tự `GET /payment/gateways` trả về. Giá trị trùng enum `payment.gateway`. */
export const GATEWAYS = ['vnpay', 'momo', 'zalopay', 'vietqr'] as const;

export type Gateway = (typeof GATEWAYS)[number];

export const isGateway = (value: string): value is Gateway => (GATEWAYS as readonly string[]).includes(value);

/** Khoá của một cổng sau khi giải mã: tên ô → giá trị. Ô của từng cổng: `CredentialsByGateway` (api/schemas.ts). */
export type Credentials = Record<string, string>;

/** API không bao giờ trả lại khoá (T4): mỗi ô chỉ còn 4 ký tự cuối. */
export function maskCredentials(credentials: Credentials): Record<string, { last4: string }> {
  return Object.fromEntries(Object.entries(credentials).map(([field, value]) => [field, { last4: value.slice(-4) }]));
}
