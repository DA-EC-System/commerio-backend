import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { login, testApp } from '../../helpers/http.ts';
import { lockCompany } from '../../helpers/state.ts';
import { api, createAttribute, createGroup, createProduct, type ProductBody, valueId } from './helpers.ts';

// Quyền và cô lập công ty của /catalog/* (AC-15; Documents/21 C4, P11, mục 8, V1, V5).
let ceo: string;
let sale: string;
let ownProductId: string;
let theirs: { groupId: string; attributeId: string; product: ProductBody };
beforeAll(async () => {
  const mine = await createCompany();
  ceo = mine.ceo.token;
  sale = (await addMember(mine.companyId, 'sale')).token;
  const own = await createGroup(ceo, 'Ví da', 'PK-{SEQ}');
  ownProductId = (await createProduct(ceo, { name: 'Ví', groupId: own.id, variants: [[]] })).id;
  const other = await createCompany();
  const color = await createAttribute(other.ceo.token, 'Màu', ['Đen', 'Trắng']);
  const group = await createGroup(other.ceo.token, 'Áo', 'B-{SEQ}-{VAL}');
  const product = await createProduct(other.ceo.token, {
    name: 'Áo của B',
    groupId: group.id,
    variants: [[valueId(color, 'Đen')], [valueId(color, 'Trắng')]],
  });
  theirs = { groupId: group.id, attributeId: color.id, product };
});

describe('Sale chỉ có catalog.product.view (AC-15)', () => {
  it.each(['/groups', '/settings', '/attributes', '/products', 'detail'])('GET %s → 200', async (path) => {
    expect((await api(sale).get(path === 'detail' ? `/products/${ownProductId}` : path)).status).toBe(200);
  });

  // Mọi operation ghi; body rỗng vẫn 403 vì kiểm quyền đứng trước validate.
  const writes: [string, (t: string) => request.Test][] = [
    ['POST /groups', (t) => api(t).post('/groups', {})],
    ['PUT /groups/:id', (t) => api(t).put(`/groups/${theirs.groupId}`, {})],
    ['DELETE /groups/:id', (t) => api(t).delete(`/groups/${theirs.groupId}`)],
    ['POST /groups/:id/move-products', (t) => api(t).post(`/groups/${theirs.groupId}/move-products`, {})],
    ['PUT /settings', (t) => api(t).put('/settings', {})],
    ['POST /attributes', (t) => api(t).post('/attributes', {})],
    ['PUT /attributes/:id', (t) => api(t).put(`/attributes/${theirs.attributeId}`, {})],
    ['DELETE /attributes/:id', (t) => api(t).delete(`/attributes/${theirs.attributeId}`)],
    ['POST /products', (t) => api(t).post('/products', {})],
    ['PUT /products/:id', (t) => api(t).put(`/products/${theirs.product.id}`, {})],
    ['DELETE /products/:id', (t) => api(t).delete(`/products/${theirs.product.id}`)],
    ['POST /products/:id/variants', (t) => api(t).post(`/products/${theirs.product.id}/variants`, {})],
    ['POST /products/:id/business-status', (t) => api(t).post(`/products/${theirs.product.id}/business-status`, {})],
    ['PATCH /products/:id/variants/:variantId', (t) => api(t).patch(`/products/${theirs.product.id}/variants/${theirs.product.variants[0]!.id}`, {})],
  ];
  it.each(writes)('%s → 403 forbidden', async (_name, call) => {
    const res = await call(sale);
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/forbidden');
  });
});

describe('bản ghi của công ty khác → 404, không đổi gì (AC-15, C4)', () => {
  it.each([
    ['PUT nhóm hàng', () => api(ceo).put(`/groups/${theirs.groupId}`, { name: 'X', version: 1 })],
    ['DELETE nhóm hàng', () => api(ceo).delete(`/groups/${theirs.groupId}?version=1`)],
    ['PUT thuộc tính', () => api(ceo).put(`/attributes/${theirs.attributeId}`, { name: 'X', values: [{ value: 'X' }], version: 1 })],
    ['DELETE thuộc tính', () => api(ceo).delete(`/attributes/${theirs.attributeId}?version=1`)],
    ['GET sản phẩm', () => api(ceo).get(`/products/${theirs.product.id}`)],
    ['PUT sản phẩm', () => api(ceo).put(`/products/${theirs.product.id}`, { name: 'X', description: '', imageFileIds: [], version: 1 })],
    ['DELETE sản phẩm', () => api(ceo).delete(`/products/${theirs.product.id}?version=1`)],
    ['thêm biến thể', () => api(ceo).post(`/products/${theirs.product.id}/variants`, { attributeValueIds: [] })],
    ['đổi trạng thái kinh doanh', () => api(ceo).post(`/products/${theirs.product.id}/business-status`, { action: 'pause' })],
    ['sửa SKU', () => api(ceo).patch(`/products/${theirs.product.id}/variants/${theirs.product.variants[0]!.id}`, { version: 1, weightG: 1 })],
  ])('%s → 404 not_found', async (_name, call) => {
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.body.type).toBe('/problems/not_found');
  });

  it('danh sách không có bản ghi của công ty khác; bản ghi của B không đổi', async () => {
    const products = await api(ceo).get('/products?search=Áo của B');
    expect(products.body.total).toBe(0);
    const groups = await api(ceo).get('/groups');
    expect(groups.body.items.some((g: { id: string }) => g.id === theirs.groupId)).toBe(false);
    const { rows } = await testPool().query(
      `select p.version, count(*) filter (where v.business_status <> 'selling')::int as changed from product.products p
       join product.product_variants v on v.product_id = p.id where p.id = $1 group by p.id`,
      [theirs.product.id],
    );
    expect(rows[0]).toEqual({ version: 1, changed: 0 });
  });
});

describe('đăng nhập và công ty', () => {
  it('không token → 401; token chưa chọn công ty → 403 company_not_selected', async () => {
    expect((await request(testApp()).get('/api/v1/catalog/groups')).status).toBe(401);
    const { token } = await login((await createCompany()).ceo.email);
    const res = await api(token).get('/groups');
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/company_not_selected');
  });

  it('công ty bị khoá sau khi đã có token → 403 company_locked', async () => {
    const { companyId, ceo: owner } = await createCompany();
    await lockCompany(companyId);
    const res = await api(owner.token).post('/groups', { name: 'X' });
    expect(res.status).toBe(403);
    expect(res.body.type).toBe('/problems/company_locked');
  });
});
