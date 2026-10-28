import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { handleVerifiedPayment } from '#src/modules/finance/finance/index.ts';
import { initOrderPayment } from '#src/modules/finance/payment/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { order } from '../payment/helpers.ts';
import { api, linkedOrder, orderPayment, verified } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Khoản thu chưa khớp (UC-PF-07, T22; Documents/21 §12.5 ba dòng unmatched-receipts, §12.8 UnmatchedReceipt; R1;
// plan #27 AC-34…AC-37, AC-38). Khoản dựng bằng đường thật: handler webhook với tiền lệch hoặc không mã.

/** Công ty có một khoản lệch tiền (149.000 cho đơn 150.000) và một khoản không mã 90.000. */
async function withUnmatched() {
  const l = await linkedOrder();
  await withCompany(l.companyId, () => handleVerifiedPayment(verified(l, { amount: new Decimal(149000) })));
  await withCompany(l.companyId, () =>
    handleVerifiedPayment(
      verified(l, { paymentCode: null, paymentLinkId: null, orderId: null, amount: new Decimal(90000), rawPayload: { content: 'CK khong ma' } }),
    ),
  );
  const list = await api('get', '/unmatched-receipts', l.ceo.token);
  const byAmount = (a: number) => list.body.items.find((u: { amount: number }) => u.amount === a);
  return { ...l, list, mismatch: byAmount(149000), noCode: byAmount(90000) };
}

/** Đơn trả trước đã xác nhận, chưa thu, tổng = `unitPrice`. */
async function unpaidOrder(s: { companyId: string; variantId: string }, unitPrice: number) {
  const o = await order(s, unitPrice);
  await withCompany(s.companyId, () => initOrderPayment(o.orderId, 'prepaid'));
  return o;
}

describe('GET /finance/unmatched-receipts (AC-34)', () => {
  it('mặc định open: số tiền, nội dung, cổng, lý do, đơn gợi ý theo mã thanh toán; lọc reason, search nội dung', async () => {
    const l = await withUnmatched();
    expect(l.list.status).toBe(200);
    expect(l.list.body.total).toBe(2);
    expect(l.mismatch).toEqual({
      id: expect.any(String),
      receivedAt: expect.any(String),
      amount: 149000,
      transferContent: expect.stringContaining('CM'),
      gateway: 'vietqr',
      reason: 'amount_mismatch',
      status: 'open',
      suggestedOrder: { id: l.orderId, code: l.code, customerName: null },
      assignedOrder: null,
      receipt: null,
      voucher: null,
      version: 1,
    });
    expect(l.noCode).toMatchObject({ reason: 'no_payment_code', suggestedOrder: null, transferContent: 'CK khong ma' });
    expect((await api('get', '/unmatched-receipts?reason=no_payment_code', l.ceo.token)).body.total).toBe(1);
    expect((await api('get', '/unmatched-receipts?search=khong ma', l.ceo.token)).body.total).toBe(1);
    expect((await api('get', '/unmatched-receipts?status=assigned', l.ceo.token)).body.total).toBe(0);
  });
});

describe('POST /finance/unmatched-receipts/:id/assign (AC-35)', () => {
  it('gán vào đơn chưa thu đủ tiền → 200 { unmatchedReceipt, receipt }; khoản assigned, phiếu thu unmatched_assignment, đơn paid, sự kiện', async () => {
    const l = await withUnmatched();
    const target = await unpaidOrder(l, 90000);
    const res = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, l.ceo.token, { orderId: target.orderId, version: 1 });
    expect(res.status).toBe(200);
    expect(res.body.unmatchedReceipt).toMatchObject({
      status: 'assigned',
      assignedOrder: { id: target.orderId },
      receipt: { number: expect.stringMatching(/^PT-/) },
      version: 2,
    });
    expect(res.body.receipt).toMatchObject({ source: 'unmatched_assignment', amount: 90000, unmatchedReceiptId: l.noCode.id, order: { id: target.orderId } });
    expect(await orderPayment(target.orderId)).toMatchObject({ status: 'paid' });
    const events = (
      await testPool().query("select type from core.outbox_messages where company_id = $1 and payload->>'orderId' = $2", [l.companyId, target.orderId])
    ).rows.map((r) => r.type);
    expect(events.toSorted()).toEqual(['finance.receipt_posted', 'payment.succeeded']);
  });

  it('409: khoản đã xử lý (kèm current), version cũ (kèm current), đơn đã thu / đơn huỷ (payment_state_changed); 422 khác số tiền', async () => {
    const l = await withUnmatched();
    const t = l.ceo.token;
    const wrongAmount = await unpaidOrder(l, 100000);
    const amount = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, t, { orderId: wrongAmount.orderId, version: 1 });
    expect(amount.status).toBe(422);
    expect(amount.body.type).toContain('amount_mismatch');
    expect(amount.body.errors).toHaveProperty('orderId');

    const stale = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, t, { orderId: wrongAmount.orderId, version: 5 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toContain('version_conflict');
    expect(stale.body.current).toMatchObject({ id: l.noCode.id, version: 1 });

    const cancelled = await unpaidOrder(l, 90000);
    await testPool().query("update \"order\".orders set status = 'cancelled' where id = $1", [cancelled.orderId]); // của #25
    const c = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, t, { orderId: cancelled.orderId, version: 1 });
    expect(c.status).toBe(409);
    expect(c.body.type).toContain('payment_state_changed');
    expect(c.body.current).toMatchObject({ orderId: cancelled.orderId, status: 'unpaid' });

    const ok = await unpaidOrder(l, 90000);
    expect((await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, t, { orderId: ok.orderId, version: 1 })).status).toBe(200);
    const again = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, t, { orderId: ok.orderId, version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.type).toContain('already_processed');
    expect(again.body.current).toMatchObject({ status: 'assigned' });
    const paidAlready = await api('post', `/unmatched-receipts/${l.mismatch.id}/assign`, t, { orderId: ok.orderId, version: 1 });
    expect(paidAlready.status).toBe(409);
    expect(paidAlready.body.type).toContain('payment_state_changed');
  });

  it('hai người gán cùng khoản song song → một 200, một 409; một phiếu thu', async () => {
    const l = await withUnmatched();
    const a = await unpaidOrder(l, 90000);
    const b = await unpaidOrder(l, 90000);
    const [r1, r2] = await Promise.all([
      api('post', `/unmatched-receipts/${l.noCode.id}/assign`, l.ceo.token, { orderId: a.orderId, version: 1 }),
      api('post', `/unmatched-receipts/${l.noCode.id}/assign`, l.ceo.token, { orderId: b.orderId, version: 1 }),
    ]);
    expect([r1.status, r2.status].toSorted()).toEqual([200, 409]);
    const n = await testPool().query('select count(*) from finance.receipts where unmatched_receipt_id = $1', [l.noCode.id]);
    expect(n.rows[0].count).toBe('1');
  });
});

