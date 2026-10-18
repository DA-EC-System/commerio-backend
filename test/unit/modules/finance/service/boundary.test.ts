import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  getDailyFinanceTotals,
  recordCodCollected,
} from '#src/modules/finance/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của finance cho fulfillment (#25), webhook (#27), báo cáo (#29) (AC-10, plan chuẩn bị 4.5, A11).
describe('khung finance', () => {
  it('recordCodCollected, getDailyFinanceTotals báo 501 not_implemented', async () => {
    await expect(recordCodCollected('o1', new Decimal(150000))).rejects.toMatchObject(notImplemented);
    await expect(getDailyFinanceTotals({ from: '2026-10-01', to: '2026-10-18' })).rejects.toMatchObject(notImplemented);
  });

});
