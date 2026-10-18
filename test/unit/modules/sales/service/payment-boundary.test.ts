import { describe, expect, it } from 'vitest';
import { getOrderChannels, getOrderForPayment } from '#src/modules/sales/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của sales cho payment, finance (#23) và báo cáo (#29) (AC-10, plan chuẩn bị 4.5).
describe('khung sales', () => {
  it('getOrderForPayment, getOrderChannels báo 501 not_implemented', async () => {
    await expect(getOrderForPayment('o1')).rejects.toMatchObject(notImplemented);
    await expect(getOrderChannels(['o1'])).rejects.toMatchObject(notImplemented);
  });
});
