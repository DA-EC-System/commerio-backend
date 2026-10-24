import { describe, expect, it } from 'vitest';
import { newPaymentCode } from '#src/modules/finance/payment/domain/payment-code.ts';

// Mã thanh toán theo T3: CM + 10 ký tự, bỏ ký tự dễ nhầm 0 O 1 I L (#23 AC-19, plan A8).
describe('mã thanh toán', () => {
  it('đúng định dạng CM + 10 ký tự không dễ nhầm', () => {
    for (let i = 0; i < 200; i++) expect(newPaymentCode()).toMatch(/^CM[A-HJKMNP-Z2-9]{10}$/);
  });

  it('lần sinh khác nhau ra mã khác nhau', () => {
    expect(new Set(Array.from({ length: 500 }, newPaymentCode)).size).toBe(500);
  });
});
