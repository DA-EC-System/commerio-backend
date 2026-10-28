import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { revokePermission } from '../../helpers/state.ts';
import { archiveVariant, inv, receive, setBuckets } from './helpers.ts';

// API tồn và ngưỡng /inventory/stock (Documents/21 mục 15.1, 15.2; K3, V29–V33).
let A: { companyId: string; ceo: string; admin: string; kho: string; sale: string };
let B: { companyId: string; ceo: string };

beforeAll(async () => {
  const a = await createCompany();
  A = {
    companyId: a.companyId,
    ceo: a.ceo.token,
    admin: (await addMember(a.companyId, 'admin')).token,
    kho: (await addMember(a.companyId, 'warehouse')).token,
    sale: (await addMember(a.companyId, 'sale')).token,
  };
  const b = await createCompany();
  B = { companyId: b.companyId, ceo: b.ceo.token };
});

describe('danh sách tồn', () => {
  it('dòng có tồn thực, đang giữ, khả dụng, chờ xử lý; CEO thấy giá vốn, Admin và Kho nhận null', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 20, 100000);
    await setBuckets(c.companyId, v, { reserved: 6, quarantine: 3 });
    const res = await inv(c.ceo.token).get('/stock');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({
        variantId: v,
        onHand: 20,
        reserved: 6,
        locked: 0,
        available: 14,
        quarantine: 3,
        negative: false,
        avgCost: 100000,
        stockValue: 2000000,
      }),
    ]);
    const byKho = (await inv(kho).get('/stock')).body;
    expect(byKho.items[0]).toMatchObject({ avgCost: null, stockValue: null });
    expect(byKho.summary.totalValue).toBeNull();
  });

  it('giá vốn lưu 100000.40, API trả 100000, giá trị tồn 5 × 100000.40 = 500002', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await receive(c.companyId, v, 3, 100000);
    await receive(c.companyId, v, 2, 100001);
    const [item] = (await inv(c.ceo.token).get('/stock')).body.items;
    expect(item).toMatchObject({ onHand: 5, avgCost: 100000, stockValue: 500002 });
  });

  it('lọc dưới ngưỡng và có hàng chờ xử lý; summary tính trên cả công ty', async () => {
    const c = await createCompany();
    const x = await createVariant(c.companyId);
    const y = await createVariant(c.companyId);
    await receive(c.companyId, y.variantId, 2, 1000);
    await setBuckets(c.companyId, y.variantId, { quarantine: 1 });
    await inv(c.ceo.token).put(`/stock/${y.variantId}/reorder-rule`, { minQty: 5, version: 1 });
    const below = (await inv(c.ceo.token).get('/stock?belowMin=true')).body;
    expect(below.items.map((i: { variantId: string }) => i.variantId)).toEqual([y.variantId]);
    expect(below.summary).toMatchObject({ variantCount: 2, belowMinCount: 1 });
    const quarantine = (await inv(c.ceo.token).get('/stock?quarantine=true')).body;
    expect(quarantine.items.map((i: { variantId: string }) => i.variantId)).toEqual([y.variantId]);
    expect((await inv(c.ceo.token).get(`/stock?search=${x.sku}`)).body.items).toHaveLength(1);
  });

  it('biến thể lưu trữ còn hàng vẫn hiện, hết hàng thì ẩn', async () => {
    const c = await createCompany();
    const kept = await createVariant(c.companyId);
    const gone = await createVariant(c.companyId);
    await receive(c.companyId, kept.variantId, 1, 1000);
    await archiveVariant(kept.variantId);
    await archiveVariant(gone.variantId);
    const ids = (await inv(c.ceo.token).get('/stock')).body.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toEqual([kept.variantId]);
  });
});

