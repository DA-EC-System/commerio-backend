import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { linkedOrder, moneyRows, orderPayment } from '../finance/helpers.ts';
import { addMember, createCompany } from '../helpers/company.ts';
import { testApp } from '../helpers/http.ts';
import { shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.PUBLIC_API_URL = 'https://commerio.example.vn';
});

// Mô phỏng trả tiền cho demo/E2E (Documents/21 §12.11; plan #27 A12, AC-21) và URL IPN của VNPay (A13, AC-22).
const simulate = (token: string | undefined, code: string) => {
  const req = request(testApp()).post(`/api/v1/payment/dev/simulate/${code}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('POST /payment/dev/simulate/:paymentCode (AC-21)', () => {
  it('Sale mô phỏng trả đủ tiền → 200 recorded, đi đúng đường webhook: phiếu thu, đơn paid; lần hai → duplicate', async () => {
    const l = await linkedOrder('vietqr');
    const res = await simulate(l.sale.token, l.link.paymentCode);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ outcome: 'recorded' });
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid' });
    expect((await moneyRows(l.companyId)).txns).toEqual([expect.objectContaining({ gateway: 'vietqr', source: 'webhook', status: 'succeeded' })]);
    expect((await simulate(l.sale.token, l.link.paymentCode)).body).toEqual({ outcome: 'duplicate' });
  });

  it('401 không token; 403 Nhân viên kho; 404 mã của công ty khác hoặc không có', async () => {
    const l = await linkedOrder('vietqr');
    const other = await createCompany();
    const warehouse = await addMember(l.companyId, 'warehouse');
    expect((await simulate(undefined, l.link.paymentCode)).status).toBe(401);
    expect((await simulate(warehouse.token, l.link.paymentCode)).status).toBe(403);
    expect((await simulate(other.ceo.token, l.link.paymentCode)).status).toBe(404);
    expect((await simulate(l.sale.token, 'CMNOTEXIST22')).status).toBe(404);
  });
});

describe('GatewayConfig.webhookUrl của vnpay (AC-22, A13)', () => {
  it('CEO thấy URL IPN chung để khai với VNPay; vietqr vẫn là URL riêng của công ty', async () => {
    const s = await shop('vnpay', 'vietqr');
    const res = await request(testApp()).get('/api/v1/payment/gateways').set('Authorization', `Bearer ${s.ceo.token}`);
    const byGateway = new Map(res.body.map((g: { gateway: string }) => [g.gateway, g]));
    expect(byGateway.get('vnpay')).toMatchObject({ webhookUrl: 'https://commerio.example.vn/api/v1/payment/webhooks/vnpay' });
    expect(byGateway.get('vietqr')).toMatchObject({ webhookUrl: expect.stringMatching(/\/webhooks\/sepay\/.{32}$/) });
    expect(byGateway.get('momo')).toMatchObject({ webhookUrl: null });
  });
});