describe('gán hai khoản khác nhau vào cùng một đơn song song (review diff PR4)', () => {
  it('một 200, một 409 payment_state_changed kèm current: OrderPayment (có activeLink, links); một phiếu thu cho đơn', async () => {
    const l = await withUnmatched();
    const second = await withCompany(l.companyId, () =>
      handleVerifiedPayment(
        verified(l, { paymentCode: null, paymentLinkId: null, orderId: null, amount: new Decimal(90000), rawPayload: { content: 'CK thu hai' } }),
      ),
    );
    expect(second).toEqual({ outcome: 'unmatched' });
    const open = (await api('get', '/unmatched-receipts?reason=no_payment_code', l.ceo.token)).body.items as { id: string }[];
    expect(open).toHaveLength(2);
    const target = await unpaidOrder(l, 90000);
    const results = await Promise.all(
      open.map((u) => api('post', `/unmatched-receipts/${u.id}/assign`, l.ceo.token, { orderId: target.orderId, version: 1 })),
    );
    expect(results.map((r) => r.status).toSorted()).toEqual([200, 409]);
    const lost = results.find((r) => r.status === 409)!;
    expect(lost.body.type).toContain('payment_state_changed');
    expect(lost.body.current).toMatchObject({ orderId: target.orderId, status: 'paid', amount: 90000, activeLink: null, links: [] });
    const n = await testPool().query('select count(*) from finance.receipts where order_id = $1', [target.orderId]);
    expect(n.rows[0].count).toBe('1');
  });
});

