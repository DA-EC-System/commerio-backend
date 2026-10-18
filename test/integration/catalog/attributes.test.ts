import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../helpers/company.ts';
import { type AttributeBody, api, auditOf, createAttribute, createCategory, createProduct, valueId, uniq } from './helpers.ts';

// Thuộc tính và mã giá trị (UC-CP-01; Documents/21 5.2, 5.3, V21, V24).
let token: string;
beforeAll(async () => {
  token = (await createCompany()).ceo.token;
});

const put = (a: AttributeBody, values: { id?: string; value: string; code?: string }[], name = a.name) =>
  api(token).put(`/attributes/${a.id}`, { name, values, version: a.version });

describe('POST /catalog/attributes', () => {
  it('mã bỏ trống thì sinh theo bảng 9.2, giữ thứ tự gửi lên, nhật ký create (AC-16, AC-20)', async () => {
    const name = uniq('Màu');
    const res = await api(token).post('/attributes', {
      name,
      values: [{ value: 'Xanh navy' }, { value: 'Đỏ đô' }, { value: 'S', code: ' s1 ' }],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name, productCount: 0, version: 1 });
    expect(res.body.values.map((v: { value: string; code: string; inUse: boolean }) => [v.value, v.code, v.inUse])).toEqual([
      ['Xanh navy', 'XANHNA', false],
      ['Đỏ đô', 'DODO', false],
      ['S', 'S1', false],
    ]);
    const list = await api(token).get('/attributes');
    expect(list.body).toContainEqual(res.body);
    expect(await auditOf(res.body.id)).toEqual([
      {
        action: 'create',
        entity_type: 'catalog.attributes',
        before: null,
        after: { name, values: ['Xanh navy (XANHNA)', 'Đỏ đô (DODO)', 'S (S1)'] },
      },
    ]);
  });

  it('hai giá trị trùng mã → 422 errors["values.<i>.code"] ở dòng sau (AC-16)', async () => {
    const res = await api(token).post('/attributes', {
      name: uniq('Màu'),
      values: [{ value: 'Xanh navy' }, { value: 'Xanh navy đậm' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'values.1.code': 'Mã bị trùng' });
  });

  it('mã sai dạng hoặc sinh ra rỗng → 422 ở ô mã', async () => {
    const res = await api(token).post('/attributes', {
      name: uniq('Ký hiệu'),
      values: [{ value: 'A', code: 'A-B' }, { value: '---' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors['values.0.code']).toBe('Mã chỉ gồm A-Z, 0-9, tối đa 6 ký tự');
    expect(res.body.errors['values.1.code']).toBe('Nhập mã');
  });

  it('giá trị trùng (không phân biệt hoa thường), danh sách rỗng, giá trị quá 40 ký tự → 422 (AC-18)', async () => {
    const dup = await api(token).post('/attributes', { name: uniq('X'), values: [{ value: 'Đen', code: 'D1' }, { value: 'đen', code: 'D2' }] });
    expect(dup.status).toBe(422);
    expect(dup.body.errors.values).toBe('Có giá trị bị trùng');
    const empty = await api(token).post('/attributes', { name: uniq('X'), values: [] });
    expect(empty.body.errors.values).toBe('Thêm ít nhất một giá trị');
    const long = await api(token).post('/attributes', { name: uniq('X'), values: [{ value: 'A'.repeat(41) }] });
    expect(long.body.errors['values.0.value']).toBeTruthy();
    const longName = await api(token).post('/attributes', { name: 'A'.repeat(41), values: [{ value: 'A' }] });
    expect(longName.body.errors.name).toBeTruthy();
  });

  it('tên trùng → 409 name_taken (AC-18)', async () => {
    const name = uniq('Size');
    await createAttribute(token, name, ['M']);
    const res = await api(token).post('/attributes', { name: name.toUpperCase(), values: [{ value: 'L' }] });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/name_taken');
    expect(res.body.errors.name).toBeTruthy();
  });
});

describe('PUT /catalog/attributes/:id', () => {
  it('giá trị cũ vắng mặt bị xoá, không có id thì thêm mới, đổi được mã (AC-7, AC-16)', async () => {
    const a = await createAttribute(token, uniq('Size'), ['S', 'M', 'L']);
    const res = await put(a, [
      { id: valueId(a, 'S'), value: 'S', code: 'SMALL' },
      { id: valueId(a, 'L'), value: 'L' },
      { value: 'XL' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.values.map((v: { value: string; code: string }) => `${v.value}:${v.code}`)).toEqual([
      'S:SMALL',
      'L:L',
      'XL:XL',
    ]);
    expect(res.body.values[0].id).toBe(valueId(a, 'S'));
  });

  it('đổi chéo mã và chữ giữa hai giá trị → 200 (S-8)', async () => {
    const a = await createAttribute(token, uniq('Màu'), ['Đen', 'Trắng']);
    const res = await put(a, [
      { id: valueId(a, 'Đen'), value: 'Trắng', code: 'TRANG' },
      { id: valueId(a, 'Trắng'), value: 'Đen', code: 'DEN' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.values.map((v: { id: string; value: string; code: string }) => [v.id, v.value, v.code])).toEqual([
      [valueId(a, 'Đen'), 'Trắng', 'TRANG'],
      [valueId(a, 'Trắng'), 'Đen', 'DEN'],
    ]);
  });

  it('bỏ giá trị đang có biến thể dùng → 409 in_use, không đổi gì (AC-6); inUse, productCount đúng (AC-7)', async () => {
    const a = await createAttribute(token, uniq('Màu'), ['Đen', 'Trắng']);
    const category = await createCategory(token, uniq('Áo'));
    await createProduct(token, { name: uniq('Áo'), categoryId: category.id, variants: [[valueId(a, 'Đen')]] });

    const list = await api(token).get('/attributes');
    const fresh = list.body.find((x: AttributeBody) => x.id === a.id) as AttributeBody;
    expect(fresh.productCount).toBe(1);
    expect(fresh.values.map((v) => [v.value, v.inUse])).toEqual([
      ['Đen', true],
      ['Trắng', false],
    ]);

    const res = await put(a, [{ id: valueId(a, 'Trắng'), value: 'Trắng' }]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/in_use');
    const after = (await api(token).get('/attributes')).body.find((x: AttributeBody) => x.id === a.id);
    expect(after.values).toHaveLength(2);
    expect(after.version).toBe(1);
  });

  it('id giá trị không thuộc thuộc tính → 422 errors.values', async () => {
    const a = await createAttribute(token, uniq('Size'), ['S']);
    const b = await createAttribute(token, uniq('Size'), ['M']);
    const res = await put(a, [{ id: valueId(b, 'M'), value: 'M' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors.values).toBeTruthy();
  });

  it('một id giá trị gửi hai lần → 422 errors.values, không đổi gì', async () => {
    const a = await createAttribute(token, uniq('Size'), ['S']);
    const res = await put(a, [
      { id: valueId(a, 'S'), value: 'S' },
      { id: valueId(a, 'S'), value: 'M' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.errors.values).toBe('Một giá trị được gửi hai lần');
  });

  it('version cũ → 409 version_conflict kèm current', async () => {
    const a = await createAttribute(token, uniq('Size'), ['S']);
    await put(a, [{ id: valueId(a, 'S'), value: 'S' }]);
    const res = await put(a, [{ id: valueId(a, 'S'), value: 'S' }]);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(res.body.current).toMatchObject({ id: a.id, version: 2 });
  });

  it('nhật ký update có before và after', async () => {
    const a = await createAttribute(token, uniq('Size'), ['S']);
    await put(a, [{ id: valueId(a, 'S'), value: 'Nhỏ', code: 'S' }]);
    expect((await auditOf(a.id))[1]).toMatchObject({
      action: 'update',
      before: { values: ['S (S)'] },
      after: { values: ['Nhỏ (S)'] },
    });
  });
});

describe('DELETE /catalog/attributes/:id', () => {
  it('thiếu ?version= → 422 errors.version; xoá thuộc tính chưa dùng → 204 (AC-20)', async () => {
    const a = await createAttribute(token, uniq('Chất liệu'), ['Cotton', 'Lụa']);
    const missing = await api(token).delete(`/attributes/${a.id}`);
    expect(missing.status).toBe(422);
    expect(missing.body.errors.version).toBeTruthy();
    const res = await api(token).delete(`/attributes/${a.id}?version=1`);
    expect(res.status).toBe(204);
    const list = await api(token).get('/attributes');
    expect(list.body.some((x: AttributeBody) => x.id === a.id)).toBe(false);
    expect((await auditOf(a.id)).map((l) => l.action)).toEqual(['create', 'delete']);
  });

  it('thuộc tính có biến thể dùng (kể cả đã ngừng bán) → 409 in_use (AC-6)', async () => {
    const a = await createAttribute(token, uniq('Màu'), ['Đen', 'Trắng']);
    const category = await createCategory(token, uniq('Áo'));
    const product = await createProduct(token, {
      name: uniq('Áo'),
      categoryId: category.id,
      variants: [[valueId(a, 'Đen')], [valueId(a, 'Trắng')]],
    });
    await api(token).delete(`/products/${product.id}/variants/${product.variants[0]!.id}`);
    const res = await api(token).delete(`/attributes/${a.id}?version=1`);
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/in_use');
  });
});
