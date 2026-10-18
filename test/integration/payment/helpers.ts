import request from 'supertest';
import { expect } from 'vitest';
import { createVariant } from '../helpers/catalog.ts';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { testApp } from '../helpers/http.ts';
import { createOrder } from '../helpers/sales.ts';

// Helper riêng của test payment (#23). File test dùng chúng phải đặt PAYMENT_CREDENTIALS_KEY trong vi.hoisted.

export const CREDENTIALS = {
  vnpay: { tmnCode: 'TESTCODE', hashSecret: 'SECRETHASHKEY123' },
  momo: { partnerCode: 'MOMO', accessKey: 'ACCESSKEY-0001', secretKey: 'SECRETKEY-ABCDEF-9999' },
  zalopay: { appId: '2553', key1: 'KEY1-ZALOPAY-TEST', key2: 'KEY2-ZALOPAY-TEST' },
  vietqr: { bankBin: '970422', accountNo: '0123456789', accountName: 'CONG TY THU', sepayApiKey: 'SEPAY-KEY-55667788' },
} as const;

/** Công ty có CEO (lưu khoá) và Sale (tạo mã). */
export async function shop(...gateways: (keyof typeof CREDENTIALS)[]) {
  const company = await createCompany();
  for (const gateway of gateways) {
    const res = await request(testApp())
      .put(`/api/v1/payment/gateways/${gateway}`)
      .set('Authorization', `Bearer ${company.ceo.token}`)
      .send({ credentials: CREDENTIALS[gateway], version: 0 });
    expect(res.status).toBe(200);
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

/** `POST /payment/orders/:orderId/links`; không có token thì gọi không kèm header. */
export function createLink(token: string | undefined, orderId: string, gateway: string) {
  const req = request(testApp()).post(`/api/v1/payment/orders/${orderId}/links`);
  if (token) req.set('Authorization', `Bearer ${token}`);
  return req.send({ gateway });
}

export const linksOf = async (orderId: string) =>
  (
    await testPool().query(
      'select id, status, gateway, amount, payment_code, gateway_order_ref, expires_at from payment.payment_links where order_id = $1 order by created_at',
      [orderId],
    )
  ).rows;

export const orderPaymentOf = async (orderId: string) =>
  (await testPool().query('select status, refund_status from payment.order_payments where order_id = $1', [orderId])).rows[0];
