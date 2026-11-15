// Cổng thanh toán (Documents/21 mục 12 cũ). Thuần, không I/O.

/** Bốn cổng. Giá trị trùng enum `payment.gateway`. */
export const GATEWAYS = ['vnpay', 'momo', 'zalopay', 'vietqr'] as const;

export type Gateway = (typeof GATEWAYS)[number];

/** Khoá của một cổng sau khi giải mã: tên ô → giá trị (vnpay `tmnCode`, `hashSecret`; momo `partnerCode`, `accessKey`,
 * `secretKey`; zalopay `appId`, `key1`, `key2`; vietqr `bankBin`, `accountNo`, `accountName`, `sepayApiKey`). */
export type Credentials = Record<string, string>;
