import { randomBytes, randomInt } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { vi } from 'vitest';
import type { Gateway } from '#src/modules/finance/payment/index.ts';
import { initOrderPayment } from '#src/modules/finance/payment/index.ts';
import { encryptCredentials } from '#src/modules/finance/payment/service/credentials-cipher.ts';
import { GatewayFactory } from '#src/modules/finance/payment/service/gateways/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// Helper riêng của test payment (#23). File test dùng chúng phải đặt PAYMENT_CREDENTIALS_KEY trong vi.hoisted.
// Route lưu khoá cổng, tạo mã thanh toán đã gỡ ở #235 (cổng thanh toán ngoài MVP); webhook, tra cứu quá hạn còn giữ,
// nên test ghi thẳng khoá cổng và mã thanh toán vào bảng (khoá mã hoá đúng cách, mã dựng bằng adapter thật của cổng).

export const CREDENTIALS = {
  vnpay: { tmnCode: 'TESTCODE', hashSecret: 'SECRETHASHKEY123' },
  momo: { partnerCode: 'MOMO', accessKey: 'ACCESSKEY-0001', secretKey: 'SECRETKEY-ABCDEF-9999' },
  zalopay: { appId: '2553', key1: 'KEY1-ZALOPAY-TEST', key2: 'KEY2-ZALOPAY-TEST' },
  vietqr: { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-55667788' },
} as const;

/** Công ty có CEO, Sale và các cổng đã lưu khoá (VietQR kèm khoá nhận webhook SePay riêng). */
export async function shop(...gateways: (keyof typeof CREDENTIALS)[]) {
  const company = await createCompany();
  for (const gateway of gateways) {
    await testPool().query(
      `insert into finance.gateway_configs (company_id, gateway, credentials_enc, is_configured, webhook_receiver_key)
       values ($1, $2, $3, true, $4)`,
      [
        company.companyId,
        gateway,
        encryptCredentials(CREDENTIALS[gateway], `${company.companyId}:${gateway}`),
        gateway === 'vietqr' ? randomBytes(24).toString('base64url') : null,
      ],
    );
  }
  const sale = await addMember(company.companyId, 'sale');
  const { variantId } = await createVariant(company.companyId);
  return { ...company, sale, variantId };
}

/** Đơn một dòng của công ty; mặc định đơn tay trả trước. */
export function order(
  s: { companyId: string; variantId: string },
  unitPrice = 150000,
  options: Omit<Parameters<typeof createOrder>[1], 'lines'> = {},
) {
  return createOrder(s.companyId, { lines: [{ variantId: s.variantId, quantity: 1, unitPrice }], ...options });
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** Mã thanh toán dạng `CM` + 10 ký tự (Documents/21 T3). */
const paymentCode = () => `CM${Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')}`;

/** Trả lời giả của cổng khi tạo mã (MoMo, ZaloPay gọi mạng; VNPay, VietQR không). */
function fakeCreate(gateway: Gateway) {
  if (gateway === 'momo') return { resultCode: 0, payUrl: 'https://test-payment.momo.vn/pay?t=x', qrCodeUrl: 'momo://x' };
  if (gateway === 'zalopay') return { return_code: 1, order_url: 'https://qcgateway.zalopay.vn/openinapp?order=x' };
  return undefined;
}

/**
 * Mã thanh toán `active` 15 phút của đơn trả trước `unpaid`. Ô của cổng (`gateway_order_ref`, `pay_url`, `qr_content`)
 * lấy từ `createPayment` của adapter thật, `fetch` ra cổng bị thay bằng bản giả.
 */
export async function insertLink(companyId: string, o: { orderId: string; code: string }, gateway: Gateway, amount: number) {
  const code = paymentCode();
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 15 * 60_000);
  const reply = fakeCreate(gateway);
  const spy = reply
    ? vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(reply), { status: 200 }))
    : undefined;
  const created = await GatewayFactory.of(gateway)
    .createPayment(
      {
        paymentCode: code,
        orderCode: o.code,
        amount: new Decimal(amount),
        createdAt,
        expiresAt,
        clientIp: '127.0.0.1',
        ipnBaseUrl: 'http://localhost/api/v1/payment/webhooks',
        returnUrl: 'http://localhost/thanh-toan/ket-qua',
      },
      CREDENTIALS[gateway],
      AbortSignal.timeout(10_000),
    )
    .finally(() => spy?.mockRestore());
  await withCompany(companyId, () => initOrderPayment(o.orderId, 'prepaid'));
  const { rows } = await testPool().query<{ id: string }>(
    `insert into finance.payment_links (company_id, order_id, gateway, payment_code, gateway_order_ref, amount, pay_url, qr_content, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [companyId, o.orderId, gateway, code, created.gatewayOrderRef, amount.toFixed(2), created.payUrl, created.qrContent, expiresAt],
  );
  return { id: rows[0]!.id, paymentCode: code, amount };
}
