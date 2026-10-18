import { describe, expect, it } from 'vitest';
import { createStandardPricelist, getStandardPrices } from '#src/modules/pricing/index.ts';

// Khung của #14 (AC-10, plan chuẩn bị R3): chữ ký đã chốt, thân chưa làm thì báo 501.
describe('khung pricing', () => {
  it('getStandardPrices báo 501 not_implemented', async () => {
    await expect(getStandardPrices(['v1'])).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });

  it('createStandardPricelist báo 501 not_implemented', async () => {
    await expect(createStandardPricelist('c1')).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });
});
