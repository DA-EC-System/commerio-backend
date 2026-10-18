import { describe, expect, it } from 'vitest';
import { handleVerifiedPayment } from '#src/modules/finance/index.ts';
import { getStandardPrices } from '#src/modules/pricing/index.ts';
import { createModuleContext } from '#src/wiring.ts';

// src/wiring.ts nối hàm của module lớp trên vào module lớp dưới (plan chuẩn bị A11, A12, R4).
describe('createModuleContext', () => {
  it('tiêm standardPrices là getStandardPrices của pricing', () => {
    expect(createModuleContext().standardPrices).toBe(getStandardPrices);
  });

  it('tiêm onVerifiedPayment là handleVerifiedPayment của finance', () => {
    expect(createModuleContext().onVerifiedPayment).toBe(handleVerifiedPayment);
  });
});
