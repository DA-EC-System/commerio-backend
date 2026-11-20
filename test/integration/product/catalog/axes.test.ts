import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { api, type AttributeBody, auditOf, createAttribute, createGroup, setSkuPattern, uniq } from './helpers.ts';

// Tạo sản phẩm với trục phân loại khai ngay trong form (#447; Documents/21 mục 5.2, K16, B1).

interface Attr {
  id: string;
  name: string;
  platformKind: 'color' | 'size' | null;
  values: { id: string; value: string; code: string }[];
}

const attrs = async (token: string) => (await api(token).get('/attributes')).body as Attr[];

/**
 * SKU quá 50 ký tự: mẫu tối đa 40 ký tự, mã giá trị tối đa 6, nên qua API SKU dài nhất là 28 chữ + 9 số + 13 = 50. Chỉ
 * vượt khi số {SEQ} có từ 10 chữ số: mẫu 28 chữ + `{SEQ:1}{VAL}` (40 ký tự), số kế tiếp đặt thẳng DB 1e9 (cột chỉ đọc
 * qua API), hai mã 6 ký tự → 28 + 10 + 13 = 51.
 */
async function longSkuSettings(token: string, companyId: string) {
  await setSkuPattern(token, `${'A'.repeat(28)}{SEQ:1}{VAL}`);
  await testPool().query('update product.company_product_settings set sku_next_seq = 1000000000 where company_id = $1', [companyId]);
}

/** Công ty mới có "Màu sắc" (color) và "Kích cỡ" (size) do seed; trả token, nhóm đầu, hai thuộc tính đó. */
async function freshCompany() {
  const { ceo, companyId } = await createCompany();
  const group = (await api(ceo.token).get('/groups')).body.items[0] as { id: string; name: string };
  const all = await attrs(ceo.token);
  return { companyId, token: ceo.token, group, color: all.find((a) => a.platformKind === 'color')!, size: all.find((a) => a.platformKind === 'size')! };
}

const body = (name: string, groupId: string, axes: object[], variants: string[][], extra: object = {}) => ({
  name,
  groupId,
  description: '',
  imageFileIds: [],
  axes,
  variants: variants.map((options) => ({ options })),
  ...extra,
});

