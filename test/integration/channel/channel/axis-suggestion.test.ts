// Gợi ý ghép trục phân loại với sales attribute của sàn (#448 L5, Documents/21 §18.8.3): `GET …/specs/:platform?categoryId`
// trả suggestedAxisMap, suggestedValueMap, variantCapabilities; lần `PUT` đầu điền trục còn thiếu; `__custom` ở sàn không nhận
// tên tự đặt là 422; `missing` thêm axis_shape. Cổng product thật (platformKind từ catalog).
// Khe `lazada` dùng caps giả của một sàn KHÔNG nhận tên tự đặt và `maxAxes` theo số sale prop của leaf (nhánh chung cho sàn sau
// này): Lazada thật nhận tên tự đặt, `maxAxes` 2 từ #572, caps thật kiểm ở unit `variant-capabilities.test.ts`.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductSpecView } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { lazadaVariantCapabilities } from '#src/modules/channel/channel/service/marketplaces/lazada-categories.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());

registerAdapter(
  'lazada',
  fakeAdapter({
    categoriesNeedToken: false,
    standardSalesAttributes: { color: ['color_family'], size: ['size'] },
    variantCapabilities: (l) => ({
      ...lazadaVariantCapabilities(l),
      maxAxes: l.filter((a) => a.kind === 'sales').length,
      customAxisName: false,
      maxAxisNameLength: null,
    }),
    leafAttributes: async () => [],
  }),
);
registerAdapter(
  'tiktok',
  fakeAdapter({
    categoriesNeedToken: false,
    standardSalesAttributes: { color: ['100000'], size: ['100007'] },
    // Tên tự đặt tối đa 5 ký tự để "Kích cỡ" (7) vượt: kiểm `axis_name_too_long` (#572).
    variantCapabilities: () => ({ maxAxes: 3, customAxisName: true, salesRequired: [], addVariant: true, maxValueLength: null, maxAxisValues: null, maxAxisNameLength: 5 }),
    leafAttributes: async () => [],
  }),
);

const sfx = randomUUID().slice(0, 8);
const leafs = {
  lzFull: `AXS-LZ-${sfx}`,
  lzNoSize: `AXS-LZN-${sfx}`,
  lzAlt: `AXS-LZA-${sfx}`,
  lzFree: `AXS-LZF-${sfx}`,
  ttColor: `AXS-TT-${sfx}`,
  branch: `AXS-BR-${sfx}`,
};
let ceo: { token: string; companyId: string };
let colorAttr: string;
let sizeAttr: string;
let productId: string;
let redId: string;
let mId: string;

async function leaf(platform: string, id: string, attrs: { code: string; label: string; allowCustom?: boolean }[]) {
  const q = testPool();
  await q.query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at, attributes_fetched_at)
     values ($1, $2, $2, true, $2, lower($2), now(), now())`,
    [platform, id],
  );
  for (const a of attrs) {
    const options = a.code === 'color_family' ? [{ id: '10', label: 'Đỏ' }, { id: '11', label: 'Xanh' }] : [];
    await q.query(
      `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, options, allow_custom, tier, fetched_at)
       values ($1, $2, $3, $4, 'sales', 'select', $5, $6, 'category', now())`,
      [platform, id, a.code, a.label, JSON.stringify(options), a.allowCustom ?? false],
    );
  }
}

const bindValues = async (variantId: string, ids: string[]) => {
  for (const [i, id] of ids.entries()) {
    await testPool().query(
      'insert into product.variant_attribute_values (variant_id, attribute_value_id, position, company_id) values ($1, $2, $3, $4)',
      [variantId, id, i, ceo.companyId],
    );
  }
};

beforeAll(async () => {
  const q = testPool();
  const c = await createCompany({ optionalModules: [] });
  ceo = { token: c.ceo.token, companyId: c.companyId };
  // Thuộc tính chuẩn là dòng nền tảng dùng chung (#521).
  const attrs = await q.query('select id, platform_kind from product.attributes where company_id is null');
  colorAttr = attrs.rows.find((r) => r.platform_kind === 'color').id;
  sizeAttr = attrs.rows.find((r) => r.platform_kind === 'size').id;
  const v = await createVariant(c.companyId);
  productId = v.productId;
  // Công ty mới có sẵn giá trị mặc định cho Màu sắc, Kích cỡ: dùng lại nếu có, không thì tạo.
  const val = async (attributeId: string, value: string, code: string) => {
    const found = await q.query('select id from product.attribute_values where attribute_id = $1 and lower(value) = lower($2)', [attributeId, value]);
    if (found.rows[0]) return found.rows[0].id as string;
    return (
      await q.query('insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4) returning id', [c.companyId, attributeId, value, code])
    ).rows[0].id as string;
  };
  redId = await val(colorAttr, 'Đỏ', 'DOT');
  mId = await val(sizeAttr, 'M', 'MM');
  await bindValues(v.variantId, [redId, mId]);
  await leaf('lazada', leafs.lzFull, [
    { code: 'color_family', label: 'Màu' },
    { code: 'size', label: 'Kích cỡ' },
  ]);
  await leaf('lazada', leafs.lzNoSize, [{ code: 'color_family', label: 'Màu' }]);
  await leaf('lazada', leafs.lzFree, [{ code: 'color_family', label: 'Màu', allowCustom: true }]);
  await leaf('lazada', leafs.lzAlt, [
    { code: 'color_family', label: 'Màu' },
    { code: `alt_${sfx}`, label: 'Màu khác' },
    { code: 'size', label: 'Kích cỡ' },
  ]);
  await leaf('tiktok', leafs.ttColor, [{ code: '100000', label: 'Màu sắc' }]);
  await q.query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at, attributes_fetched_at)
     values ('lazada', $1, 'Nhánh', false, 'Nhánh', 'nhanh', now(), now())`,
    [leafs.branch],
  );
});

