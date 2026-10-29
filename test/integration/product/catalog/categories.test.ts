import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { api, auditOf, createAttribute, createCategory, createProduct, valueId, uniq } from './helpers.ts';

// Danh mục và quy tắc SKU (UC-CP-01; Documents/21 5.1–5.3, 9.3, V7, V8, V24, V25).
let token: string;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
});


describe('GET/POST /catalog/categories', () => {
  it('tạo danh mục trả 201 kèm bản ghi, danh sách có đủ trường, nhật ký create có after (AC-4, AC-20)', async () => {
    const name = uniq('Áo');
    const res = await api(token).post('/categories', { name: `  ${name} `, skuPattern: ' AO-{SEQ:4}-{VAL} ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name, skuPattern: 'AO-{SEQ:4}-{VAL}', skuNextSeq: 1, productCount: 0, version: 1 });
    expect(typeof res.body.updatedAt).toBe('string');

    const list = await api(token).get('/categories');
    expect(list.status).toBe(200);
    expect(list.body).toContainEqual(res.body);

    const logs = await auditOf(res.body.id);
    expect(logs).toEqual([
      { action: 'create', entity_type: 'product.categories', before: null, after: { name, skuPattern: 'AO-{SEQ:4}-{VAL}' } },
    ]);
  });

  it('danh sách sắp theo tên tiếng Việt', async () => {
    const { ceo } = await createCompany();
    for (const name of ['Ăn vặt', 'Bút', 'Áo']) await createCategory(ceo.token, name, 'X-{SEQ}');
    const list = await api(ceo.token).get('/categories');
    expect(list.body.map((c: { name: string }) => c.name)).toEqual(['Áo', 'Ăn vặt', 'Bút']);
  });

  it.each([
    ['AO-{VAL}', 'Quy tắc phải có đúng một {SEQ} để SKU không trùng'],
    ['AO-{SEQ}-{SEQ}', 'Quy tắc phải có đúng một {SEQ} để SKU không trùng'],
    ['ao-{SEQ}', 'Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"'],
    ['AO {SEQ}', 'Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"'],
    ['AO-{SEQ:0}', 'Số chữ số của {SEQ} từ 1 đến 9'],
    ['AO-{VAL}-{VAL}-{SEQ}', 'Chỉ dùng {VAL} một lần'],
    [`${'A'.repeat(36)}{SEQ}`, 'Quy tắc tối đa 40 ký tự'],
  ])('quy tắc sai %s → 422 errors.skuPattern, không tạo gì (AC-3)', async (skuPattern, message) => {
    const name = uniq('Sai');
    const res = await api(token).post('/categories', { name, skuPattern });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'validation_failed', errors: { skuPattern: message } });
    const list = await api(token).get('/categories');
    expect(list.body.some((c: { name: string }) => c.name === name)).toBe(false);
  });

  it('tên trống hoặc dài quá 60 ký tự → 422 errors.name (AC-18)', async () => {
    for (const name of ['  ', 'A'.repeat(61)]) {
      const res = await api(token).post('/categories', { name, skuPattern: 'X-{SEQ}' });
      expect(res.status).toBe(422);
      expect(res.body.errors.name).toBeTruthy();
    }
  });

  it('tên trùng không phân biệt hoa thường → 409 name_taken kèm errors.name (AC-18)', async () => {
    const name = uniq('Quần');
    await createCategory(token, name);
    const res = await api(token).post('/categories', { name: ` ${name.toUpperCase()} `, skuPattern: 'Q-{SEQ}' });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
    expect(res.body.errors.name).toBeTruthy();
  });
});