describe('POST /catalog/products với axes (AC-2, AC-S8)', () => {
  it('trục có sẵn + giá trị mới, trục tên mới → 201, tạo thuộc tính và giá trị, SKU theo mẫu công ty; đọc lại GET', async () => {
    const { token, group, color } = await freshCompany();
    const den = color.values.find((v) => v.value === 'Đen')!;
    const res = await api(token).post(
      '/products',
      body(
        uniq('Áo'),
        group.id,
        [
          { attributeId: color.id, values: [{ id: den.id, value: 'Đen' }, { value: 'Xanh rêu' }] },
          { name: 'Hoạ tiết', values: [{ value: 'Trơn' }, { value: 'Kẻ caro' }] },
        ],
        [
          ['Đen', 'Trơn'],
          ['xanh rêu ', 'Kẻ caro'],
        ],
      ),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.variants.map((v: { sku: string }) => v.sku)).toEqual(['SP00001-DEN-TRON', 'SP00002-XANHRE-KECARO']);
    const after = await attrs(token);
    const pattern = after.find((a) => a.name === 'Hoạ tiết')!;
    expect(pattern).toMatchObject({ platformKind: null, values: [{ value: 'Trơn', code: 'TRON' }, { value: 'Kẻ caro', code: 'KECARO' }] });
    expect(after.find((a) => a.id === color.id)!.values.at(-1)).toMatchObject({ value: 'Xanh rêu', code: 'XANHRE' });
    const detail = await api(token).get(`/products/${res.body.id}`);
    expect(detail.body.variants[1].attributes.map((a: { value: string }) => a.value)).toEqual(['Xanh rêu', 'Kẻ caro']);
    expect((await auditOf(res.body.id))[0]).toMatchObject({ action: 'create', after: { group: group.name } });
  });

  it('trục chỉ có tên trùng thuộc tính có sẵn ("màu sắc" chữ thường) dùng lại thuộc tính đó; giá trị trùng giá trị có sẵn dùng lại (AC-S8, AC-S12)', async () => {
    const { token, group, color } = await freshCompany();
    const res = await api(token).post('/products', body(uniq('Áo'), group.id, [{ name: 'màu sắc', values: [{ value: 'đen' }] }], [['đen']]));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = await attrs(token);
    expect(after).toHaveLength(4);
    expect(after.find((a) => a.id === color.id)!.values).toHaveLength(8);
    expect(res.body.variants[0].attributes[0]).toMatchObject({ value: 'Đen' });
  });

  it('không trục → một biến thể `options: []`', async () => {
    const { token, group } = await freshCompany();
    const res = await api(token).post('/products', body(uniq('Ly'), group.id, [], [[]]));
    expect(res.status).toBe(201);
    expect(res.body.variants).toHaveLength(1);
    expect(res.body.variants[0].sku).toBe('SP00001');
  });

  it('giá trị mới sinh mã trùng mã đang có hoặc rỗng → BE thêm hậu tố (B1)', async () => {
    const { token, group, color } = await freshCompany();
    const res = await api(token).post(
      '/products',
      body(uniq('Áo'), group.id, [{ attributeId: color.id, values: [{ value: 'Xanh dưa' }, { value: '★' }, { value: '☆' }] }], [['Xanh dưa'], ['★'], ['☆']]),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = (await attrs(token)).find((a) => a.id === color.id)! as Attr & { version: number };
    // Thuộc tính có sẵn thêm giá trị qua form: version tăng để form sửa thuộc tính đang mở nhận 409.
    expect(after.version).toBe((color as Attr & { version: number }).version + 1);
    const values = after.values;
    expect(values.slice(-3).map((v) => [v.value, v.code])).toEqual([
      ['Xanh dưa', 'XANHD2'],
      ['★', 'V1'],
      ['☆', 'V2'],
    ]);
  });
});

describe('POST /catalog/products: luật trục, lỗi theo ô (AC-3, AC-4)', () => {
  let ctx: Awaited<ReturnType<typeof freshCompany>>;
  beforeAll(async () => {
    ctx = await freshCompany();
  });

  const post = (axes: object[], variants: string[][], extra: object = {}) => api(ctx.token).post('/products', body(uniq('SP'), ctx.group.id, axes, variants, extra));

  it.each([
    ['tên trục 16 ký tự', [{ name: 'x'.repeat(16), values: [{ value: 'A' }] }], [['A']], 'axes.0.name'],
    ['giá trị 21 ký tự', [{ name: 'Mùi', values: [{ value: 'y'.repeat(21) }] }], [['y'.repeat(21)]], 'axes.0.values.0.value'],
    ['51 giá trị một trục', [{ name: 'Số', values: Array.from({ length: 51 }, (_, i) => ({ value: `G${i}` })) }], [['G0']], 'axes.0.values'],
    ['giá trị trùng trong trục', [{ name: 'Mùi', values: [{ value: 'Cam' }, { value: ' cam' }] }], [['Cam']], 'axes.0.values'],
    ['hai trục cùng tên', [{ name: 'Mùi', values: [{ value: 'Cam' }] }, { name: 'mùi', values: [{ value: 'Dâu' }] }], [['Cam', 'Dâu']], 'axes'],
    ['3 trục', [1, 2, 3].map((i) => ({ name: `T${i}`, values: [{ value: 'A' }] })), [['A', 'A', 'A']], 'axes'],
    ['`options` không khớp trục', [{ name: 'Mùi', values: [{ value: 'Cam' }] }], [['Dâu']], 'variants.0'],
    ['thiếu option', [{ name: 'Mùi', values: [{ value: 'Cam' }] }], [[]], 'variants.0'],
    ['không trục mà hai biến thể', [], [[], []], 'variants'],
    ['trục không có tên, không có attributeId', [{ values: [{ value: 'A' }] }], [['A']], 'axes.0.name'],
  ])('%s → 422 errors[%j]', async (_case, axes, variants, field) => {
    const res = await post(axes, variants);
    expect(res.status).toBe(422);
    expect(res.body.errors[field as string], JSON.stringify(res.body.errors)).toBeTruthy();
  });

  it('hai trục cùng một thuộc tính (id và tên) → errors.axes; thuộc tính, giá trị của công ty khác → 422 theo ô', async () => {
    const twice = await post(
      [
        { attributeId: ctx.color.id, values: [{ value: 'Đen' }] },
        { name: ctx.color.name, values: [{ value: 'Trắng' }] },
      ],
      [['Đen', 'Trắng']],
    );
    expect(twice.status).toBe(422);
    expect(twice.body.errors.axes).toBeTruthy();

    const other = await freshCompany();
    const foreignAttr = await post([{ attributeId: other.color.id, values: [{ value: 'Đen' }] }], [['Đen']]);
    expect(foreignAttr.body.errors['axes.0.name']).toBeTruthy();
    const foreignValue = await post([{ attributeId: ctx.color.id, values: [{ id: other.color.values[0]!.id, value: 'Đen' }] }], [['Đen']]);
    expect(foreignValue.body.errors['axes.0.values.0.value']).toBeTruthy();
    expect((await post([{ attributeId: randomUUID(), values: [{ value: 'A' }] }], [['A']])).body.errors['axes.0.name']).toBeTruthy();
  });

  it('gửi `id` kèm `value` khác chữ đang lưu → 422 errors["axes.0.values.0.value"], không để `id` lặng lẽ thắng', async () => {
    const den = ctx.color.values.find((v) => v.value === 'Đen')!;
    const res = await post([{ attributeId: ctx.color.id, values: [{ id: den.id, value: 'Đỏ' }] }], [['Đỏ']]);
    expect(res.status).toBe(422);
    expect(res.body.errors['axes.0.values.0.value']).toBe('Giá trị đang lưu là "Đen"');
  });

  it('SKU sinh ra quá 50 ký tự → 422 errors["variants.0"], thuộc tính, giá trị vừa tạo bị rollback (AC-3)', async () => {
    const { token, group, companyId } = await freshCompany();
    await longSkuSettings(token, companyId);
    const res = await api(token).post(
      '/products',
      body(
        uniq('Áo'),
        group.id,
        [
          { name: 'Hoạ tiết', values: [{ value: 'Kẻ caro' }] },
          { name: 'Màu nền', values: [{ value: 'Xanh rêu' }] },
        ],
        [['Kẻ caro', 'Xanh rêu']],
      ),
    );
    expect(res.status).toBe(422);
    expect(res.body.errors['variants.0']).toBe('SKU sinh ra quá 50 ký tự, sửa mẫu SKU ở Cài đặt sản phẩm');
    const names = (await attrs(token)).map((a) => a.name);
    expect(names).not.toContain('Hoạ tiết');
    expect(names).not.toContain('Màu nền');
    expect((await api(token).get('/settings')).body.skuNextSeq).toBe(1000000000);
  });

  it('thêm biến thể sinh SKU quá 50 ký tự → 422 errors.attributeValueIds (B4)', async () => {
    const { token, group, companyId } = await freshCompany();
    const pattern = (await createAttribute(token, 'Hoạ tiết', ['Kẻ caro', 'Chấm bi'])) as AttributeBody;
    const ground = (await createAttribute(token, 'Màu nền', ['Xanh rêu'])) as AttributeBody;
    const axes = [
      { attributeId: pattern.id, values: [{ value: 'Kẻ caro' }, { value: 'Chấm bi' }] },
      { attributeId: ground.id, values: [{ value: 'Xanh rêu' }] },
    ];
    const created = await api(token).post('/products', body(uniq('Áo'), group.id, axes, [['Kẻ caro', 'Xanh rêu']]));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await longSkuSettings(token, companyId);
    const res = await api(token).post(`/products/${created.body.id}/variants`, {
      attributeValueIds: [pattern.values[1]!.id, ground.values[0]!.id],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors.attributeValueIds).toBe('SKU sinh ra quá 50 ký tự, sửa mẫu SKU ở Cài đặt sản phẩm');
  });
});

describe('PUT /catalog/products/:id đổi nhóm hàng (AC-S3)', () => {
  it('gửi `groupId` → đổi nhóm, SKU giữ nguyên, version +1; nhóm của công ty khác → 422 errors.groupId', async () => {
    const { token, group } = await freshCompany();
    const target = await createGroup(token, uniq('Đích'), null);
    const created = await api(token).post('/products', body(uniq('Ly'), group.id, [], [[]]));
    const product = created.body;
    const moved = await api(token).put(`/products/${product.id}`, { name: product.name, description: '', groupId: target.id, version: product.version });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(moved.body).toMatchObject({ group: { id: target.id, name: target.name }, version: product.version + 1 });
    expect(moved.body.variants[0].sku).toBe(product.variants[0].sku);
    expect((await auditOf(product.id)).at(-1)).toMatchObject({ before: { group: group.name }, after: { group: target.name } });

    const other = await freshCompany();
    const foreign = await api(token).put(`/products/${product.id}`, { name: product.name, description: '', groupId: other.group.id, version: product.version + 1 });
    expect(foreign.status).toBe(422);
    expect(foreign.body.errors.groupId).toBeTruthy();
  });
});