describe('POST /finance/unmatched-receipts/:id/refund (AC-36)', () => {
  it('hoàn khoản → 201 phiếu chi unmatched_refund posted = số tiền khoản; khoản refunded; lần hai 409 already_processed; version cũ 409', async () => {
    const l = await withUnmatched();
    const t = l.ceo.token;
    expect((await api('post', `/unmatched-receipts/${l.mismatch.id}/refund`, t, { paidOn: '2026-10-19', note: 'Trả lại', version: 3 })).body.type).toContain(
      'version_conflict',
    );
    const res = await api('post', `/unmatched-receipts/${l.mismatch.id}/refund`, t, { paidOn: '2026-10-19', note: 'Trả lại', version: 1 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      purpose: 'unmatched_refund',
      status: 'posted',
      amount: 149000,
      unmatchedReceipt: { id: l.mismatch.id, amount: 149000 },
    });
    const after = await api('get', '/unmatched-receipts?status=refunded', t);
    expect(after.body.items).toEqual([expect.objectContaining({ id: l.mismatch.id, voucher: { id: res.body.id, number: res.body.number } })]);
    const again = await api('post', `/unmatched-receipts/${l.mismatch.id}/refund`, t, { paidOn: '2026-10-19', note: '', version: 2 });
    expect(again.status).toBe(409);
    expect(again.body.type).toContain('already_processed');
  });
});

describe('GET /payment/orders?status=unpaid (AC-37, R1)', () => {
  it('đơn chưa thu của công ty để chọn khi gán: mã đơn, số tiền; tìm theo mã đơn; quyền finance.voucher.create', async () => {
    const l = await withUnmatched();
    const target = await unpaidOrder(l, 90000);
    const get = (token: string | undefined, q: string) => {
      const req = request(testApp()).get(`/api/v1/payment/orders${q}`);
      return token ? req.set('Authorization', `Bearer ${token}`) : req;
    };
    const res = await get(l.ceo.token, `?status=unpaid&search=${target.code}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, items: [{ order: { id: target.orderId, code: target.code, customerName: null }, amount: 90000 }] });
    expect((await get(l.ceo.token, '?status=unpaid')).body.total).toBeGreaterThanOrEqual(2);
    expect((await get(l.sale.token, '?status=unpaid')).status).toBe(403);
    expect((await get(undefined, '?status=unpaid')).status).toBe(401);
  });
});

describe('quyền và công ty (AC-38)', () => {
  it('403 Sale ở danh sách và gán; 404 khoản của công ty khác, id lạ; 404 đơn công ty khác khi gán; 422 thiếu version', async () => {
    const l = await withUnmatched();
    const other = await withUnmatched();
    const sale = await addMember(l.companyId, 'sale');
    expect((await api('get', '/unmatched-receipts', sale.token)).status).toBe(403);
    expect((await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, sale.token, {})).status).toBe(403);
    expect((await api('post', `/unmatched-receipts/${other.noCode.id}/assign`, l.ceo.token, { orderId: l.orderId, version: 1 })).status).toBe(404);
    expect((await api('post', `/unmatched-receipts/${randomUUID()}/refund`, l.ceo.token, { paidOn: '2026-10-19', note: '', version: 1 })).status).toBe(
      404,
    );
    const theirOrder = await unpaidOrder(other, 90000);
    expect((await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, l.ceo.token, { orderId: theirOrder.orderId, version: 1 })).status).toBe(404);
    const noVersion = await api('post', `/unmatched-receipts/${l.noCode.id}/assign`, l.ceo.token, { orderId: l.orderId });
    expect(noVersion.status).toBe(422);
    expect(noVersion.body.errors).toHaveProperty('version');
  });
});