describe('PUT /catalog/categories/:id', () => {
  it('đổi tên và quy tắc với version đúng → 200, version tăng 1, nhật ký update (AC-5, AC-20)', async () => {
    const category = await createCategory(token, uniq('Giày'));
    const res = await api(token).put(`/categories/${category.id}`, {
      name: category.name,
      skuPattern: 'GIAY-{SEQ:2}-{VAL}',
      version: 1,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ skuPattern: 'GIAY-{SEQ:2}-{VAL}', version: 2 });
    const logs = await auditOf(category.id);
    expect(logs[1]).toMatchObject({
      action: 'update',
      before: { skuPattern: 'AO-{SEQ:4}-{VAL}' },
      after: { skuPattern: 'GIAY-{SEQ:2}-{VAL}' },
    });
  });

  it('version cũ → 409 version_conflict kèm current (C3)', async () => {
    const category = await createCategory(token, uniq('Mũ'));
    await api(token).put(`/categories/${category.id}`, { name: category.name, skuPattern: 'MU-{SEQ}', version: 1 });
    const res = await api(token).put(`/categories/${category.id}`, { name: 'Khác', skuPattern: 'MU-{SEQ}', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ id: category.id, version: 2, skuPattern: 'MU-{SEQ}' });
  });

  it('quy tắc sai → 422, đọc lại không đổi (AC-3)', async () => {
    const category = await createCategory(token, uniq('Túi'));
    const res = await api(token).put(`/categories/${category.id}`, { name: category.name, skuPattern: 'ao-{SEQ}', version: 1 });
    expect(res.status).toBe(422);
    expect(res.body.errors.skuPattern).toBe('Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"');
    const list = await api(token).get('/categories');
    expect(list.body.find((c: { id: string }) => c.id === category.id)).toMatchObject({ skuPattern: 'AO-{SEQ:4}-{VAL}', version: 1 });
  });

  it('đổi sang tên của danh mục khác → 409 name_taken', async () => {
    const a = await createCategory(token, uniq('Ví'));
    const b = await createCategory(token, uniq('Ví'));
    const res = await api(token).put(`/categories/${b.id}`, { name: a.name.toLowerCase(), skuPattern: 'VI-{SEQ}', version: 1 });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
  });

  it('id không có hoặc không phải uuid → 404', async () => {
    for (const id of [randomUUID(), 'abc']) {
      const res = await api(token).put(`/categories/${id}`, { name: 'X', skuPattern: 'X-{SEQ}', version: 1 });
      expect(res.status).toBe(404);
      expect(res.body.type).toBe('/problems/not_found');
    }
  });
});

describe('DELETE /catalog/categories/:id', () => {
  it('thiếu ?version= → 422 errors.version (AC-20, V8)', async () => {
    const category = await createCategory(token, uniq('Xoá'));
    const res = await api(token).delete(`/categories/${category.id}`);
    expect(res.status).toBe(422);
    expect(res.body.errors.version).toBeTruthy();
  });

  it('xoá danh mục chưa có sản phẩm → 204, biến khỏi danh sách, nhật ký delete (AC-20)', async () => {
    const category = await createCategory(token, uniq('Xoá'));
    const res = await api(token).delete(`/categories/${category.id}?version=1`);
    expect(res.status).toBe(204);
    const list = await api(token).get('/categories');
    expect(list.body.some((c: { id: string }) => c.id === category.id)).toBe(false);
    expect((await auditOf(category.id)).map((l) => l.action)).toEqual(['create', 'delete']);
  });

  it('version cũ → 409 version_conflict', async () => {
    const category = await createCategory(token, uniq('Xoá'));
    const res = await api(token).delete(`/categories/${category.id}?version=7`);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
  });

  it('danh mục có sản phẩm → 409 in_use, kể cả khi sản phẩm đã lưu trữ (AC-6, AC-19)', async () => {
    const category = await createCategory(token, uniq('Đang dùng'));
    const product = await createProduct(token, { name: uniq('SP'), categoryId: category.id, variants: [[]] });
    const first = await api(token).delete(`/categories/${category.id}?version=1`);
    expect(first.status).toBe(409);
    expect(first.body.type).toBe('/problems/in_use');

    expect((await api(token).delete(`/products/${product.id}?version=1`)).status).toBe(204);
    const list = await api(token).get('/categories');
    expect(list.body.find((c: { id: string }) => c.id === category.id)).toMatchObject({ productCount: 1 });
    const second = await api(token).delete(`/categories/${category.id}?version=1`);
    expect(second.status).toBe(409);
    expect(second.body.type).toBe('/problems/in_use');
  });
});

describe('đổi quy tắc chỉ áp dụng cho SKU sinh sau (AC-5)', () => {
  it('SKU đã cấp giữ nguyên, biến thể thêm sau dùng quy tắc mới', async () => {
    const category = await createCategory(token, uniq('Áo thun'));
    const color = await createAttribute(token, uniq('Màu'), ['Đen', 'Trắng']);
    const product = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
      variants: [[valueId(color, 'Đen')]],
    });
    expect(product.variants[0]!.sku).toBe('AO-0001-DEN');

    const put = await api(token).put(`/categories/${category.id}`, { name: category.name, skuPattern: 'TS{SEQ:2}{VAL}', version: 1 });
    expect(put.status).toBe(200);
    const added = await api(token).post(`/products/${product.id}/variants`, { attributeValueIds: [valueId(color, 'Trắng')] });
    expect(added.status).toBe(201);
    expect(added.body.sku).toBe('TS02TRANG');

    const detail = await api(token).get(`/products/${product.id}`);
    expect(detail.body.variants.map((v: { sku: string }) => v.sku)).toEqual(['AO-0001-DEN', 'TS02TRANG']);
  });
});
