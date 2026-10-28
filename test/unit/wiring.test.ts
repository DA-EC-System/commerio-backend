import { describe, expect, it } from 'vitest';
import { getShops } from '#src/modules/channel/index.ts';
import { getTransactionRefs, handleVerifiedPayment, paymentContext } from '#src/modules/finance/index.ts';
import { createModuleContext } from '#src/wiring.ts';

// src/wiring.ts nối hàm giữa module lớn (#30 A7); index.ts của module lớn nối module con bên trong (A11, A12, #27 A21).
describe('createModuleContext', () => {
  it('tiêm shopsOf là getShops của channel', () => {
    expect(createModuleContext().shopsOf).toBe(getShops);
  });
});

describe('nối trong module lớn', () => {
  it('paymentContext tiêm hàm của finance và giữ các trường sẵn có', () => {
    const ctx = paymentContext(createModuleContext());
    expect(ctx.onVerifiedPayment).toBe(handleVerifiedPayment);
    expect(ctx.financeRefsOf).toBe(getTransactionRefs);
    expect(ctx.shopsOf).toBe(getShops);
  });
});
