import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { recordCodCollected } from '#src/modules/finance/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của finance cho fulfillment (#25), webhook (#27) (AC-10, plan chuẩn bị 4.5, A11).
describe('khung finance', () => {
  it('recordCodCollected báo 501 not_implemented', async () => {
    await expect(recordCodCollected('o1', new Decimal(150000))).rejects.toMatchObject(notImplemented);
  });
});
