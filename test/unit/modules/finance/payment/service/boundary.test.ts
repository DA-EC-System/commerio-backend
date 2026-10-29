import { describe, expect, it } from 'vitest';
import { revertPaid, revertRefunded } from '#src/modules/finance/payment/index.ts';

const notImplemented = { status: 501, code: 'not_implemented' };

// Khung còn lại của payment: đảo chứng từ (UC-PF-09, chưa có issue). Các hàm khác đã có thân (#23, #27, #29).
describe('khung payment', () => {
  it('hàm đảo trạng thái tiền báo 501 not_implemented', async () => {
    await expect(revertPaid('o1')).rejects.toMatchObject(notImplemented);
    await expect(revertRefunded('o1')).rejects.toMatchObject(notImplemented);
  });
});
