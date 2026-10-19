import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { addMember } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { api, orderPayment, paidOrder, refundPendingOrder } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Phiếu chi, hoàn tiền (UC-PF-05, UC-PF-06; Documents/21 §12.5, T19, T20, C3, V8; plan #27 AC-28…AC-33, AC-38, A11).
// Đơn cần hoàn dựng bằng đường thật: thu qua handler webhook, huỷ đơn (cột của #25) rồi markRefundPending.

const draftBody = (orderId: string, over: Record<string, unknown> = {}) => ({
  purpose: 'customer_refund',
  orderId,
  amount: 150000,
  paidOn: '2026-10-19',
  note: 'Hoàn tiền đơn huỷ',
  ...over,
});
const events = async (companyId: string) =>
  (await testPool().query("select payload from platform.outbox_messages where company_id = $1 and type = 'finance.voucher_posted'", [companyId]))
    .rows;

describe('POST /finance/payment-vouchers (AC-28)', () => {
  it('lập phiếu chi nháp PC-000001 cho đơn chờ hoàn, người lập là người gọi; đọc lại qua GET', async () => {
    const l = await refundPendingOrder();
    const res = await api('post', '/payment-vouchers', l.ceo.token, draftBody(l.orderId));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      number: 'PC-000001',
      purpose: 'customer_refund',
      order: { id: l.orderId, code: l.code, customerName: null },
      unmatchedReceipt: null,
      supplierInvoiceId: null,
      amount: 150000,
      paidOn: '2026-10-19',
      note: 'Hoàn tiền đơn huỷ',
      status: 'draft',
      createdBy: { id: expect.any(String), name: expect.any(String) },
      postedBy: null,
      postedAt: null,
      reversalOf: null,
      reversedBy: null,
      reversalReason: null,
      version: 1,
    });
    expect((await api('get', `/payment-vouchers/${res.body.id}`, l.ceo.token)).body).toMatchObject({ number: 'PC-000001' });
    expect((await api('get', '/payment-vouchers?status=draft', l.ceo.token)).body.total).toBe(1);
  });

  it('422 theo ô: supplier_payment, thiếu/sai chứng từ gốc, đơn không cần hoàn, số tiền ≤ 0 / lẻ / khác số đã thu, ngày, ghi chú', async () => {
    const l = await refundPendingOrder();
    const notRefundable = await paidOrder();
    const t = l.ceo.token;
    const cases: [Record<string, unknown>, string][] = [
      [{ purpose: 'supplier_payment' }, 'purpose'],
      [{ orderId: undefined }, 'orderId'],
      [{ orderId: notRefundable.orderId }, 'orderId'],
      [{ orderId: randomUUID() }, 'orderId'],
      [{ unmatchedReceiptId: randomUUID() }, 'unmatchedReceiptId'],
      [{ amount: 0 }, 'amount'],
      [{ amount: 1500.5 }, 'amount'],
      [{ amount: 100000 }, 'amount'],
      [{ paidOn: '19/10/2026' }, 'paidOn'],
      [{ note: 'x'.repeat(501) }, 'note'],
    ];
    for (const [over, field] of cases) {
      const res = await api('post', '/payment-vouchers', t, draftBody(l.orderId, over));
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.errors, JSON.stringify(over)).toHaveProperty(field);
    }
  });
});

describe('GET /finance/payment-vouchers (AC-31)', () => {
  it('lọc purpose, status, from/to theo paidOn, search theo số phiếu và mã đơn; UUID chữ hoa vẫn nhận', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const v = (await api('post', '/payment-vouchers', t, draftBody(l.orderId.toUpperCase()))).body;
    expect(v.order).toMatchObject({ id: l.orderId });
    expect((await api('get', '/payment-vouchers?purpose=customer_refund&status=draft', t)).body.total).toBe(1);
    expect((await api('get', '/payment-vouchers?purpose=unmatched_refund', t)).body.total).toBe(0);
    expect((await api('get', '/payment-vouchers?from=2026-10-19&to=2026-10-19', t)).body.total).toBe(1);
    expect((await api('get', '/payment-vouchers?from=2026-10-20', t)).body.total).toBe(0);
    expect((await api('get', `/payment-vouchers?search=${v.number.toLowerCase()}`, t)).body.total).toBe(1);
    expect((await api('get', `/payment-vouchers?search=${l.code}`, t)).body.total).toBe(1);
  });
});

