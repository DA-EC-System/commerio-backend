import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { reserve } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { revokePermission } from '../../helpers/state.ts';
import { alertActive, archiveVariant, eventsOf, inv, postReceipt } from './helpers.ts';

// API tồn và ngưỡng /inventory/stock (plan #16 lát 4; Documents/21 7.1, 7.2, K3, K7, V29–V33).
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

const issue = async (token: string, variantId: string, quantity: number) => {
  const doc = await inv(token).post('/documents', { type: 'issue', note: 'xuất', lines: [{ variantId, quantity }] });
  return inv(token).post(`/documents/${doc.body.id}/post`, { version: 1 });
};

describe('danh sách tồn (AC-1, AC-2, AC-13, AC-17)', () => {
  it('dòng có thực có, đang giữ, khả dụng; CEO thấy giá vốn, Admin và Kho nhận null', async () => {
    const c = await createCompany();
    const admin = (await addMember(c.companyId, 'admin')).token;
    const { variantId: v, sku } = await createVariant(c.companyId);
    await postReceipt(c.ceo.token, v, 20, 100000);
    await withCompany(c.companyId, () => reserve(randomUUID(), [{ variantId: v, quantity: 6 }]));
    const res = await inv(c.ceo.token).get('/stock');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 1, page: 1, pageSize: 20, summary: { variantCount: 1, belowMinCount: 0, totalValue: 2000000 } });
    expect(res.body.items[0]).toMatchObject({
      variantId: v,
      sku,
      onHand: 20,
      reserved: 6,
      available: 14,
      minQty: null,
      belowMin: false,
      reorderVersion: 0,
      avgCost: 100000,
      stockValue: 2000000,
      category: { id: expect.any(String), name: expect.any(String) },
    });
    const byAdmin = await inv(admin).get('/stock');
    expect(byAdmin.body.items[0]).toMatchObject({ avgCost: null, stockValue: null });
    expect(byAdmin.body.summary.totalValue).toBeNull();
  });

  it('giá vốn lưu 100000.40, API trả 100000, giá trị tồn 5 × 100000.40 = 500002 (AC-17)', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await postReceipt(c.ceo.token, v, 3, 100000);
    await postReceipt(c.ceo.token, v, 2, 100001);
    const row = (await inv(c.ceo.token).get('/stock')).body.items[0];
    expect(row).toMatchObject({ onHand: 5, avgCost: 100000, stockValue: 500002 });
    const db = await testPool().query('select avg_cost from inventory.stock_levels where company_id = $1 and variant_id = $2', [c.companyId, v]);
    expect(db.rows[0].avg_cost).toBe('100000.40');
  });

  it('lọc theo tên/SKU, danh mục, dưới ngưỡng; summary tính trên cả công ty; không khớp thì items rỗng', async () => {
    const c = await createCompany();
    const x = await createVariant(c.companyId, { sku: 'AO-XANH-01', categoryName: 'Áo' });
    const y = await createVariant(c.companyId, { sku: 'QUAN-01', categoryName: 'Quần' });
    const z = await createVariant(c.companyId, { sku: 'MU-01', categoryName: 'Mũ' });
    await postReceipt(c.ceo.token, y.variantId, 2, 1000);
    await inv(c.ceo.token).put(`/stock/${y.variantId}/reorder-rule`, { minQty: 5, version: 0 });
    const q = async (query: string) => (await inv(c.ceo.token).get(`/stock${query}`)).body;
    expect((await q('?search=ao-xanh')).items.map((i: { variantId: string }) => i.variantId)).toEqual([x.variantId]);
    expect((await q(`?categoryId=${z.categoryId}`)).items.map((i: { variantId: string }) => i.variantId)).toEqual([z.variantId]);
    const below = await q('?belowMin=true');
    expect(below).toMatchObject({ total: 1, summary: { variantCount: 3, belowMinCount: 1 } });
    expect(below.items[0].variantId).toBe(y.variantId);
    expect(await q('?search=khong-co')).toMatchObject({ items: [], total: 0, summary: { variantCount: 3 } });
  });

  it('biến thể ngừng bán còn hàng vẫn hiện, hết hàng thì ẩn (A2)', async () => {
    const c = await createCompany();
    const kept = await createVariant(c.companyId);
    const gone = await createVariant(c.companyId);
    await postReceipt(c.ceo.token, kept.variantId, 1, 1000);
    await archiveVariant(kept.variantId);
    await archiveVariant(gone.variantId);
    const ids = (await inv(c.ceo.token).get('/stock')).body.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toEqual([kept.variantId]);
  });

  it.each(['?pageSize=0', '?pageSize=101', '?belowMin=yes', '?categoryId=abc'])('query sai %s → 422', async (query) => {
    expect((await inv(A.ceo).get(`/stock${query}`)).status).toBe(422);
  });
});

