// Thông số sản phẩm (#510, Documents/21 mục 5.5): thư viện thông số, mẫu nhóm, giá trị thông số của sản phẩm, độ hoàn
// thiện `specs`, cổng getProductSpecs / getVariants.platformKind, cô lập công ty.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setHeadObject } from '#src/modules/core/files/service/storage.ts';
import { GroupTemplate, ProductDetail, SpecField } from '#src/modules/product/catalog/api/schemas.ts';
import { getProductSpecs, getSpecFields, getVariants } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { api, uniq } from './helpers.ts';

let token: string;
let companyId: string;

beforeAll(async () => {
  const c = await createCompany();
  token = c.ceo.token;
  companyId = c.companyId;
});

const ok = (res: { status: number; body: unknown }, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status);
const problem = (res: { status: number; body: { type?: string } }, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};

async function groupNamed(name: string) {
  const res = await api(token).get('/groups');
  ok(res);
  return (res.body.items as { id: string; name: string; version: number }[]).find((g) => g.name === name)!;
}

async function createField(body: object) {
  const res = await api(token).post('/spec-fields', body);
  ok(res, 201);
  return SpecField.parse(res.body);
}

/** Sản phẩm một biến thể, không trục, trong nhóm có sẵn. */
async function createSimpleProduct(groupId: string, extra: object = {}) {
  const res = await api(token).post('/products', {
    name: uniq('SP thông số'),
    groupId,
    axes: [],
    variants: [{ options: [] }],
    ...extra,
  });
  return res;
}

describe('thư viện thông số (#510)', () => {
  it('công ty mới có thư viện mặc định; tạo thông số sinh mã từ tên; gửi mã đã có → 409 code_taken', async () => {
    const list = await api(token).get('/spec-fields');
    ok(list);
    expect(list.body.items.map((f: { code: string }) => f.code)).toContain('chat_lieu');
    const name = uniq('Độ bền màu');
    const a = await createField({ name, input: 'select', allowCustom: false, options: [{ value: 'Cao' }, { value: 'Thấp' }] });
    expect(a.code).toMatch(/^do_ben_mau_/);
    expect(a.options.map((o) => [o.value, o.position, o.inUse])).toEqual([
      ['Cao', 0, false],
      ['Thấp', 1, false],
    ]);
    problem(await api(token).post('/spec-fields', { name: uniq('Mã khác'), code: a.code, input: 'text', allowCustom: false }), 409, 'code_taken');
  });

  it('tên trùng (không phân biệt hoa thường) → 409 name_taken; đơn vị với kiểu không phải số → 422', async () => {
    const name = uniq('Trùng tên');
    await createField({ name, input: 'text', allowCustom: false });
    problem(await api(token).post('/spec-fields', { name: name.toUpperCase(), input: 'text', allowCustom: false }), 409, 'name_taken');
    problem(await api(token).post('/spec-fields', { name: uniq('Đơn vị'), input: 'text', unit: 'cm', allowCustom: false }), 422, 'validation_failed');
  });

  it('xoá lựa chọn đang dùng → 409 in_use; xoá thông số trong mẫu nhóm → 409 in_use kèm groups; hết dùng thì xoá được', async () => {
    const field = await createField({ name: uniq('Lớp phủ'), input: 'select', allowCustom: false, options: [{ value: 'Bóng' }, { value: 'Mờ' }] });
    const groupName = uniq('Nhóm phủ');
    const created = await api(token).post('/groups', { name: groupName });
    ok(created, 201);
    const group = created.body as { id: string };
    const tpl = GroupTemplate.parse((await api(token).get(`/groups/${group.id}/template`)).body);
    const put = await api(token).put(`/groups/${group.id}/template`, {
      axisAttributeIds: tpl.axes.map((a) => a.attributeId),
      fields: [...tpl.fields.map((f) => ({ fieldId: f.fieldId, required: f.required })), { fieldId: field.id, required: false }],
      version: tpl.version,
    });
    ok(put);
    const product = await createSimpleProduct(group.id, { specs: [{ fieldId: field.id, optionIds: [field.options[0]!.id] }] });
    ok(product, 201);

    const removeUsed = await api(token).put(`/spec-fields/${field.id}`, {
      name: field.name,
      allowCustom: false,
      options: [{ id: field.options[1]!.id, value: 'Mờ' }],
      version: field.version,
    });
    problem(removeUsed, 409, 'in_use');

    const del = await api(token).delete(`/spec-fields/${field.id}?version=${field.version}`);
    problem(del, 409, 'in_use');
    expect(del.body).toMatchObject({ groupCount: 1, productCount: 1, groups: [{ id: group.id, name: groupName }] });

    // Gỡ khỏi mẫu, xoá giá trị ở sản phẩm, rồi xoá được.
    const cur = GroupTemplate.parse((await api(token).get(`/groups/${group.id}/template`)).body);
    ok(
      await api(token).put(`/groups/${group.id}/template`, {
        axisAttributeIds: cur.axes.map((a) => a.attributeId),
        fields: cur.fields.filter((f) => f.fieldId !== field.id).map((f) => ({ fieldId: f.fieldId, required: f.required })),
        version: cur.version,
      }),
    );
    const detail = ProductDetail.parse(product.body);
    ok(await api(token).put(`/products/${detail.id}`, { name: detail.name, specs: [{ fieldId: field.id, optionIds: [] }], version: detail.version }));
    ok(await api(token).delete(`/spec-fields/${field.id}?version=${field.version}`), 204);
  });

  it('Sale không sửa được thư viện (403), xem được', async () => {
    const sale = await addMember(companyId, 'sale');
    const asSale = api(sale.token);
    ok(await asSale.get('/spec-fields'));
    problem(await asSale.post('/spec-fields', { name: uniq('Sale'), input: 'text', allowCustom: false }), 403, 'forbidden');
  });
});

