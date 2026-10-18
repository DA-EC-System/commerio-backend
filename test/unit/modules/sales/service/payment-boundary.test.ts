import { describe, expect, it } from 'vitest';
import { getOrderChannels } from '#src/modules/sales/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của sales cho báo cáo (#29) (AC-10, plan chuẩn bị 4.5). getOrderForPayment đã có thân (#23): test/integration/payment/order-for-payment.test.ts.
describe('khung sales', () => {
  it('getOrderChannels báo 501 not_implemented', async () => {
    await expect(getOrderChannels(['o1'])).rejects.toMatchObject(notImplemented);
  });
});
