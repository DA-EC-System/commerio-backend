import { beforeAll, describe, expect, it } from 'vitest';
import { SupplierReportList } from '#src/modules/product/purchasing/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { BUYER_ROLE, type Count, countBody, createReceipt, createSupplier, orderedRequest, pur } from './helpers.ts';

// Báo cáo theo NCC GET /suppliers/report (spec #109 mục 6.7, AC10). Công ty riêng để danh sách NCC cố định.
let A: { companyId: string; ceo: string; buyer: string; kho: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    buyer: (await addMember(a.companyId, BUYER_ROLE)).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
  };
});

/** Đề nghị một dòng của NCC, một phiếu đã đếm rồi ghi sổ; trả id phiếu. */
async function postedReceipt(supplierId: string, quantity: number, count: Partial<Count>, action: 'post' | 'post_short') {
  const variantId = (await createVariant(A.companyId)).variantId;
  const req = await orderedRequest(A, supplierId, [{ variantId, quantity, unitCost: 1000 }]);
  const r = await createReceipt(A.kho, req.id);
  const counted = await pur(A.kho).put(`/goods-receipts/${r.id}`, countBody(r, [count]));
  const posted = await pur(A.kho).post(`/goods-receipts/${r.id}/${action}`, { version: counted.body.version });
  expect(posted.status, JSON.stringify(posted.body)).toBe(200);
  return { requestId: req.id, receiptId: r.id };
}

const report = async (query = '') => {
  const res = await pur(A.kho).get(`/suppliers/report${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return SupplierReportList.parse(res.body);
};

describe('báo cáo theo NCC', () => {
  it('AC10: số phiếu đã ghi sổ, số lần giao thiếu, số giao, số lỗi, tỉ lệ lỗi; NCC chưa có phiếu (kể cả ngừng giao dịch) ra 0 và null', async () => {
    const main = await createSupplier(A.ceo, { name: 'A NCC chính' });
    const idle = await createSupplier(A.ceo, { name: 'B NCC chưa giao' });
    await pur(A.ceo).put(`/suppliers/${idle.id}`, { name: idle.name, active: false, version: 1 });

    const first = await postedReceipt(main.id, 10, { announced: 10, accepted: 6, defectKept: 1, returnedOnSpot: 1, reason: 'Lỗi 2, thiếu 2' }, 'post_short');
    await postedReceipt(main.id, 5, { announced: 5, accepted: 5 }, 'post');
    await createReceipt(A.kho, first.requestId); // phiếu đang kiểm không tính

    const rows = await report();
    expect(rows.map((r) => r.supplierName)).toEqual(['A NCC chính', 'B NCC chưa giao']);
    expect(rows[0]).toEqual({
      supplierId: main.id,
      supplierName: 'A NCC chính',
      receiptCount: 2,
      shortReceiptCount: 1,
      deliveredQty: 13,
      defectQty: 2,
      defectRate: 2 / 13,
    });
    expect(rows[1]).toMatchObject({ supplierId: idle.id, receiptCount: 0, shortReceiptCount: 0, deliveredQty: 0, defectQty: 0, defectRate: null });
  });

  it('kỳ tính theo ngày giờ Việt Nam: ghi sổ 00:30 ngày 28/10 (17:30Z ngày 27/10) thuộc ngày 28/10', async () => {
    const s = await createSupplier(A.ceo, { name: 'C NCC theo kỳ' });
    const { receiptId } = await postedReceipt(s.id, 3, { announced: 3, accepted: 3 }, 'post');
    await testPool().query("update product.goods_receipts set posted_at = '2026-10-27T17:30:00Z' where id = $1", [receiptId]);

    const day28 = (await report('?from=2026-10-28&to=2026-10-28')).find((r) => r.supplierId === s.id);
    const day27 = (await report('?from=2026-10-27&to=2026-10-27')).find((r) => r.supplierId === s.id);
    const until27 = (await report('?to=2026-10-27')).find((r) => r.supplierId === s.id);
    expect(day28).toMatchObject({ receiptCount: 1, deliveredQty: 3 });
    expect(day27).toMatchObject({ receiptCount: 0, defectRate: null });
    expect(until27).toMatchObject({ receiptCount: 0 });
  });

  it('kỳ ngược → 422 validation_failed errors.from; ngày sai định dạng → 422', async () => {
    const res = await pur(A.kho).get('/suppliers/report?from=2026-10-28&to=2026-10-01');
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ from: 'Ngày bắt đầu sau ngày kết thúc' });
    expect((await pur(A.kho).get('/suppliers/report?from=28/10/2026')).status).toBe(422);
  });
});
