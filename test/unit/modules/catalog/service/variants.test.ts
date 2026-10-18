import { describe, expect, it } from 'vitest';
import { getVariants } from '#src/modules/catalog/index.ts';

// Khung của #12 (AC-10): chữ ký đã chốt (plan chuẩn bị 4.5), thân chưa làm thì báo 501 rõ ràng.
describe('khung getVariants của catalog', () => {
  it('báo 501 not_implemented, có hay không có danh sách id', async () => {
    await expect(getVariants()).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
    await expect(getVariants(['v1'])).rejects.toMatchObject({ status: 501, code: 'not_implemented' });
  });
});
