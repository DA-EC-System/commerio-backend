import { describe, expect, it } from 'vitest';
import { addDays, dayOfSourceEvent, eachDay, vnDay } from '#src/modules/insight/report/domain/days.ts';

describe('ngày giờ VN (C6)', () => {
  it('vnDay lấy ngày theo UTC+7, không theo giờ máy', () => {
    expect(vnDay('2026-10-18T16:59:59Z')).toBe('2026-10-18');
    expect(vnDay('2026-10-18T17:00:00Z')).toBe('2026-10-19');
    expect(vnDay(new Date('2026-12-31T20:00:00+07:00'))).toBe('2026-12-31');
  });

  it('addDays qua tháng, năm, năm nhuận', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
  });
});

describe('eachDay', () => {
  it('mọi ngày từ from tới to, cả hai đầu', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    expect(eachDay('2026-10-18', '2026-10-18')).toEqual(['2026-10-18']);
  });
});

const ID = '8e172605-0612-4451-bfc4-cce4d356069b';

describe('dayOfSourceEvent (plan #29 A5)', () => {
  it('hoá đơn theo issuedAt, phiếu thu theo postedAt (giờ VN), phiếu chi theo paidOn', () => {
    expect(dayOfSourceEvent({ type: 'finance.invoice_posted', payload: { invoiceId: ID, orderId: ID, total: '1.00', issuedAt: '2026-10-18T17:30:00Z', reversalOf: null } })).toBe('2026-10-19');
    expect(dayOfSourceEvent({ type: 'finance.receipt_posted', payload: { receiptId: ID, orderId: ID, amount: '1.00', source: 'cod', postedAt: '2026-10-18T16:30:00Z', reversalOf: null } })).toBe('2026-10-18');
    expect(dayOfSourceEvent({ type: 'finance.voucher_posted', payload: { voucherId: ID, purpose: 'customer_refund', orderId: ID, amount: '1.00', paidOn: '2026-10-20', reversalOf: null } })).toBe('2026-10-20');
  });
});
