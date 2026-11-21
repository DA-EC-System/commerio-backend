import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { asCompany } from '../../helpers/rls.ts';
import { setModuleEnabled } from '../../helpers/state.ts';
import { api, archiveSku, auditOf, createAttribute, createGroup, createProduct, setSkuPattern, uniq, valueId } from './helpers.ts';

// Nhóm hàng, cài đặt sản phẩm, chuyển sản phẩm giữa nhóm (#447; Documents/21 5.2, 5.3, P6, V8, V24, V25).
let token: string;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
});

const NO_SUGGEST = { marginCoefficient: null, priceRounding: null, reorderLeadDays: null, reorderSafetyQty: null, reorderDefaultQty: null };
const SUGGEST = { marginCoefficient: 1.4, priceRounding: 1000, reorderLeadDays: 7, reorderSafetyQty: 2, reorderDefaultQty: 5 };

type Group = { id: string; name: string; productCount: number; version: number };
const groupsOf = async (t: string) => (await api(t).get('/groups')).body.items as Group[];
const productVersion = async (id: string) =>
  (await testPool().query<{ version: number; group_id: string }>('select version, group_id from product.products where id = $1', [id])).rows[0]!;

describe('GET/POST /catalog/groups', () => {
  it('tạo nhóm → 201 đủ trường, danh sách `{ items }` có nhóm, nhật ký create', async () => {
    const name = uniq('Áo');
    const res = await api(token).post('/groups', { name: `  ${name} ` });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name, productCount: 0, suggest: NO_SUGGEST, version: 1 });
    expect(typeof res.body.updatedAt).toBe('string');
    expect(await groupsOf(token)).toContainEqual(res.body);
    expect(await auditOf(res.body.id)).toEqual([{ action: 'create', entity_type: 'product.product_groups', before: null, after: { name } }]);
  });

  it('công ty mới thấy 27 danh mục chuẩn sắp theo tên tiếng Việt; `/catalog/categories` không còn (404) (AC-S7)', async () => {
    const { ceo } = await createCompany();
    const names = (await groupsOf(ceo.token)).map((g) => g.name);
    expect(names).toHaveLength(27); // #531: 27 danh mục chuẩn
    expect(names).toEqual([...names].sort(new Intl.Collator('vi').compare));
    expect((await api(ceo.token).get('/categories')).status).toBe(404);
  });

  it('tên trống, dài quá 60 ký tự → 422 errors.name; trùng không phân biệt hoa thường → 409 name_taken', async () => {
    for (const name of ['  ', 'x'.repeat(61)]) {
      const res = await api(token).post('/groups', { name });
      expect(res.status).toBe(422);
      expect(res.body.errors.name).toBeTruthy();
    }
    const group = await createGroup(token, uniq('Trùng'), null);
    const dup = await api(token).post('/groups', { name: group.name.toUpperCase() });
    expect(dup.status).toBe(409);
    expect(dup.body.type).toBe('/problems/name_taken');
    expect(dup.body.errors.name).toBeTruthy();
  });
});

describe('PUT, DELETE /catalog/groups/:id', () => {
  it('đổi tên kèm gợi ý → version 2; PUT không gửi `suggest` giữ cấu hình; version cũ → 409 kèm current (AC-S12)', async () => {
    const group = await createGroup(token, uniq('Sửa'), null);
    const first = await api(token).put(`/groups/${group.id}`, { name: group.name, suggest: SUGGEST, version: 1 });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ suggest: SUGGEST, version: 2 });
    const renamed = uniq('Đổi');
    const second = await api(token).put(`/groups/${group.id}`, { name: renamed, version: 2 });
    expect(second.body).toMatchObject({ name: renamed, suggest: SUGGEST, version: 3 });
    const stale = await api(token).put(`/groups/${group.id}`, { name: renamed, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');
    expect(stale.body.current).toMatchObject({ id: group.id, version: 3 });
  });

  it('id lạ, không phải uuid → 404; thiếu ?version= → 422', async () => {
    expect((await api(token).put(`/groups/${randomUUID()}`, { name: 'x', version: 1 })).status).toBe(404);
    expect((await api(token).put('/groups/abc', { name: 'x', version: 1 })).status).toBe(404);
    const group = await createGroup(token, uniq('Xoá'), null);
    const res = await api(token).delete(`/groups/${group.id}`);
    expect(res.status).toBe(422);
    expect(res.body.errors.version).toBeTruthy();
  });

  it('nhóm chỉ còn sản phẩm đã lưu trữ: `productCount` tính cả, DELETE → 409 in_use (V25, AC-S12)', async () => {
    const group = await createGroup(token, uniq('Lưu'), null);
    const product = await createProduct(token, { name: uniq('SP'), groupId: group.id, variants: [[]] });
    await archiveSku(token, product.id, product.variants[0]!.id);
    expect((await groupsOf(token)).find((g) => g.id === group.id)).toMatchObject({ productCount: 1 });
    const res = await api(token).delete(`/groups/${group.id}?version=1`);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/in_use');
  });
});

