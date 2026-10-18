import { describe, expect, it } from 'vitest';
import { getStandardPrices } from '#src/modules/pricing/index.ts';
import { createModuleContext } from '#src/wiring.ts';

// src/wiring.ts nối giá chuẩn của pricing vào catalog (plan chuẩn bị A12, R4).
describe('createModuleContext', () => {
  it('tiêm standardPrices là getStandardPrices của pricing', () => {
    expect(createModuleContext().standardPrices).toBe(getStandardPrices);
  });
});