describe('mẫu nhóm (#510)', () => {
  it('GET mẫu của nhóm mặc định có trục chuẩn và thông số bắt buộc; danh sách nhóm có specFieldCount, requiredCount', async () => {
    const group = await groupNamed('Thời trang nam');
    const tpl = GroupTemplate.parse((await api(token).get(`/groups/${group.id}/template`)).body);
    expect(tpl.axes.map((a) => a.platformKind)).toEqual(['color', 'size']);
    expect(tpl.fields.filter((f) => f.required).map((f) => f.code)).toEqual(['chat_lieu', 'huong_dan_giat']);
    const list = (await api(token).get('/groups')).body.items.find((g: { id: string }) => g.id === group.id);
    expect(list).toMatchObject({ specFieldCount: tpl.fields.length, requiredCount: 2 });
  });

  it('PUT mẫu: version cũ → 409; thông số không có → 422 errors["fields.0.fieldId"]; thuộc tính lạ → 422 errors.axisAttributeIds', async () => {
    const created = await api(token).post('/groups', { name: uniq('Nhóm mẫu') });
    ok(created, 201);
    const g = created.body as { id: string; version: number };
    problem(await api(token).put(`/groups/${g.id}/template`, { axisAttributeIds: [], fields: [], version: g.version + 5 }), 409, 'version_conflict');
    const badField = await api(token).put(`/groups/${g.id}/template`, {
      axisAttributeIds: [],
      fields: [{ fieldId: '00000000-0000-4000-8000-000000000000', required: true }],
      version: g.version,
    });
    problem(badField, 422, 'validation_failed');
    expect(badField.body.errors).toHaveProperty(['fields.0.fieldId']);
    const badAxis = await api(token).put(`/groups/${g.id}/template`, {
      axisAttributeIds: ['00000000-0000-4000-8000-000000000000'],
      fields: [],
      version: g.version,
    });
    problem(badAxis, 422, 'validation_failed');
    expect(badAxis.body.errors).toHaveProperty('axisAttributeIds');
  });

  it('tạo nhóm chép mẫu của nhóm khác; không có quyền catalog.group.manage → 403', async () => {
    const source = await groupNamed('Mỹ phẩm & chăm sóc da');
    const res = await api(token).post('/groups', { name: uniq('Mỹ phẩm 2'), copyTemplateFromGroupId: source.id });
    ok(res, 201);
    const src = GroupTemplate.parse((await api(token).get(`/groups/${source.id}/template`)).body);
    const copy = GroupTemplate.parse((await api(token).get(`/groups/${res.body.id}/template`)).body);
    expect(copy.axes).toEqual(src.axes);
    // Nhóm nguồn là nhóm nền tảng (#521): dòng chép thành dòng của công ty.
    expect(copy.fields).toEqual(src.fields.map((f) => ({ ...f, scope: 'company' })));
    problem(await api(token).post('/groups', { name: uniq('Nhóm lạ'), copyTemplateFromGroupId: '00000000-0000-4000-8000-000000000000' }), 422, 'validation_failed');
    const sale = await addMember(companyId, 'sale');
    problem(await api(sale.token).post('/groups', { name: uniq('Sale chép'), copyTemplateFromGroupId: source.id }), 403, 'forbidden');
  });
});