const get = (platform: string, query = '') =>
  request(app).get(`/api/v1/channel/products/${productId}/specs/${platform}${query}`).set('Authorization', `Bearer ${ceo.token}`);
const put = (platform: string, body: object) =>
  request(app).put(`/api/v1/channel/products/${productId}/specs/${platform}`).set('Authorization', `Bearer ${ceo.token}`).send(body);

describe('gợi ý ghép trục', () => {
  it('chưa có leaf: ba trường null', async () => {
    const res = await get('lazada');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ spec: null, resolved: {}, missing: [], remote: null, suggestedAxisMap: null, suggestedValueMap: null, variantCapabilities: null });
  });

  it('Lazada ?categoryId: Màu → color_family, Kích cỡ → size, giá trị Đỏ → 10; caps không nhận tên tự đặt', async () => {
    const res = await get('lazada', `?categoryId=${leafs.lzFull}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    ProductSpecView.parse(res.body);
    expect(res.body.spec).toBeNull();
    expect(res.body.suggestedAxisMap).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'size' });
    expect(res.body.suggestedValueMap).toEqual({ [redId]: '10' });
    // Hai sale prop chỉ nhận lựa chọn có sẵn (allow_custom mặc định false): không có đích ghép (#568)
    expect(res.body.variantCapabilities).toEqual({
      maxAxes: 2,
      customAxisName: false,
      salesRequired: [],
      addVariant: true,
      maxValueLength: 20,
      maxAxisValues: 50,
      maxAxisNameLength: null,
      combineTarget: null,
    });
  });

  it('TikTok leaf chỉ có 100000: trục size thành __custom', async () => {
    const res = await get('tiktok', `?categoryId=${leafs.ttColor}`);
    expect(res.body.suggestedAxisMap).toEqual({ [colorAttr]: '100000', [sizeAttr]: '__custom' });
    expect(res.body.variantCapabilities).toEqual({
      maxAxes: 3,
      customAxisName: true,
      salesRequired: [],
      addVariant: true,
      maxValueLength: null,
      maxAxisValues: null,
      maxAxisNameLength: 5,
      combineTarget: null,
    });
  });

  it('Lazada leaf không có size: không gợi ý trục size (không __custom)', async () => {
    const res = await get('lazada', `?categoryId=${leafs.lzNoSize}`);
    expect(res.body.suggestedAxisMap).toEqual({ [colorAttr]: 'color_family' });
  });

  it('mã công ty cấu hình (axis_mappings) thắng mặc định của adapter', async () => {
    await testPool().query(
      `insert into channel.axis_mappings (company_id, attribute_id, platform, attribute_code, priority) values ($1, $2, 'lazada', $3, 1)`,
      [ceo.companyId, colorAttr, `alt_${sfx}`],
    );
    const res = await get('lazada', `?categoryId=${leafs.lzAlt}`);
    expect(res.body.suggestedAxisMap).toEqual({ [colorAttr]: `alt_${sfx}`, [sizeAttr]: 'size' });
    await testPool().query('delete from channel.axis_mappings where company_id = $1', [ceo.companyId]);
  });

  it('?categoryId không phải lá: 422 errors.categoryId', async () => {
    const res = await get('lazada', `?categoryId=${leafs.branch}`);
    expect(res.status).toBe(422);
    expect(res.body.errors.categoryId).toBeDefined();
  });

  it('PUT lần đầu điền trục, giá trị còn thiếu theo gợi ý', async () => {
    const res = await put('lazada', { externalCategoryId: leafs.lzFull, attributes: {}, version: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.spec.axisMap).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'size' });
    expect(res.body.spec.valueMap).toEqual({ [redId]: '10' });
    expect(res.body.missing).toEqual([]);
    // Spec đã có: gợi ý tính theo leaf của spec.
    expect((await get('lazada')).body.suggestedAxisMap).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'size' });
  });

  it('Lazada: PUT __custom 422 errors["axisMap.<id>"]; trục không gợi ý được mà không gửi cũng 422', async () => {
    const bad = await put('lazada', { externalCategoryId: leafs.lzFull, attributes: {}, axisMap: { [sizeAttr]: '__custom' }, version: 5 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors[`axisMap.${sizeAttr}`]).toBe('Sàn này không nhận tên trục tự đặt, chọn thuộc tính phân loại của sàn');
    const noSize = await put('lazada', { externalCategoryId: leafs.lzNoSize, attributes: {}, version: null });
    expect(noSize.status).toBe(422);
    expect(noSize.body.errors[`axisMap.${sizeAttr}`]).toBeDefined();
  });

  it('TikTok PUT lần đầu: size ra __custom, lưu được; tên tự đặt dài hơn maxAxisNameLength báo axis_name_too_long', async () => {
    const res = await put('tiktok', { externalCategoryId: leafs.ttColor, attributes: {}, version: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.spec.axisMap).toEqual({ [colorAttr]: '100000', [sizeAttr]: '__custom' });
    expect(res.body.missing).toEqual([
      { code: sizeAttr, label: 'Tên thuộc tính biến thể “Kích cỡ” dài 7 ký tự, Sàn giả nhận tối đa 5', reason: 'axis_name_too_long' },
    ]);
  });

  it('missing: spec Lazada có __custom (dữ liệu cũ) báo axis_unmapped; nhiều trục hơn leaf nhận báo axis_shape', async () => {
    const other = await createVariant(ceo.companyId);
    await bindValues(other.variantId, [redId, mId]);
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, axis_map, source, version)
       values ($1, $2, 'lazada', $3, $4, 'push', 1)`,
      [ceo.companyId, other.productId, leafs.lzNoSize, JSON.stringify({ [colorAttr]: 'color_family', [sizeAttr]: '__custom' })],
    );
    const res = await request(app).get(`/api/v1/channel/products/${other.productId}/specs/lazada`).set('Authorization', `Bearer ${ceo.token}`);
    expect(res.status).toBe(200);
    expect(res.body.missing).toEqual(
      expect.arrayContaining([
        { code: sizeAttr, label: 'Kích cỡ', reason: 'axis_unmapped' },
        { code: 'axes', label: 'Sản phẩm có 2 trục, category này nhận tối đa 1', reason: 'axis_shape' },
      ]),
    );
  });

  describe('thuộc tính biến thể ghép (#568)', () => {
    let other: string;
    beforeAll(async () => {
      const v = await createVariant(ceo.companyId);
      await bindValues(v.variantId, [redId, mId]);
      other = v.productId;
    });
    const putOther = (body: object) =>
      request(app).put(`/api/v1/channel/products/${other}/specs/lazada`).set('Authorization', `Bearer ${ceo.token}`).send(body);

    it('leaf một sale prop nhận chữ: GET trả combineTarget, PUT lần đầu ghép hai trục, không valueMap, không missing', async () => {
      const view = await request(app)
        .get(`/api/v1/channel/products/${other}/specs/lazada?categoryId=${leafs.lzFree}`)
        .set('Authorization', `Bearer ${ceo.token}`);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      expect(view.body.variantCapabilities).toMatchObject({ maxAxes: 1, combineTarget: 'color_family', maxValueLength: 20, maxAxisValues: 50, maxAxisNameLength: null });
      expect(view.body.suggestedAxisMap).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'color_family' });
      const res = await putOther({ externalCategoryId: leafs.lzFree, attributes: {}, version: null });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.spec.axisMap).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'color_family' });
      expect(res.body.spec.valueMap).toEqual({});
      expect(res.body.missing).toEqual([]);
    });

    it('valueMap trên trục ghép: 422 errors["valueMap.<id>"]; ghép vào leaf chỉ nhận lựa chọn có sẵn: 422 từng trục', async () => {
      const current = (await request(app).get(`/api/v1/channel/products/${other}/specs/lazada`).set('Authorization', `Bearer ${ceo.token}`)).body.spec;
      const both = { [colorAttr]: 'color_family', [sizeAttr]: 'color_family' };
      const withValue = await putOther({ externalCategoryId: leafs.lzFree, attributes: {}, axisMap: both, valueMap: { [redId]: '10' }, version: current.version });
      expect(withValue.status).toBe(422);
      expect(withValue.body.errors[`valueMap.${redId}`]).toBeDefined();
      const fixed = await putOther({ externalCategoryId: leafs.lzNoSize, attributes: {}, axisMap: both, version: current.version });
      expect(fixed.status).toBe(422);
      expect(Object.keys(fixed.body.errors)).toEqual(expect.arrayContaining([`axisMap.${colorAttr}`, `axisMap.${sizeAttr}`]));
    });
  });
});
