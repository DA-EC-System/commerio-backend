import { describe, expect, it } from 'vitest';
import { nextDocNumber } from '#src/modules/finance/finance/service/doc-numbers.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';

// Số chứng từ T2: HD-/PT-/PC- + 6 chữ số, riêng mỗi công ty, không lỗ hổng khi rollback (plan #27 AC-6, A9).
describe('nextDocNumber (AC-6)', () => {
  it('bắt đầu từ 000001, tăng 1, mỗi loại một dãy, mỗi công ty một dãy', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const numbersOfA = await withCompany(a.companyId, async () => [
      await nextDocNumber('invoice'),
      await nextDocNumber('invoice'),
      await nextDocNumber('receipt'),
      await nextDocNumber('payment_voucher'),
    ]);
    expect(numbersOfA).toEqual(['HD-000001', 'HD-000002', 'PT-000001', 'PC-000001']);
    expect(await withCompany(b.companyId, () => nextDocNumber('invoice'))).toBe('HD-000001');
  });

  it('giao dịch rollback thì số được dùng lại', async () => {
    const { companyId } = await createCompany();
    await expect(
      withCompany(companyId, async () => {
        await nextDocNumber('receipt');
        throw new Error('bên gọi lỗi');
      }),
    ).rejects.toThrow('bên gọi lỗi');
    expect(await withCompany(companyId, () => nextDocNumber('receipt'))).toBe('PT-000001');
  });

  it('10 giao dịch song song nhận 10 số khác nhau liền nhau', async () => {
    const { companyId } = await createCompany();
    const numbers = await Promise.all(
      Array.from({ length: 10 }, () => withCompany(companyId, () => nextDocNumber('invoice'))),
    );
    expect(numbers.toSorted()).toEqual(Array.from({ length: 10 }, (_, i) => `HD-${String(i + 1).padStart(6, '0')}`));
  });

  it('gọi ngoài withCompany là lỗi lập trình', async () => {
    await expect(nextDocNumber('invoice')).rejects.toThrow(/withCompany/);
  });
});
