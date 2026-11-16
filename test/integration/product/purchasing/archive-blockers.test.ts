import { beforeAll, describe, expect, it } from 'vitest';
import { purchaseArchiveBlockers, purchaseInUse } from '#src/modules/product/purchasing/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { act, createReceipt, createRequest, createSupplier, orderedRequest, postedReceipt } from './helpers.ts';

// Lý do chặn lưu trữ SKU phần mua hàng (#204, Documents/21 §17.3): catalog gọi trong giao dịch lưu trữ.
let companyId: string;
let t: { ceo: string; requester: string; kho: string };
let supplierId: string;
beforeAll(async () => {
  const a = await createCompany();
  companyId = a.companyId;
  // CEO lập và duyệt đề nghị (tự duyệt được), kho ghi sổ phiếu nhận (người khác người lập).
  t = { ceo: a.ceo.token, requester: a.ceo.token, kho: (await addMember(companyId, 'warehouse')).token };
  supplierId = (await createSupplier(a.ceo.token)).id;
});

const sku = async () => (await createVariant(companyId)).variantId;
const blockersOf = (ids: string[]) => withCompany(companyId, () => purchaseArchiveBlockers(ids));

describe('purchaseArchiveBlockers (#204)', () => {
  it('SKU không vướng chứng từ mua hàng thì không có trong kết quả', async () => {
    const v = await sku();
    expect(await blockersOf([v])).toEqual(new Map());
  });

  it('đề nghị nhập nháp có SKU', async () => {
    const v = await sku();
    await createRequest(t.ceo, supplierId, [{ variantId: v, quantity: 5, unitCost: 100000 }]);
    expect(await blockersOf([v])).toEqual(new Map([[v, ['Còn 1 đề nghị nhập chưa xong']]]));
  });

  it('đề nghị đã đặt NCC chưa nhận: đang về và đề nghị chưa xong', async () => {
    const v = await sku();
    await orderedRequest(t, supplierId, [{ variantId: v, quantity: 5, unitCost: 100000 }]);
    expect(await blockersOf([v])).toEqual(new Map([[v, ['Đang về 5', 'Còn 1 đề nghị nhập chưa xong']]]));
  });

  it('phiếu nhận đang kiểm có SKU', async () => {
    const v = await sku();
    const req = await orderedRequest(t, supplierId, [{ variantId: v, quantity: 5, unitCost: 100000 }]);
    await createReceipt(t.kho, req.id);
    expect((await blockersOf([v])).get(v)).toContain('Còn 1 phiếu nhận đang kiểm');
  });

  it('phiếu trả NCC nháp sinh từ hàng lỗi giữ lại', async () => {
    const v = await sku();
    const { returnId } = await postedReceipt(t, supplierId, v, { accepted: 3, defectKept: 1 });
    expect(returnId).not.toBeNull();
    expect((await blockersOf([v])).get(v)).toContain('Còn 1 phiếu trả NCC chưa có kết quả');
  });
});

// SKU đã dùng (#204 spec mục 6): dòng đề nghị nhập, phiếu nhận, phiếu trả NCC ở mọi trạng thái.
describe('purchaseInUse (#204)', () => {
  const inUse = (ids: string[]) => withCompany(companyId, () => purchaseInUse(ids));

  it('SKU mới không có; đề nghị đã huỷ vẫn tính; phiếu nhận, phiếu trả NCC tính', async () => {
    const [fresh, cancelled, received] = [await sku(), await sku(), await sku()];
    const req = await createRequest(t.ceo, supplierId, [{ variantId: cancelled, quantity: 1, unitCost: 1000 }]);
    const res = await act(t.ceo, req.id, 'cancel', { version: req.version, reason: 'Không nhập nữa' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await postedReceipt(t, supplierId, received, { accepted: 3, defectKept: 1 });
    expect(await inUse([fresh, cancelled, received])).toEqual(new Set([cancelled, received]));
    expect(await inUse([])).toEqual(new Set());
  });
});
