import { describe, expect, it } from 'vitest';
import { requireCompanyId } from '#src/shared/db/client.ts';

// Trong withCompany thì trả mã công ty: phủ bởi test integration của các hàm ranh giới (vd getVariants, nextDocNumber).
describe('requireCompanyId', () => {
  it('ngoài withCompany: ném lỗi lập trình nêu tên hàm gọi', () => {
    expect(() => requireCompanyId('getDailyPaymentFees')).toThrow('getDailyPaymentFees phải gọi trong withCompany');
  });
});