describe('thông số của sản phẩm (#510)', () => {
  it('thiếu thông số bắt buộc vẫn lưu được; missingSpecFieldIds và nhãn `specs` của SKU; điền đủ thì hết', async () => {
    const group = await groupNamed('Thời trang nữ');
    const tpl = GroupTemplate.parse((await api(token).get(`/groups/${group.id}/template`)).body);
    const required = tpl.fields.filter((f) => f.required);
    const res = await createSimpleProduct(group.id);
    ok(res, 201);
    const detail = ProductDetail.parse(res.body);
    expect(detail.missingSpecFieldIds.sort()).toEqual(required.map((f) => f.fieldId).sort());
    expect(detail.variants[0]!.missing).toContain('specs');
    expect(detail.specs.slice(0, tpl.fields.length).map((s) => s.code)).toEqual(tpl.fields.map((f) => f.code));

    const specs = required.map((f) => ({ fieldId: f.fieldId, optionIds: [f.options[0]!.id] }));
    const upd = await api(token).put(`/products/${detail.id}`, { name: detail.name, specs, version: detail.version });
    ok(upd);
    const after = ProductDetail.parse(upd.body);
    expect(after.missingSpecFieldIds).toEqual([]);
    expect(after.variants[0]!.missing).not.toContain('specs');
  });

  it('newValues thêm lựa chọn khi thông số nhận giá trị ngoài danh sách; không nhận thì 422 errors["specs.0"]', async () => {
    const open = await createField({ name: uniq('Mở'), input: 'multiselect', allowCustom: true, options: [{ value: 'A' }] });
    const closed = await createField({ name: uniq('Đóng'), input: 'select', allowCustom: false, options: [{ value: 'X' }] });
    const group = await groupNamed('Khác');
    const res = await createSimpleProduct(group.id, { specs: [{ fieldId: open.id, optionIds: [open.options[0]!.id], newValues: ['B mới'] }] });
    ok(res, 201);
    const spec = ProductDetail.parse(res.body).specs.find((s) => s.fieldId === open.id)!;
    expect(spec).toMatchObject({ inTemplate: false });
    expect(spec.selected.map((o) => o.value)).toEqual(['A', 'B mới']);
    const bad = await createSimpleProduct(group.id, { specs: [{ fieldId: closed.id, newValues: ['Y'] }] });
    problem(bad, 422, 'validation_failed');
    expect(bad.body.errors).toHaveProperty(['specs.0']);
  });

  it('số chuẩn hoá, ngày sai dạng → 422; chữ quá 2000 ký tự → 422', async () => {
    const num = await createField({ name: uniq('Độ dày'), input: 'number', unit: 'mm', allowCustom: false });
    const date = await createField({ name: uniq('Ngày'), input: 'date', allowCustom: false });
    const txt = await createField({ name: uniq('Ghi chú'), input: 'text', allowCustom: false });
    const group = await groupNamed('Khác');
    const res = await createSimpleProduct(group.id, { specs: [{ fieldId: num.id, value: '1.50' }, { fieldId: date.id, value: '2026-01-31' }] });
    ok(res, 201);
    const specs = ProductDetail.parse(res.body).specs;
    expect(specs.find((s) => s.fieldId === num.id)!.value).toBe('1.5');
    expect(specs.find((s) => s.fieldId === date.id)!.value).toBe('2026-01-31');
    problem(await createSimpleProduct(group.id, { specs: [{ fieldId: date.id, value: '31/01/2026' }] }), 422, 'validation_failed');
    problem(await createSimpleProduct(group.id, { specs: [{ fieldId: txt.id, value: 'a'.repeat(2001) }] }), 422, 'validation_failed');
  });

  it('cổng getProductSpecs, getSpecFields; getVariants có platformKind của trục', async () => {
    const group = await groupNamed('Thời trang nam');
    const tpl = GroupTemplate.parse((await api(token).get(`/groups/${group.id}/template`)).body);
    const material = tpl.fields.find((f) => f.code === 'chat_lieu')!;
    const color = tpl.axes[0]!;
    const res = await api(token).post('/products', {
      name: uniq('Áo cổng'),
      groupId: group.id,
      axes: [{ attributeId: color.attributeId, values: [{ id: color.values[0]!.id, value: color.values[0]!.value }] }],
      variants: [{ options: [color.values[0]!.value] }],
      specs: [{ fieldId: material.fieldId, optionIds: [material.options[0]!.id] }],
    });
    ok(res, 201);
    const detail = ProductDetail.parse(res.body);
    await withCompany(companyId, async () => {
      const specs = (await getProductSpecs([detail.id])).get(detail.id)!;
      expect(specs.groupId).toBe(group.id);
      expect(specs.values.find((v) => v.code === 'chat_lieu')).toMatchObject({ optionIds: [material.options[0]!.id], optionLabels: [material.options[0]!.value] });
      expect((await getSpecFields()).some((f) => f.code === 'chat_lieu')).toBe(true);
    });
    // Role chủ bảng: lọc công ty tường minh, trả dòng nền tảng và của công ty, không trả thông số công ty khác.
    const own = await getSpecFields({ companyId });
    const ids = new Set(
      (await testPool().query('select id from product.spec_fields where company_id = $1 or company_id is null', [companyId])).rows.map((r) => r.id),
    );
    expect(own.length).toBe(ids.size);
    expect(own.every((f) => ids.has(f.id))).toBe(true);
    await expect(getSpecFields()).rejects.toThrow();
    await withCompany(companyId, async () => {
      const [variant] = await getVariants([detail.variants[0]!.id]);
      expect(variant!.attributes[0]).toMatchObject({ platformKind: 'color' });
    });
  });

  it('thông số, nhóm của công ty khác → 404 / 422, không lộ', async () => {
    const other = await createCompany();
    const theirsRes = await api(other.ceo.token).post('/spec-fields', { name: uniq('Của họ'), input: 'text', allowCustom: false });
    ok(theirsRes, 201);
    const theirs = theirsRes.body as { id: string; version: number };
    problem(await api(token).delete(`/spec-fields/${theirs.id}?version=${theirs.version}`), 404, 'not_found');
    const group = await groupNamed('Khác');
    const bad = await createSimpleProduct(group.id, { specs: [{ fieldId: theirs.id, value: 'x' }] });
    problem(bad, 422, 'validation_failed');
    const otherGroupRes = await api(other.ceo.token).post('/groups', { name: uniq('Nhóm họ') });
    ok(otherGroupRes, 201);
    const otherGroup = otherGroupRes.body as { id: string };
    problem(await api(token).get(`/groups/${otherGroup.id}/template`), 404, 'not_found');
    const rows = await testPool().query('select count(*)::int as n from product.product_spec_values where company_id = $1 and field_id = $2', [companyId, theirs.id]);
    expect(rows.rows[0].n).toBe(0);
  });
});