describe('chi tiết tồn', () => {
  it('thẻ kho mới nhất trước, kèm ngăn, chứng từ gốc, người làm; Kho không thấy giá', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    const { rows } = await testPool().query<{ account_id: string }>(
      'select account_id from core.memberships where company_id = $1 limit 1',
      [c.companyId],
    );
    await receive(c.companyId, v, 3, 1000, rows[0]!.account_id);
    await receive(c.companyId, v, 2, 1000);
    const res = await inv(c.ceo.token).get(`/stock/${v}`);
    expect(res.status).toBe(200);
    expect(res.body.level).toMatchObject({ variantId: v, onHand: 5 });
    expect(res.body.moves).toHaveLength(2);
    expect(res.body.moves[0]).toMatchObject({
      area: 'on_hand',
      qtyChange: 2,
      balanceAfter: 5,
      document: { id: expect.any(String), type: 'stock_document' },
      unitCost: 1000,
      doneBy: null,
    });
    expect(res.body.moves[1]).toMatchObject({ balanceAfter: 3, doneBy: expect.any(String) });
    const byKho = await inv(kho).get(`/stock/${v}`);
    expect(byKho.body.moves[0].unitCost).toBeNull();
    expect(byKho.body.level.avgCost).toBeNull();
  });
});

describe('ngưỡng tồn', () => {
  it('đặt ngưỡng khi chưa có dòng tồn (version 0): belowMin, ghi nhật ký trước/sau', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const res = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 5, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minQty: 5, belowMin: true, reorderVersion: 2 });
    const audit = await testPool().query(
      "select action, before, after from core.audit_logs where entity_type = 'product.stock_levels.min_qty' and entity_id = $1",
      [v],
    );
    expect(audit.rows).toEqual([{ action: 'create', before: null, after: { minQty: 5 } }]);
  });

  it('minQty null bỏ ngưỡng; sai dạng → 422 errors.minQty', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const set = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const cleared = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: null, version: set.body.reorderVersion });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ minQty: null, belowMin: false });
    const bad = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: -1, version: cleared.body.reorderVersion });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty('minQty');
  });

  it('version cũ → 409 version_conflict kèm current là StockLevel', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const res = await inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 4, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ variantId: v, minQty: 3 });
  });

  it('hai người cùng đặt ngưỡng lần đầu: một 200, một 409, không 500', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const results = await Promise.all([
      inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 1, version: 0 }),
      inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 2, version: 0 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('người khác vừa đặt ngưỡng lần đầu trong lúc mình chờ khoá → 409, không ghi đè', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    // Giao dịch kia đã tạo dòng tồn và đặt ngưỡng 1 nhưng chưa commit: lúc request đọc thì chưa thấy dòng nào.
    const res = await raceBehindLock(
      (h) =>
        h.query("insert into product.stock_levels (company_id, variant_id, min_qty, version) values ($1, $2, 1, 2)", [A.companyId, v]),
      1,
      () => inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 2, version: 0 }),
    );
    expect(res.status).toBe(409);
    expect(res.body.current).toMatchObject({ minQty: 1 });
  });
});

describe('quyền và công ty khác', () => {
  it('Kho đặt ngưỡng → 403; Sale xem tồn → 403', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    expect((await inv(A.kho).put(`/stock/${v}/reorder-rule`, {})).body.type).toBe('/problems/forbidden');
    expect((await inv(A.sale).get('/stock')).body.type).toBe('/problems/forbidden');
  });

  it('biến thể của công ty khác → 404 cho chi tiết và ngưỡng; danh sách A không có dòng B', async () => {
    const { variantId: theirs } = await createVariant(B.companyId);
    expect((await inv(A.ceo).get(`/stock/${theirs}`)).status).toBe(404);
    expect((await inv(A.ceo).put(`/stock/${theirs}/reorder-rule`, { minQty: 1, version: 0 })).status).toBe(404);
    expect((await inv(A.ceo).get('/stock/khong-phai-uuid')).status).toBe(404);
    expect((await inv(B.ceo).get(`/stock/${theirs}`)).body.level.minQty).toBeNull();
    const ids = (await inv(A.ceo).get('/stock?pageSize=100')).body.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).not.toContain(theirs);
  });

  it('thu quyền giá vốn thì lần gọi sau nhận null ngay (A1)', async () => {
    const role = await createCustomRole(A.companyId, ['inventory.stock.view', 'inventory.cost.view']);
    const user = (await addMember(A.companyId, role)).token;
    expect((await inv(user).get('/stock')).body.summary.totalValue).not.toBeNull();
    await revokePermission(role, 'inventory.cost.view');
    expect((await inv(user).get('/stock')).body.summary.totalValue).toBeNull();
  });

  it('chưa có route phiếu kho cũ (/documents) trước issue phiếu kho có duyệt', async () => {
    expect((await inv(A.ceo).get('/documents')).status).toBe(404);
  });
});