describe('POST /catalog/groups/:id/move-products', () => {
  it('chuyển cả nhóm (kể cả đã lưu trữ) → `{ moved: 2 }`, version nhóm giữ, version sản phẩm +1, nhật ký update; rồi xoá được (AC-5)', async () => {
    const source = await createGroup(token, uniq('Nguồn'), null);
    const target = await createGroup(token, uniq('Đích'), null);
    const a = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    const b = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    await archiveSku(token, b.id, b.variants[0]!.id);
    expect((await api(token).delete(`/groups/${source.id}?version=1`)).status).toBe(409);
    const before = await Promise.all([a.id, b.id].map(productVersion));

    const res = await api(token).post(`/groups/${source.id}/move-products`, { targetGroupId: target.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ moved: 2 });
    const after = await Promise.all([a.id, b.id].map(productVersion));
    expect(after).toEqual(before.map((p) => ({ version: p.version + 1, group_id: target.id })));
    const groups = await groupsOf(token);
    expect(groups.find((g) => g.id === source.id)).toMatchObject({ productCount: 0, version: 1 });
    expect(groups.find((g) => g.id === target.id)).toMatchObject({ productCount: 2, version: 1 });
    expect((await auditOf(a.id)).at(-1)).toEqual({
      action: 'update',
      entity_type: 'product.products',
      before: { group: source.name },
      after: { group: target.name },
    });
    // SKU không đổi theo nhóm.
    expect((await api(token).get(`/products/${a.id}`)).body.variants[0].sku).toBe(a.variants[0]!.sku);
    expect((await api(token).delete(`/groups/${source.id}?version=1`)).status).toBe(204);
  });

  it('chỉ `productIds` gửi lên mới chuyển', async () => {
    const source = await createGroup(token, uniq('Nguồn'), null);
    const target = await createGroup(token, uniq('Đích'), null);
    const a = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    const b = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    const res = await api(token).post(`/groups/${source.id}/move-products`, { targetGroupId: target.id, productIds: [a.id] });
    expect(res.body).toEqual({ moved: 1 });
    expect((await productVersion(b.id)).group_id).toBe(source.id);
  });

  it('nhóm đích trùng nguồn, không có, của công ty khác → 422 errors.targetGroupId', async () => {
    const source = await createGroup(token, uniq('Nguồn'), null);
    const other = await createCompany();
    const foreign = await createGroup(other.ceo.token, uniq('Khác'), null);
    for (const targetGroupId of [source.id, randomUUID(), 'abc', foreign.id]) {
      const res = await api(token).post(`/groups/${source.id}/move-products`, { targetGroupId });
      expect(res.status).toBe(422);
      expect(res.body.errors.targetGroupId).toBeTruthy();
    }
  });

  it('`productIds` có sản phẩm không thuộc nhóm nguồn → 422 errors.productIds, không chuyển sản phẩm nào (B2)', async () => {
    const source = await createGroup(token, uniq('Nguồn'), null);
    const elsewhere = await createGroup(token, uniq('Khác'), null);
    const target = await createGroup(token, uniq('Đích'), null);
    const a = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    const b = await createProduct(token, { name: uniq('SP'), groupId: elsewhere.id, variants: [[]] });
    const res = await api(token).post(`/groups/${source.id}/move-products`, { targetGroupId: target.id, productIds: [a.id, b.id] });
    expect(res.status).toBe(422);
    expect(res.body.errors.productIds).toBe('Có sản phẩm không thuộc nhóm này');
    expect((await productVersion(a.id)).group_id).toBe(source.id);
  });

  it('nhóm đích bị xoá giữa lúc đọc và lúc ghi (đua thật) → 422 errors.targetGroupId, không 500 (AC-S11)', async () => {
    const source = await createGroup(token, uniq('Nguồn'), null);
    const target = await createGroup(token, uniq('Đích'), null);
    const a = await createProduct(token, { name: uniq('SP'), groupId: source.id, variants: [[]] });
    const res = await raceBehindLock(
      async (holder) => {
        // Giữ khoá dòng sản phẩm của nhóm nguồn: request chuyển đã đọc thấy nhóm đích rồi mới bị chặn ở bước khoá này.
        await holder.query('select id from product.products where group_id = $1 for update', [source.id]);
        await holder.query('delete from product.product_groups where id = $1', [target.id]);
      },
      1,
      () => api(token).post(`/groups/${source.id}/move-products`, { targetGroupId: target.id }).then((r) => r),
    );
    expect(res.status).toBe(422);
    expect(res.body.errors.targetGroupId).toBeTruthy();
    expect((await productVersion(a.id)).group_id).toBe(source.id);
  });
});

