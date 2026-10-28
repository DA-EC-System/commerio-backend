import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { decidePayment } from '#src/modules/finance/finance/domain/payment-outcome.ts';

// Luật kết quả cổng → phiếu thu hay khoản thu chưa khớp (§12.4, T15, T16; plan #27 A4).
const order = (over: Partial<{ status: string; total: Decimal; paymentStatus: string }> = {}) => ({
  status: 'confirmed',
  total: new Decimal(150000),
  paymentStatus: 'unpaid',
  ...over,
});
const d = (amount: number, o: ReturnType<typeof order> | null, succeeded = true) =>
  decidePayment({ succeeded, amount: new Decimal(amount), order: o });

describe('decidePayment', () => {
  it('đủ tiền, đơn chưa thu → phiếu thu', () => expect(d(150000, order())).toEqual({ kind: 'receipt' }));
  it('cổng báo thất bại → failed, kể cả không có đơn', () => {
    expect(d(150000, order(), false)).toEqual({ kind: 'failed' });
    expect(d(150000, null, false)).toEqual({ kind: 'failed' });
  });
  it('không có đơn → no_payment_code', () => expect(d(150000, null)).toMatchObject({ reason: 'no_payment_code' }));
  it('đơn huỷ → order_cancelled, trước cả lệch tiền', () =>
    expect(d(1000, order({ status: 'cancelled' }))).toMatchObject({ reason: 'order_cancelled' }));
  it('lệch tiền, đơn đã paid, đơn COD → amount_mismatch', () => {
    expect(d(149999, order())).toMatchObject({ reason: 'amount_mismatch' });
    expect(d(150000, order({ paymentStatus: 'paid' }))).toMatchObject({ reason: 'amount_mismatch' });
    expect(d(150000, order({ paymentStatus: 'cod_pending' }))).toMatchObject({ reason: 'amount_mismatch' });
  });
  it('so tiền bằng Decimal: 150000.00 bằng 150000', () =>
    expect(decidePayment({ succeeded: true, amount: new Decimal('150000.00'), order: order() })).toEqual({ kind: 'receipt' }));
});
