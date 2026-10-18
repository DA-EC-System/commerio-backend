import { describe, expect, it } from 'vitest';
import { issueForOrder, receiveReturn, release, reserve } from '#src/modules/inventory/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung của #16 cho sales, fulfillment gọi (AC-10, plan chuẩn bị 4.5): thân chưa làm thì báo 501.
describe('khung inventory', () => {
  it('reserve, release, issueForOrder, receiveReturn báo 501 not_implemented', async () => {
    const lines = [{ variantId: 'v1', quantity: 1 }];
    await expect(reserve('o1', lines)).rejects.toMatchObject(notImplemented);
    await expect(release('o1')).rejects.toMatchObject(notImplemented);
    await expect(issueForOrder('o1')).rejects.toMatchObject(notImplemented);
    await expect(receiveReturn('o1', lines)).rejects.toMatchObject(notImplemented);
  });
});
