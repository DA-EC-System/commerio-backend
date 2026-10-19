import { describe, expect, it } from 'vitest';
import { getDailyFinanceTotals } from '#src/modules/finance/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của finance cho báo cáo (#29) (AC-10, plan chuẩn bị 4.5). Các hàm #27 đã có thân, test ở test/integration/finance.
describe('khung finance', () => {
  it('getDailyFinanceTotals báo 501 not_implemented', async () => {
    await expect(getDailyFinanceTotals({ from: '2026-10-01', to: '2026-10-18' })).rejects.toMatchObject(notImplemented);
  });
});
