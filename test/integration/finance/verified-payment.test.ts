import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { handleVerifiedPayment } from '#src/modules/finance/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../helpers/db.ts';
import { linkedOrder, linkStatus, moneyRows, orderPayment, verified } from './helpers.ts';

vi.hoisted(() => {
  process.env.PAYMENT_CREDENTIALS_KEY = Buffer.alloc(32, 9).toString('base64');
});

// Điều phối kết quả cổng đã kiểm chữ ký (Documents/21 §12.4 bước 4, T15, T16; plan #27 A4, AC-7, AC-13…AC-17).
const handle = (p: ReturnType<typeof verified>) => withCompany(p.companyId, () => handleVerifiedPayment(p));

describe('handleVerifiedPayment', () => {
  it('đủ tiền: giao dịch succeeded, phiếu thu PT-000001, đơn paid, mã paid, hai sự kiện, một giao dịch (AC-7)', async () => {
    const l = await linkedOrder();
    const p = verified(l);
    expect(await handle(p)).toEqual({ outcome: 'recorded' });

    const r = await moneyRows(l.companyId);
    expect(r.txns).toEqual([
      expect.objectContaining({ gateway: 'vietqr', gateway_txn_id: p.gatewayTxnId, status: 'succeeded', source: 'sepay', amount: '150000.00' }),
    ]);
    expect(r.events).toEqual([{ gateway: 'vietqr', event_key: p.eventKey }]);
    expect(r.receipts).toEqual([
      expect.objectContaining({ number: 'PT-000001', source: 'gateway', amount: '150000.00', order_id: l.orderId, status: 'posted' }),
    ]);
    expect(r.unmatched).toEqual([]);
    expect(r.outbox.map((e) => e.type)).toEqual(['payment.succeeded', 'finance.receipt_posted']);
    expect(r.outbox[0]!.payload).toMatchObject({ orderId: l.orderId, gateway: 'vietqr', amount: '150000.00' });
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'paid', refund_status: 'none', paid_at: expect.any(Date) });
    expect(await linkStatus(l.link.id)).toBe('paid');
  });

  it('gửi lại cùng giao dịch, tuần tự và song song: một giao dịch, một phiếu thu, các lần sau duplicate (AC-13)', async () => {
    const l = await linkedOrder();
    const p = verified(l);
    const outcomes = await Promise.all([handle(p), handle(p), handle(p)]);
    expect(outcomes.map((o) => o.outcome).toSorted()).toEqual(['duplicate', 'duplicate', 'recorded']);
    expect(await handle(p)).toEqual({ outcome: 'duplicate' });
    const r = await moneyRows(l.companyId);
    expect([r.txns.length, r.receipts.length, r.events.length, r.outbox.length]).toEqual([1, 1, 1, 2]);
  });

  it('lệch tiền: needs_review, khoản thu chưa khớp amount_mismatch, không phiếu thu, đơn unpaid, mã giữ active (AC-14)', async () => {
    const l = await linkedOrder();
    expect(await handle(verified(l, { amount: new Decimal(149000) }))).toEqual({ outcome: 'unmatched' });
    const r = await moneyRows(l.companyId);
    expect(r.txns[0]).toMatchObject({ status: 'needs_review' });
    expect(r.unmatched).toEqual([
      expect.objectContaining({ reason: 'amount_mismatch', status: 'open', amount: '149000.00', transfer_content: expect.stringContaining('CM') }),
    ]);
    expect(r.receipts).toEqual([]);
    expect(r.outbox).toEqual([]);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'unpaid' });
    expect(await linkStatus(l.link.id)).toBe('active');
  });

  it('không có mã (SePay): khoản thu chưa khớp no_payment_code của công ty, giao dịch không đơn (AC-15)', async () => {
    const l = await linkedOrder();
    const p = verified(l, { paymentCode: null, paymentLinkId: null, orderId: null, rawPayload: { content: 'chuyen tien' } });
    expect(await handle(p)).toEqual({ outcome: 'unmatched' });
    const r = await moneyRows(l.companyId);
    expect(r.txns[0]).toMatchObject({ status: 'needs_review', order_id: null, payment_link_id: null });
    expect(r.unmatched).toEqual([expect.objectContaining({ reason: 'no_payment_code', transfer_content: 'chuyen tien' })]);
  });

  it('đơn đã huỷ → order_cancelled; đơn đã paid bằng giao dịch khác → amount_mismatch (AC-16, T15)', async () => {
    const cancelled = await linkedOrder();
    await testPool().query("update sales.orders set status = 'cancelled' where id = $1", [cancelled.orderId]); // dựng tay: #25
    expect(await handle(verified(cancelled))).toEqual({ outcome: 'unmatched' });
    expect((await moneyRows(cancelled.companyId)).unmatched[0]).toMatchObject({ reason: 'order_cancelled' });
    expect(await orderPayment(cancelled.orderId)).toMatchObject({ status: 'unpaid' });

    const paidTwice = await linkedOrder();
    await handle(verified(paidTwice));
    expect(await handle(verified(paidTwice))).toEqual({ outcome: 'unmatched' });
    const r = await moneyRows(paidTwice.companyId);
    expect(r.receipts).toHaveLength(1);
    expect(r.unmatched[0]).toMatchObject({ reason: 'amount_mismatch' });
  });

  it('mã đã expired, đơn còn unpaid, đủ tiền → nhận như thường, mã expired → paid (AC-16, T15)', async () => {
    const l = await linkedOrder();
    await testPool().query("update payment.payment_links set status = 'expired' where id = $1", [l.link.id]); // dựng tay: tra cứu quá hạn
    expect(await handle(verified(l))).toEqual({ outcome: 'recorded' });
    expect(await linkStatus(l.link.id)).toBe('paid');
  });

  it('cổng báo thất bại: giao dịch failed, không phiếu thu, đơn và mã không đổi; gửi lại → duplicate (AC-17)', async () => {
    const l = await linkedOrder();
    const p = verified(l, { succeeded: false });
    expect(await handle(p)).toEqual({ outcome: 'failed' });
    expect(await handle(p)).toEqual({ outcome: 'duplicate' });
    const r = await moneyRows(l.companyId);
    expect(r.txns).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect([r.receipts.length, r.unmatched.length, r.outbox.length]).toEqual([0, 0, 0]);
    expect(await orderPayment(l.orderId)).toMatchObject({ status: 'unpaid' });
    expect(await linkStatus(l.link.id)).toBe('active');
  });

  it('lỗi giữa chừng thì rollback hết: không giao dịch, không phiếu thu, đơn unpaid; gửi lại xử lý được', async () => {
    const l = await linkedOrder();
    const p = verified(l);
    await expect(
      withCompany(l.companyId, async () => {
        await handleVerifiedPayment(p);
        throw new Error('outbox lỗi');
      }),
    ).rejects.toThrow('outbox lỗi');
    expect((await moneyRows(l.companyId)).txns).toEqual([]);
    expect(await handle(p)).toEqual({ outcome: 'recorded' });
  });

  it('mã giao dịch cổng trùng với giao dịch của công ty khác → lỗi (cổng gửi lại), không báo duplicate, không ghi gì (review diff PR2)', async () => {
    const a = await linkedOrder();
    const b = await linkedOrder();
    const key = `SHARED${Date.now()}`;
    expect(await handle(verified(b, { eventKey: key, gatewayTxnId: key }))).toEqual({ outcome: 'recorded' });
    await expect(handle(verified(a, { eventKey: key, gatewayTxnId: key }))).rejects.toThrow(/công ty khác/);
    expect((await moneyRows(a.companyId)).txns).toEqual([]);
    expect(await orderPayment(a.orderId)).toMatchObject({ status: 'unpaid' });
  });

  it('ghi dưới role commerio_app (RLS), không phải role chủ bảng', async () => {
    const l = await linkedOrder();
    const role = await withCompany(l.companyId, async (tx) => {
      await handleVerifiedPayment(verified(l));
      return (await tx.execute<{ r: string }>("select current_user as r")).rows[0]!.r;
    });
    expect(role).toBe('commerio_app');
  });
});
