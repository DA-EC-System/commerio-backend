import { beforeAll, describe, expect, it } from 'vitest';
import { type PurchaseDocumentNumbers, purchaseDocumentNumbers } from '#src/modules/product/purchasing/index.ts';
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

const plain = (n: PurchaseDocumentNumbers) => ({
  goodsReceipts: Object.fromEntries(n.goodsReceipts),
  supplierReturns: Object.fromEntries(n.supplierReturns),
});

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

    const numbers = await withCompany(A.companyId, () =>
      purchaseDocumentNumbers({ goodsReceipts: [a.receiptId, b.receiptId, 'abc'], supplierReturns: [a.returnId!, 'abc'] }),
    );

    expect(plain(numbers)).toEqual({
      goodsReceipts: { [a.receiptId]: 'NH-000001' },
      supplierReturns: { [a.returnId!]: 'TN-000001' },
    });
  });

  it('id đặt sai nhóm (phiếu trả NCC trong nhóm phiếu nhận và ngược lại) thì không có trong Map', async () => {
    const a = await postedReceipt(A, A.supplierId, (await createVariant(A.companyId)).variantId, { accepted: 1, defectKept: 1 });

    const numbers = await withCompany(A.companyId, () =>
      purchaseDocumentNumbers({ goodsReceipts: [a.returnId!], supplierReturns: [a.receiptId] }),
    );

    expect(plain(numbers)).toEqual({ goodsReceipts: {}, supplierReturns: {} });
  });

  it('không có id thì Map rỗng', async () => {
    const numbers = await withCompany(A.companyId, () => purchaseDocumentNumbers({ goodsReceipts: [], supplierReturns: [] }));
    expect(plain(numbers)).toEqual({ goodsReceipts: {}, supplierReturns: {} });
  });
});
