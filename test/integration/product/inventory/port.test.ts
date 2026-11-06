import { describe, expect, it } from 'vitest';
import { availableOf, nextDocNumber } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { companyWithVariants, receive, setBuckets } from './helpers.ts';

// Hàm cổng của inventory cho module khác (spec #111 mục 5.5, AC5, AC7, AC8). Import qua index của module lớn `product`.
describe('availableOf', () => {
  it('AC5: trả biến thể của công ty, kể cả biến thể chưa có dòng tồn; bỏ id công ty khác và id không phải uuid', async () => {
    const A = await companyWithVariants(2);
    const B = await companyWithVariants(1);
    const [a, b] = A.variants as [string, string];
    await receive(A.companyId, b, 7, 1000);
    await setBuckets(A.companyId, b, { reserved: 2 });

    const map = await withCompany(A.companyId, () => availableOf([a, b, B.variants[0]!, 'abc']));
    expect(Object.fromEntries(map)).toEqual({ [a]: 0, [b]: 5 });
  });
});

describe('nextDocNumber', () => {
  it('AC8: tăng 1, 2, 3 trong một công ty; công ty khác bắt đầu lại từ 1', async () => {
    const A = await companyWithVariants(0);
    const B = await companyWithVariants(0);
    const take = (companyId: string) => withCompany(companyId, () => nextDocNumber('purchase_request'));
    expect([await take(A.companyId), await take(A.companyId), await take(A.companyId)]).toEqual([1, 2, 3]);
    expect(await take(B.companyId)).toBe(1);
  });
});
