import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createLink, order, shop } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 5).toString('base64');
});

// Trạng thái thanh toán của đơn (commerio-backend#23 PR2; Documents/21 §12.3 dòng 4, §12.8 OrderPayment, A8, T13; plan A12, A13).
const get = (token: string | undefined, orderId: string) => {
  const req = request(testApp()).get(`/api/v1/payment/orders/${orderId}`);
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('GET /payment/orders/:orderId', () => {
  it('đơn chưa có dòng order_payments → trạng thái suy từ đơn, không 404 (AC-23)', async () => {
    const s = await shop();
    const prepaid = await order(s);
    const cod = await order(s, 200000, { paymentMethod: 'cod' });
    const a = await get(s.sale.token, prepaid.orderId);
    expect(a.status).toBe(200);
    expect(a.body).toEqual({
      orderId: prepaid.orderId,
      method: 'prepaid',
      status: 'unpaid',
      refundStatus: 'none',
      amount: 150000,
      paidAt: null,
      activeLink: null,
      links: [],
    });
    expect((await get(s.sale.token, cod.orderId)).body).toMatchObject({ method: 'cod', status: 'cod_pending', amount: 200000 });
  });

  it('có mã còn hạn: activeLink đủ PaymentLink (kể cả bankTransfer); lịch sử mới nhất trước, mã quá hạn hiện expired (AC-23)', async () => {
    const s = await shop('vietqr');
    const o = await order(s);
    const first = await createLink(s.sale.token, o.orderId, 'vietqr');
    await testPool().query("update finance.payment_links set expires_at = now() - interval '1 minute' where id = $1", [first.body.id]);
    const stale = await get(s.sale.token, o.orderId);
    expect(stale.body.activeLink).toBeNull();
    expect(stale.body.links).toEqual([expect.objectContaining({ id: first.body.id, status: 'expired' })]);

    const second = await createLink(s.sale.token, o.orderId, 'vietqr');
    const res = await get(s.sale.token, o.orderId);
    expect(res.body.status).toBe('unpaid');
    expect(res.body.activeLink).toEqual({ ...second.body, createdBy: second.body.createdBy });
    expect(res.body.links.map((l: { id: string }) => l.id)).toEqual([second.body.id, first.body.id]);
    expect(Object.keys(res.body.links[0]).sort()).toEqual(['amount', 'createdAt', 'expiresAt', 'gateway', 'id', 'paymentCode', 'status']);
  });

  it('đơn sàn → 404; đơn công ty khác → 404; Nhân viên kho → 403; thiếu token → 401 (AC-23, AC-24)', async () => {
    const s = await shop();
    const market = await order(s, 150000, { source: 'marketplace' });
    expect((await get(s.sale.token, market.orderId)).status).toBe(404);
    const o = await order(s);
    const other = await createCompany();
    expect((await get(other.ceo.token, o.orderId)).status).toBe(404);
    const kho = await addMember(s.companyId, 'warehouse');
    expect((await get(kho.token, o.orderId)).body.type).toBe('/problems/forbidden');
    expect((await get(undefined, o.orderId)).status).toBe(401);
  });
});