describe('GET, PUT /catalog/settings', () => {
  it('công ty mới: mẫu `SP{SEQ:5}-{VAL}`, số kế tiếp 1, chưa đặt gợi ý', async () => {
    const { ceo } = await createCompany();
    const res = await api(ceo.token).get('/settings');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skuPattern: 'SP{SEQ:5}-{VAL}', skuNextSeq: 1, suggest: NO_SUGGEST, version: 1 });
  });

  it('version cũ → 409; mẫu sai → 422 errors.skuPattern; PUT không gửi `suggest` giữ cấu hình (AC-S2)', async () => {
    const { ceo } = await createCompany();
    const set = await api(ceo.token).put('/settings', { skuPattern: 'AB{SEQ:3}', suggest: SUGGEST, version: 1 });
    expect(set.body).toMatchObject({ skuPattern: 'AB{SEQ:3}', suggest: SUGGEST, version: 2 });
    const stale = await api(ceo.token).put('/settings', { skuPattern: 'X{SEQ}', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.current).toMatchObject({ version: 2 });
    const bad = await api(ceo.token).put('/settings', { skuPattern: 'AO-{VAL}', version: 2 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.skuPattern).toBeTruthy();
    const keep = await api(ceo.token).put('/settings', { skuPattern: 'CD{SEQ:3}', version: 2 });
    expect(keep.body).toMatchObject({ skuPattern: 'CD{SEQ:3}', suggest: SUGGEST, version: 3 });
  });

  it('PUT `suggest` vắng trường nào thì giữ trường đó, `null` thì xoá (KB2 2.10)', async () => {
    const { ceo } = await createCompany();
    const set = await api(ceo.token).put('/settings', { skuPattern: 'AB{SEQ:3}', suggest: SUGGEST, version: 1 });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    const partial = await api(ceo.token).put('/settings', {
      skuPattern: 'AB{SEQ:3}',
      suggest: { marginCoefficient: 1.3, priceRounding: null },
      version: 2,
    });
    expect(partial.status, JSON.stringify(partial.body)).toBe(200);
    expect(partial.body.suggest).toEqual({ ...SUGGEST, marginCoefficient: 1.3, priceRounding: null });
    const wrong = await api(ceo.token).put('/settings', { skuPattern: 'AB{SEQ:3}', suggest: { reorderLeadDays: 'x' }, version: 3 });
    expect(wrong.status).toBe(422);
    expect(wrong.body.errors).toHaveProperty(['suggest.reorderLeadDays']);
  });

  it('đổi mẫu chỉ áp cho SKU sinh sau; cấp số không tăng version cài đặt (P3, P7)', async () => {
    const { ceo } = await createCompany();
    const group = await createGroup(ceo.token, uniq('Áo'));
    const color = await createAttribute(ceo.token, uniq('Màu'), ['Đen', 'Trắng']);
    const product = await createProduct(ceo.token, { name: uniq('Áo'), groupId: group.id, variants: [[valueId(color, 'Đen')]] });
    expect(product.variants[0]!.sku).toBe('AO-0001-DEN');
    const settings = await setSkuPattern(ceo.token, 'TS{SEQ:2}{VAL}');
    expect(settings.skuNextSeq).toBe(2);
    const added = await api(ceo.token).post(`/products/${product.id}/variants`, { attributeValueIds: [valueId(color, 'Trắng')] });
    expect(added.status).toBe(201);
    expect(added.body.sku).toBe('TS02TRANG');
    const after = await api(ceo.token).get('/settings');
    expect(after.body).toMatchObject({ skuNextSeq: 3, version: settings.version });
  });

  it('RLS: công ty B không đọc, không sửa được cài đặt của A (AC-S1)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const rows = await asCompany(b.companyId, (c) => c.query('select company_id from product.company_product_settings'));
    expect(rows.rows).toEqual([{ company_id: b.companyId }]);
    const updated = await asCompany(b.companyId, (c) =>
      c.query(`update product.company_product_settings set sku_pattern = 'HACK{SEQ}' where company_id = $1`, [a.companyId]),
    );
    expect(updated.rowCount).toBe(0);
  });
});