describe('PUT, DELETE, post phiếu chi (AC-29, AC-30)', () => {
  it('sửa nháp đúng version → 200 version 2; version cũ → 409 kèm current; xoá thiếu version → 422; xoá đúng → 204', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const id = (await api('post', '/payment-vouchers', t, draftBody(l.orderId))).body.id;
    const put = await api('put', `/payment-vouchers/${id}`, t, { amount: 150000, paidOn: '2026-10-20', note: 'Sửa', version: 1 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ paidOn: '2026-10-20', note: 'Sửa', version: 2 });
    const stale = await api('put', `/payment-vouchers/${id}`, t, { amount: 150000, paidOn: '2026-10-21', note: 'Cũ', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ version: 2, note: 'Sửa' });
    expect((await api('put', `/payment-vouchers/${id}`, t, { amount: 1, paidOn: '2026-10-20', note: '', version: 2 })).status).toBe(422);
    const noVersion = await api('delete', `/payment-vouchers/${id}`, t);
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.errors).toHaveProperty('version');
    expect((await api('delete', `/payment-vouchers/${id}?version=2`, t)).status).toBe(204);
    expect((await api('get', `/payment-vouchers/${id}`, t)).status).toBe(404);
  });

  it('ghi sổ → posted, đơn refunded, sự kiện, nhật ký; phiếu đã ghi sổ: sửa/xoá/ghi lại → 409 not_draft', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const id = (await api('post', '/payment-vouchers', t, draftBody(l.orderId))).body.id;
    const posted = await api('post', `/payment-vouchers/${id}/post`, t, { version: 1 });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ status: 'posted', postedBy: { id: expect.any(String) }, postedAt: expect.any(String), version: 2 });
    expect(await orderPayment(l.orderId)).toMatchObject({ refund_status: 'refunded' });
    expect(await events(l.companyId)).toHaveLength(1);
    expect((await api('put', `/payment-vouchers/${id}`, t, { amount: 150000, paidOn: '2026-10-20', note: '', version: 2 })).body.type).toContain(
      'not_draft',
    );
    expect((await api('delete', `/payment-vouchers/${id}?version=2`, t)).status).toBe(409);
    expect((await api('post', `/payment-vouchers/${id}/post`, t, { version: 2 })).body.type).toContain('not_draft');
  });

  it('hai phiếu nháp cùng đơn: ghi sổ phiếu thứ hai → 409 already_processed nêu số phiếu đã có; version cũ → 409', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const first = (await api('post', '/payment-vouchers', t, draftBody(l.orderId))).body;
    const second = (await api('post', '/payment-vouchers', t, draftBody(l.orderId))).body;
    expect((await api('post', `/payment-vouchers/${first.id}/post`, t, { version: 9 })).status).toBe(409);
    await api('post', `/payment-vouchers/${first.id}/post`, t, { version: 1 });
    const res = await api('post', `/payment-vouchers/${second.id}/post`, t, { version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.type).toContain('already_processed');
    expect(res.body.detail).toContain(first.number);
  });
});

describe('Hoàn tiền (AC-32, AC-33)', () => {
  it('GET /refunds: đơn chờ hoàn có số đã thu, cổng, ngày thu, ngày huỷ; sau khi hoàn sang tab refunded có phiếu chi', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const pending = await api('get', '/refunds', t);
    expect(pending.body.items).toEqual([
      {
        order: { id: l.orderId, code: l.code, customerName: null, customerPhone: null },
        paidAmount: 150000,
        paidVia: 'vietqr',
        paidAt: expect.any(String),
        cancelledAt: expect.any(String),
        refundStatus: 'pending_refund',
        voucher: null,
      },
    ]);
    const res = await api('post', '/refunds', t, { orderId: l.orderId, paidOn: '2026-10-19', note: 'CK lại cho khách' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ purpose: 'customer_refund', status: 'posted', amount: 150000, order: { id: l.orderId } });
    expect(await orderPayment(l.orderId)).toMatchObject({ refund_status: 'refunded' });
    expect((await api('get', '/refunds', t)).body.total).toBe(0);
    const done = await api('get', '/refunds?status=refunded', t);
    expect(done.body.items).toEqual([
      expect.objectContaining({ refundStatus: 'refunded', cancelledAt: null, voucher: { id: res.body.id, number: res.body.number } }),
    ]);
  });

  it('hai yêu cầu hoàn song song → một 201, một 409 already_processed; đơn chưa chờ hoàn → 409 payment_state_changed kèm current', async () => {
    const l = await refundPendingOrder();
    const t = l.ceo.token;
    const body = { orderId: l.orderId, paidOn: '2026-10-19', note: '' };
    const [a, b] = await Promise.all([api('post', '/refunds', t, body), api('post', '/refunds', t, body)]);
    expect([a.status, b.status].toSorted()).toEqual([201, 409]);
    expect([a.body.type, b.body.type].join()).toContain('already_processed');
    expect((await testPool().query("select count(*) from finance.payment_vouchers where order_id = $1 and status = 'posted'", [l.orderId])).rows[0].count).toBe('1');

    const paid = await paidOrder();
    const res = await api('post', '/refunds', paid.ceo.token, { orderId: paid.orderId, paidOn: '2026-10-19', note: '' });
    expect(res.status).toBe(409);
    expect(res.body.type).toContain('payment_state_changed');
    expect(res.body.current).toMatchObject({ orderId: paid.orderId, status: 'paid', refundStatus: 'none', activeLink: null });
  });

  it('403 Sale (thiếu finance.voucher.create, finance.invoice.view); 404 đơn công ty khác (AC-38)', async () => {
    const l = await refundPendingOrder();
    const other = await refundPendingOrder();
    const sale = await addMember(l.companyId, 'sale');
    expect((await api('post', '/refunds', sale.token, { orderId: l.orderId, paidOn: '2026-10-19', note: '' })).status).toBe(403);
    expect((await api('get', '/refunds', sale.token)).status).toBe(403);
    expect((await api('post', '/refunds', l.ceo.token, { orderId: other.orderId, paidOn: '2026-10-19', note: '' })).status).toBe(404);
    expect((await api('post', '/payment-vouchers', sale.token, {})).status).toBe(403);
  });
});
