import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { recordCodCollected } from '#src/modules/finance/index.ts';
import { markCodNotCollected } from '#src/modules/payment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { shop } from '../payment/helpers.ts';
import { api, codOrder, orderPayment } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Xác nhận tiền COD (UC-PF-04; Documents/21 §12.5 dòng COD, T18, R2; plan #27 AC-25…AC-27, AC-38). Đơn COD dựng bằng
// đường của #25: initOrderPayment khi xác nhận, markDelivered khi giao xong.

const receiptsOf = async (companyId: string) =>
  (await testPool().query("select number, source, amount, order_id from finance.receipts where company_id = $1 and source = 'cod' order by number", [companyId]))
    .rows;
const auditCount = async (companyId: string) =>
  Number(
    (await testPool().query("select count(*) from audit.audit_logs where company_id = $1 and entity_type = 'finance.receipts'", [companyId]))
      .rows[0].count,
  );

describe('GET /finance/cod-orders (AC-25)', () => {
  it('mặc định cod_pending đã giao: mã đơn, sđt khách, số tiền, ngày giao; đơn chưa giao không hiện; lọc theo ngày giao', async () => {
    const s = await shop();
    const delivered = await codOrder(s);
    await codOrder(s, false);
    const res = await api('get', '/cod-orders', s.ceo.token);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      {
        order: { id: delivered.orderId, code: delivered.code, customerName: null, customerPhone: null },
        amount: 200000,
        deliveredAt: '2026-10-18T03:00:00.000Z',
        status: 'cod_pending',
        receipt: null,
      },
    ]);
    expect((await api('get', '/cod-orders?from=2026-10-18&to=2026-10-18', s.ceo.token)).body.total).toBe(1);
    expect((await api('get', '/cod-orders?from=2026-10-19', s.ceo.token)).body.total).toBe(0);
  });

  it('tab not_collected có đơn COD huỷ trước khi giao (deliveredAt null)', async () => {
    const s = await shop();
    const o = await codOrder(s, false);
    await withCompany(s.companyId, () => markCodNotCollected(o.orderId));
    const res = await api('get', '/cod-orders?status=not_collected', s.ceo.token);
    expect(res.body.items).toEqual([expect.objectContaining({ status: 'not_collected', deliveredAt: null })]);
  });
});

describe('POST /finance/cod-confirmations (AC-26, AC-27)', () => {
  it('cả lô cod_pending đã giao → mỗi đơn cod_collected, một phiếu thu cod = tổng đơn, nhật ký; đọc lại thấy đủ', async () => {
    const s = await shop();
    const a = await codOrder(s);
    const b = await codOrder(s, true, 350000);
    const res = await api('post', '/cod-confirmations', s.ceo.token, { orderIds: [a.orderId, b.orderId] });
    expect(res.status).toBe(200);
    expect(res.body.receipts).toEqual(
      expect.arrayContaining([
        { orderId: a.orderId, receipt: { id: expect.any(String), number: expect.stringMatching(/^PT-/) } },
        { orderId: b.orderId, receipt: { id: expect.any(String), number: expect.stringMatching(/^PT-/) } },
      ]),
    );
    expect(await orderPayment(a.orderId)).toMatchObject({ status: 'cod_collected', paid_at: expect.any(Date) });
    expect((await receiptsOf(s.companyId)).map((r) => [r.order_id, r.amount]).toSorted()).toEqual(
      [
        [a.orderId, '200000.00'],
        [b.orderId, '350000.00'],
      ].toSorted(),
    );
    expect(await auditCount(s.companyId)).toBe(2);
    const tab = await api('get', '/cod-orders?status=cod_collected', s.ceo.token);
    expect(tab.body.items.every((i: { receipt: unknown }) => i.receipt)).toBe(true);
  });

  it('một đơn không còn cod_pending hoặc chưa giao → 409 payment_state_changed kèm danh sách, cả lô không đổi', async () => {
    const s = await shop();
    const ok = await codOrder(s);
    const notDelivered = await codOrder(s, false);
    const res = await api('post', '/cod-confirmations', s.ceo.token, { orderIds: [ok.orderId, notDelivered.orderId] });
    expect(res.status).toBe(409);
    expect(res.body.type).toContain('payment_state_changed');
    expect(res.body.orders).toEqual([{ orderId: notDelivered.orderId, code: notDelivered.code, status: 'cod_pending' }]);
    expect(await orderPayment(ok.orderId)).toMatchObject({ status: 'cod_pending' });
    expect(await receiptsOf(s.companyId)).toEqual([]);

    await api('post', '/cod-confirmations', s.ceo.token, { orderIds: [ok.orderId] });
    const again = await api('post', '/cod-confirmations', s.ceo.token, { orderIds: [ok.orderId] });
    expect(again.status).toBe(409);
    expect(again.body.orders).toEqual([expect.objectContaining({ orderId: ok.orderId, status: 'cod_collected' })]);
  });

  it('hai lô chồng nhau gửi song song: một lô thành công, lô kia 409, mỗi đơn đúng một phiếu thu', async () => {
    const s = await shop();
    const a = await codOrder(s);
    const b = await codOrder(s);
    const [r1, r2] = await Promise.all([
      api('post', '/cod-confirmations', s.ceo.token, { orderIds: [a.orderId, b.orderId] }),
      api('post', '/cod-confirmations', s.ceo.token, { orderIds: [b.orderId, a.orderId] }),
    ]);
    expect([r1.status, r2.status].toSorted()).toEqual([200, 409]);
    expect(await receiptsOf(s.companyId)).toHaveLength(2);
  });

  it('recordCodCollected (hàm export): đúng tổng đơn → phiếu thu cod; khác tổng → 422 amount_mismatch, không đổi', async () => {
    const s = await shop();
    const o = await codOrder(s);
    await expect(withCompany(s.companyId, () => recordCodCollected(o.orderId, new Decimal(1000)))).rejects.toMatchObject({
      status: 422,
      code: 'amount_mismatch',
    });
    expect(await orderPayment(o.orderId)).toMatchObject({ status: 'cod_pending' });
    const r = await withCompany(s.companyId, () => recordCodCollected(o.orderId, new Decimal(200000)));
    expect(r.number).toMatch(/^PT-/);
    expect(await orderPayment(o.orderId)).toMatchObject({ status: 'cod_collected' });
  });

  it('422 orderIds rỗng, trùng, quá 100, sai định dạng; 404 đơn công ty khác; 403 thiếu finance.voucher.create (AC-38)', async () => {
    const s = await shop();
    const mine = await codOrder(s);
    const other = await shop();
    const theirs = await codOrder(other);
    const t = s.ceo.token;
    for (const orderIds of [[], [mine.orderId, mine.orderId], Array.from({ length: 101 }, () => mine.orderId), ['x']]) {
      const res = await api('post', '/cod-confirmations', t, { orderIds });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('orderIds');
    }
    expect((await api('post', '/cod-confirmations', t, { orderIds: [mine.orderId, theirs.orderId] })).status).toBe(404);
    const viewer = await addMember(s.companyId, 'sale');
    expect((await api('post', '/cod-confirmations', viewer.token, { orderIds: [] })).status).toBe(403);
    expect((await api('post', '/cod-confirmations', undefined, { orderIds: [mine.orderId] })).status).toBe(401);
    expect(await orderPayment(mine.orderId)).toMatchObject({ status: 'cod_pending' });
  });
});
