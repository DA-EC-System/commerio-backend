import { describe, expect, it } from 'vitest';
import { getOrderCogs } from '#src/modules/inventory/index.ts';

// Hàm nguồn cho báo cáo #29 (AC-10, plan chuẩn bị 4.5): thân chưa làm thì báo 501.
describe('khung getOrderCogs', () => {
  it('báo 501 not_implemented', async () => {
    await expect(getOrderCogs(['o1'])).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });
});
