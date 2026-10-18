import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { handleVerifiedPayment } from '#src/modules/finance/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { linkedOrder, verified } from '../finance/helpers.ts';
import { addMember, createCompany } from '../helpers/company.ts';
import { testApp } from '../helpers/http.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Giao dịch cổng (Documents/21 §12.3 hai dòng cuối, §12.8 PaymentTransaction; plan #27 AC-20, A21, AC-38).
const get = (token: string | undefined, path: string) => {
  const req = request(testApp()).get(`/api/v1/payment/transactions${path}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

async function paidAndMismatch() {
  const l = await linkedOrder();
  const paid = verified(l, { rawPayload: { content: `ck ${l.link.paymentCode}` } });
  await withCompany(l.companyId, () => handleVerifiedPayment(paid));
  const mismatch = verified(l, { amount: new Decimal(1000) });
  await withCompany(l.companyId, () => handleVerifiedPayment(mismatch));
  return { ...l, paid, mismatch };
}

describe('GET /payment/transactions', () => {
  it('CEO thấy giao dịch mới nhất trước, có mã thanh toán, đơn, phiếu thu hoặc khoản thu chưa khớp (AC-20, A21)', async () => {
    const l = await paidAndMismatch();
    const res = await get(l.ceo.token, '');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    const byKey = new Map(res.body.items.map((t: { gatewayTxnId: string }) => [t.gatewayTxnId, t]));
    expect(byKey.get(l.paid.gatewayTxnId)).toMatchObject({
      gateway: 'vietqr',
      paymentCode: l.link.paymentCode,
      order: { id: l.orderId, code: l.code, customerName: null },
      amount: 150000,
      source: 'sepay',
      status: 'succeeded',
      receipt: { id: expect.any(String), number: 'PT-000001' },
      unmatchedReceiptId: null,
    });
    expect(byKey.get(l.mismatch.gatewayTxnId)).toMatchObject({ status: 'needs_review', receipt: null, unmatchedReceiptId: expect.any(String) });
  });

  it('lọc theo status, gateway; tìm theo mã thanh toán, mã đơn; phân trang', async () => {
    const l = await paidAndMismatch();
    expect((await get(l.ceo.token, '?status=needs_review')).body.items).toHaveLength(1);
    expect((await get(l.ceo.token, '?gateway=momo')).body.total).toBe(0);
    expect((await get(l.ceo.token, `?search=${l.link.paymentCode.toLowerCase()}`)).body.total).toBe(2);
    expect((await get(l.ceo.token, `?search=${l.code}`)).body.total).toBe(2);
    expect((await get(l.ceo.token, '?search=khongcogi')).body.total).toBe(0);
    const page2 = await get(l.ceo.token, '?page=2&pageSize=1');
    expect(page2.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
    expect(page2.body.items).toHaveLength(1);
  });

  it('chi tiết có rawPayload (adapter đã bỏ chữ ký, xem unit callbacks.test.ts) và phiếu thu', async () => {
    const l = await paidAndMismatch();
    const list = await get(l.ceo.token, '?status=succeeded');
    const res = await get(l.ceo.token, `/${list.body.items[0].id}`);
    expect(res.status).toBe(200);
    expect(res.body.rawPayload).toEqual({ content: `ck ${l.link.paymentCode}` });
    expect(res.body.receipt).toMatchObject({ number: 'PT-000001' });
  });

  it('401 không token; 403 Sale (thiếu payment.transaction.view); 404 giao dịch công ty khác, id lạ; 422 lọc sai (AC-38)', async () => {
    const l = await paidAndMismatch();
    const other = await createCompany();
    const sale = await addMember(l.companyId, 'sale');
    const id = (await get(l.ceo.token, '')).body.items[0].id;
    expect((await get(undefined, '')).status).toBe(401);
    expect((await get(sale.token, '')).status).toBe(403);
    expect((await get(other.ceo.token, `/${id}`)).status).toBe(404);
    expect((await get(other.ceo.token, '')).body.total).toBe(0);
    expect((await get(l.ceo.token, `/${randomUUID()}`)).status).toBe(404);
    expect((await get(l.ceo.token, '/khong-phai-uuid')).status).toBe(404);
    const bad = await get(l.ceo.token, '?status=xyz&from=2026-13-40');
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors)).toEqual(expect.arrayContaining(['status', 'from']));
  });
});
