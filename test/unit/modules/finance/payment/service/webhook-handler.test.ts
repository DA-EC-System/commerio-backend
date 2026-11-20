import { describe, expect, it } from 'vitest';
import { type PaymentContext, type VerifiedPaymentHandler, verifiedPaymentHandlerOf } from '#src/modules/finance/payment/index.ts';

const authorize = (() => () => undefined) as unknown as PaymentContext['authorize'];
const member = (() => undefined) as unknown as PaymentContext['member'];

// Webhook của payment giao cho finance qua ctx (plan chuẩn bị A11, K4).
describe('verifiedPaymentHandlerOf', () => {
  it('ctx chưa tiêm handler thì báo 500 rõ ràng, không nuốt webhook', () => {
    expect(() => verifiedPaymentHandlerOf({ authorize, member })).toThrow(
      expect.objectContaining({ status: 500, message: expect.stringContaining('src/modules/finance/index.ts') }),
    );
  });

  it('ctx có handler thì trả đúng handler đó', () => {
    const onVerifiedPayment: VerifiedPaymentHandler = async () => ({ outcome: 'recorded' });
    expect(verifiedPaymentHandlerOf({ authorize, member, onVerifiedPayment })).toBe(onVerifiedPayment);
  });
});
