import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '#src/app.ts';

// Route tiền cũ đã gỡ ở #235 (Documents/21 mục 12 "(bỏ)", thay bằng mục 21): gọi vào là 404, không phải 401/403
// (route không còn, nên không tới bước kiểm token). Route mới của mục 21 vẫn còn: không token thì 401.
const GONE: readonly [method: 'get' | 'post' | 'put' | 'delete', path: string][] = [
  ['get', '/api/v1/finance/invoices'],
  ['get', '/api/v1/finance/invoices/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['get', '/api/v1/finance/receipts'],
  ['get', '/api/v1/finance/receipts/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['get', '/api/v1/finance/payment-vouchers'],
  ['get', '/api/v1/finance/payment-vouchers/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['post', '/api/v1/finance/payment-vouchers'],
  ['put', '/api/v1/finance/payment-vouchers/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['delete', '/api/v1/finance/payment-vouchers/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['post', '/api/v1/finance/payment-vouchers/8e172605-0612-4451-bfc4-cce4d356069b/post'],
  ['get', '/api/v1/finance/cod-orders'],
  ['post', '/api/v1/finance/cod-confirmations'],
  ['get', '/api/v1/finance/unmatched-receipts'],
  ['post', '/api/v1/finance/unmatched-receipts/8e172605-0612-4451-bfc4-cce4d356069b/assign'],
  ['post', '/api/v1/finance/unmatched-receipts/8e172605-0612-4451-bfc4-cce4d356069b/refund'],
  ['get', '/api/v1/finance/refunds'],
  ['post', '/api/v1/finance/refunds'],
  ['get', '/api/v1/payment/gateways'],
  ['put', '/api/v1/payment/gateways/vnpay'],
  ['post', '/api/v1/payment/orders/8e172605-0612-4451-bfc4-cce4d356069b/links'],
  ['get', '/api/v1/payment/orders/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['get', '/api/v1/payment/orders'],
  ['get', '/api/v1/payment/transactions'],
  ['get', '/api/v1/payment/transactions/8e172605-0612-4451-bfc4-cce4d356069b'],
  ['post', '/api/v1/payment/dev/simulate/CMABCDEFGHJK'],
];

describe('route tiền cũ đã gỡ (#235)', () => {
  const app = createApp();

  it.each(GONE)('%s %s → 404', async (method, path) => {
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(404);
  });

  it.each([
    ['get', '/api/v1/finance/ledger'],
    ['get', '/api/v1/finance/payments'],
    ['get', '/api/v1/finance/settlement-runs'],
    ['get', '/api/v1/finance/configs'],
  ] as const)('route mục 21 còn: %s %s không token → 401', async (method, path) => {
    expect((await request(app)[method](path)).status).toBe(401);
  });
});