describe('chi tiết tồn (AC-3, AC-13)', () => {
  it('100 dòng thẻ kho mới nhất, dấu theo chiều, kèm phiếu, người làm; CEO thấy giá, Kho không', async () => {
    const c = await createCompany();
    const kho = (await addMember(c.companyId, 'warehouse')).token;
    const { variantId: v } = await createVariant(c.companyId);
    for (let i = 0; i < 119; i++) await postReceipt(c.ceo.token, v, 1, 1000);
    await issue(c.ceo.token, v, 1);
    const res = await inv(c.ceo.token).get(`/stock/${v}`);
    expect(res.status).toBe(200);
    expect(res.body.level).toMatchObject({ variantId: v, onHand: 118 });
    expect(res.body.moves).toHaveLength(100);
    expect(res.body.moves[0]).toMatchObject({
      id: expect.any(String),
      qtyChange: -1,
      onHandAfter: 118,
      document: { number: 'PX-000001', type: 'issue', kind: 'manual', id: expect.any(String) },
      unitCost: 1000,
      doneBy: 'Nguyễn Văn Thử',
      doneAt: expect.any(String),
    });
    expect(res.body.moves[1]).toMatchObject({ qtyChange: 1, onHandAfter: 119, document: { type: 'receipt' } });
    expect(res.body.moves[99].onHandAfter).toBe(21);
    const byKho = await inv(kho).get(`/stock/${v}`);
    expect(byKho.body.moves[0].unitCost).toBeNull();
    expect(byKho.body.level.avgCost).toBeNull();
  }, 120_000);
});

describe('ngưỡng tồn (AC-10, AC-11, AC-18, AC-19)', () => {
  it('đặt ngưỡng 5 khi khả dụng 4: belowMin, reorderVersion 1, nhật ký trước/sau, phát cảnh báo ngay', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    await postReceipt(A.ceo, v, 4, 1000);
    const res = await inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 5, version: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ minQty: 5, belowMin: true, reorderVersion: 1, available: 4 });
    expect(await alertActive(A.companyId, v)).toBe(true);
    expect(await eventsOf(A.companyId, 'inventory.below_threshold')).toContainEqual({ variantId: v, available: 4, minQty: 5 });
    const logs = await testPool().query(
      `select action, before, after from audit.audit_logs where entity_type = 'inventory.reorder_rules' and entity_id = $1`,
      [v],
    );
    expect(logs.rows).toEqual([{ action: 'create', before: null, after: { minQty: 5 } }]);
  });

  it('minQty null xoá dòng ngưỡng, reorderVersion về 0; sai dạng → 422 errors.minQty', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const cleared = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: null, version: 1 });
    expect(cleared.body).toMatchObject({ minQty: null, belowMin: false, reorderVersion: 0 });
    const rows = await testPool().query('select 1 from inventory.reorder_rules where company_id = $1 and variant_id = $2', [A.companyId, v]);
    expect(rows.rowCount).toBe(0);
    for (const minQty of [-1, 2.5, 1_000_001, 'a']) {
      const res = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty, version: 0 });
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty(['minQty']);
    }
  });

  it('version cũ → 409 version_conflict kèm current là StockLevel', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 });
    const res = await inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 4, version: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ type: '/problems/version_conflict', current: { variantId: v, minQty: 3, reorderVersion: 1 } });
  });

  it('hai người cùng đặt ngưỡng lần đầu: một 200, một 409, không 500', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    const [r1, r2] = await Promise.all([
      inv(A.ceo).put(`/stock/${v}/reorder-rule`, { minQty: 3, version: 0 }),
      inv(A.admin).put(`/stock/${v}/reorder-rule`, { minQty: 4, version: 0 }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
  });
});

describe('quyền và công ty khác (AC-14, AC-15)', () => {
  it('Kho đặt ngưỡng → 403; Sale xem tồn → 403', async () => {
    const { variantId: v } = await createVariant(A.companyId);
    expect((await inv(A.kho).put(`/stock/${v}/reorder-rule`, {})).body.type).toBe('/problems/forbidden');
    expect((await inv(A.sale).get('/stock')).body.type).toBe('/problems/forbidden');
  });

  it('biến thể của công ty khác → 404 cho chi tiết và ngưỡng; ngưỡng của B không đổi; danh sách A không có dòng B', async () => {
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

  it('không có route /inventory/returns ở #16 (AC-16)', async () => {
    expect((await inv(A.ceo).get('/returns')).status).toBe(404);
    expect((await inv(A.ceo).post('/returns', {})).status).toBe(404);
  });
});

describe('ghi sổ qua API làm khả dụng xuống dưới ngưỡng (AC-12)', () => {
  it('ngưỡng 5, khả dụng 6 → xuất 2 → có below_threshold và stock_changed', async () => {
    const c = await createCompany();
    const { variantId: v } = await createVariant(c.companyId);
    await postReceipt(c.ceo.token, v, 6, 1000);
    await inv(c.ceo.token).put(`/stock/${v}/reorder-rule`, { minQty: 5, version: 0 });
    expect(await eventsOf(c.companyId, 'inventory.below_threshold')).toHaveLength(0);
    expect((await issue(c.ceo.token, v, 2)).status).toBe(200);
    expect(await eventsOf(c.companyId, 'inventory.below_threshold')).toEqual([{ variantId: v, available: 4, minQty: 5 }]);
    expect((await eventsOf(c.companyId, 'inventory.stock_changed')).at(-1)).toEqual({ variantId: v, onHand: 4, reserved: 0, available: 4 });
  });
});