describe('quyền nhóm hàng, cài đặt (AC-7, AC-S9)', () => {
  it('vai trò chỉ có `purchasing.request.manage`: tạo nhóm chỉ tên → 201, kèm `suggest` → 403; tắt phân hệ mua hàng → 403 module_disabled', async () => {
    const { companyId } = await createCompany();
    const buyer = await addMember(companyId, await createCustomRole(companyId, ['catalog.product.view', 'purchasing.request.manage']));
    expect((await api(buyer.token).post('/groups', { name: uniq('Nhanh') })).status).toBe(201);
    const withSuggest = await api(buyer.token).post('/groups', { name: uniq('Nhanh'), suggest: SUGGEST });
    expect(withSuggest.status).toBe(403);
    expect(withSuggest.body.type).toBe('/problems/forbidden');
    await setModuleEnabled(companyId, 'purchasing', false);
    const off = await api(buyer.token).post('/groups', { name: uniq('Nhanh') });
    expect(off.status).toBe(403);
    expect(off.body.type).toBe('/problems/module_disabled');
  });

  it('`catalog.product.manage` tạo nhóm, chuyển sản phẩm được nhưng không sửa cài đặt, nhóm; Sale (chỉ xem) không tạo nhóm', async () => {
    const { companyId, ceo } = await createCompany();
    const editor = await addMember(companyId, await createCustomRole(companyId, ['catalog.product.view', 'catalog.product.manage']));
    const group = await api(editor.token).post('/groups', { name: uniq('Nhanh') });
    expect(group.status).toBe(201);
    expect((await api(editor.token).put('/settings', { skuPattern: 'X{SEQ}', version: 1 })).status).toBe(403);
    expect((await api(editor.token).put(`/groups/${group.body.id}`, { name: 'x', version: 1 })).status).toBe(403);
    const target = await createGroup(ceo.token, uniq('Đích'), null);
    expect((await api(editor.token).post(`/groups/${group.body.id}/move-products`, { targetGroupId: target.id })).status).toBe(200);
    const sale = await addMember(companyId, 'sale');
    expect((await api(sale.token).post('/groups', { name: uniq('Nhanh') })).status).toBe(403);
    expect((await api(sale.token).post(`/groups/${group.body.id}/move-products`, { targetGroupId: target.id })).status).toBe(403);
    expect((await api(sale.token).get('/settings')).status).toBe(200);
  });
});
