import { beforeAll, describe, expect, it } from 'vitest';
import { purchaseDocumentNumbers } from '#src/modules/product/purchasing/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { createSupplier, postedReceipt } from './helpers.ts';

// Số phiếu nhận, phiếu trả NCC cho thẻ kho của inventory (#206 phần 2a, AC 8).
interface Team {
  companyId: string;
  ceo: string;
  requester: string;
  kho: string;
  supplierId: string;
}

async function team(): Promise<Team> {
  const c = await createCompany();
  const t = {
    companyId: c.companyId,
    ceo: c.ceo.token,
    requester: (await addMember(c.companyId, 'warehouse')).token,
    kho: (await addMember(c.companyId, 'warehouse')).token,
  };
  return { ...t, supplierId: (await createSupplier(t.ceo)).id };
}

let A: Team;
let B: Team;

beforeAll(async () => {
  A = await team();
  B = await team();
});

describe('purchaseDocumentNumbers', () => {
  it('AC8: trả số NH- và TN- của công ty; id công ty khác, id không phải uuid thì không có trong Map', async () => {
    const a = await postedReceipt(A, A.supplierId, (await createVariant(A.companyId)).variantId, { accepted: 3, defectKept: 1 });
    const b = await postedReceipt(B, B.supplierId, (await createVariant(B.companyId)).variantId, { accepted: 2 });
    expect(a).toMatchObject({ number: 'NH-000001', returnId: expect.any(String) });

    const map = await withCompany(A.companyId, () => purchaseDocumentNumbers([a.receiptId, a.returnId!, b.receiptId, 'abc']));

    expect(Object.fromEntries(map)).toEqual({ [a.receiptId]: 'NH-000001', [a.returnId!]: 'TN-000001' });
  });

  it('không có id thì Map rỗng', async () => {
    expect(await withCompany(A.companyId, () => purchaseDocumentNumbers([]))).toEqual(new Map());
  });
});