async function fileRow(owner: string, purpose: 'product_image' | 'attachment' = 'product_image') {
  const id = randomUUID();
  await testPool().query(
    `insert into core.files (id, company_id, storage_key, file_name, content_type, size_bytes, purpose, uploaded_at)
     values ($1, $2, $3, 'anh.png', 'image/png', 2048, $4, now())`,
    [id, owner, `test/${id}.png`, purpose],
  );
  return id;
}

describe('POST /catalog/products: ảnh phân loại, giá và số đo lúc tạo (#510, Documents/21 mục 5.5)', () => {
  beforeAll(() => setHeadObject(async () => null));
  afterAll(() => setHeadObject(null));

  it('imageAxis + imageFileId gắn ảnh cho giá trị mới tạo (một phần giá trị); giá, cân nặng, kích thước lưu theo SKU', async () => {
    const group = await groupNamed('Khác');
    const fileId = await fileRow(companyId);
    const res = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [{ name: uniq('Màu ly').slice(0, 15), values: [{ value: 'Đỏ', imageFileId: fileId }, { value: 'Lam' }] }],
      imageAxis: 0,
      variants: [
        { options: ['Đỏ'], standardPrice: 120000, targetNetPrice: 90000, weightG: 250, lengthMm: 100, widthMm: 80, heightMm: 120 },
        { options: ['Lam'] },
      ],
    });
    ok(res, 201);
    const d = ProductDetail.parse(res.body);
    const red = d.variants.find((v) => v.attributes[0]!.value === 'Đỏ')!;
    expect(d.imageAttributeId).toBe(red.attributes[0]!.attributeId);
    expect(d.attributeValueImages).toEqual([{ attributeValueId: red.attributes[0]!.valueId, fileId, url: expect.any(String) }]);
    expect(red).toMatchObject({ standardPrice: 120000, targetNetPrice: 90000, weightG: 250, lengthMm: 100, widthMm: 80, heightMm: 120 });
    expect(d.variants.find((v) => v !== red)).toMatchObject({ standardPrice: null, weightG: null });
  });

  it('imageFileId ở trục không phải imageAxis, imageAxis ngoài số trục → 422 đúng ô; tệp không phải ảnh sản phẩm → 422 ở giá trị', async () => {
    const group = await groupNamed('Khác');
    const fileId = await fileRow(companyId);
    const noAxis = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [{ name: 'Màu', values: [{ value: 'Đỏ', imageFileId: fileId }] }],
      variants: [{ options: ['Đỏ'] }],
    });
    problem(noAxis, 422, 'validation_failed');
    expect(noAxis.body.errors).toHaveProperty(['axes.0.values.0.imageFileId']);
    const outside = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [{ name: 'Màu', values: [{ value: 'Đỏ' }] }],
      imageAxis: 1,
      variants: [{ options: ['Đỏ'] }],
    });
    problem(outside, 422, 'validation_failed');
    expect(outside.body.errors).toHaveProperty('imageAxis');
    const attachment = await fileRow(companyId, 'attachment');
    const wrongFile = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [{ name: 'Màu', values: [{ value: 'Đỏ' }, { value: 'Lam', imageFileId: attachment }] }],
      imageAxis: 0,
      variants: [{ options: ['Đỏ'] }, { options: ['Lam'] }],
    });
    problem(wrongFile, 422, 'validation_failed');
    expect(wrongFile.body.errors).toHaveProperty(['axes.0.values.1.imageFileId']);
    problem(
      await api(token).post('/products', { name: uniq('Ly'), groupId: group.id, axes: [], variants: [{ options: [], weightG: 0 }] }),
      422,
      'validation_failed',
    );
  });

  it('trần số đo như PATCH SKU (#434): đúng 50.000 g, 2.000 mm → 201; vượt → 422 báo tại ô của SKU', async () => {
    const group = await groupNamed('Khác');
    const atCap = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [],
      variants: [{ options: [], weightG: 50_000, lengthMm: 2_000, widthMm: 2_000, heightMm: 2_000 }],
    });
    ok(atCap, 201);
    expect(ProductDetail.parse(atCap.body).variants[0]).toMatchObject({ weightG: 50_000, lengthMm: 2_000, widthMm: 2_000, heightMm: 2_000 });
    const over = await api(token).post('/products', {
      name: uniq('Ly'),
      groupId: group.id,
      axes: [],
      variants: [{ options: [], weightG: 50_001, lengthMm: 2_000, widthMm: 2_001, heightMm: 2_000 }],
    });
    problem(over, 422, 'validation_failed');
    expect(over.body.errors).toEqual({ 'variants.0.weightG': 'Cân nặng tối đa 50 kg', 'variants.0.widthMm': 'Chiều rộng tối đa 2.000 mm' });
  });
});
