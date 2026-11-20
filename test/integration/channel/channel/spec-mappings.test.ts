// Ánh xạ thông số sang sàn và tự điền khi đọc spec (#509, Documents/21 §18.8.1–18.8.2): seed mặc định khi tạo công ty, thay tập
// mã, mã đã thuộc thông số khác, xoá mã thì xoá ánh xạ lựa chọn (cascade), công ty khác, `resolved` lấy thông số catalog qua
// ánh xạ, ghi đè thắng, `PUT` không lưu giá trị trùng catalog.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SpecMappingList, SpecMappingSchema } from '#src/modules/channel/channel/api/schemas.ts';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());

const tag = randomUUID().slice(0, 8);
// Mã attribute riêng của lượt chạy: bảng attribute leaf dùng chung mọi file test.
const MATERIAL = `t509_material_${tag}`;
const MATERIAL2 = `t509_material2_${tag}`;
const STYLE = `t509_style_${tag}`;

const attr = (code: string, extra: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input: 'text',
  options: [],
  allowCustom: false,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...extra,
});

const leafAttrs = [
  attr(MATERIAL, { label: 'Chất liệu', input: 'multiselect', options: [{ id: 'm1', label: 'Bông' }, { id: 'm2', label: 'Polyester' }] }),
  attr(STYLE, { label: 'Phong cách', required: true, allowCustom: true }),
];
registerAdapter('lazada', fakeAdapter({ categoriesNeedToken: false, leafAttributes: async () => leafAttrs }));

const leaf = `LEAF509-${tag}`;
let ceo: { token: string; companyId: string };
let other: { token: string; companyId: string };
let productId: string;
let materialField: { id: string; cotton: string; poly: string };
let styleField: string;

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function field(companyId: string, code: string, input: string, options: string[] = []) {
  const db = testPool();
  const { rows } = await db.query<{ id: string }>(
    `insert into catalog.spec_fields (company_id, code, name, input, allow_custom) values ($1, $2, $3, $4, false) returning id`,
    [companyId, `${code}_${tag}`, `${code} ${tag}`, input],
  );
  const ids: string[] = [];
  for (const [i, value] of options.entries()) {
    const r = await db.query<{ id: string }>(
      `insert into catalog.spec_field_options (company_id, field_id, value, position) values ($1, $2, $3, $4) returning id`,
      [companyId, rows[0]!.id, value, i + 1],
    );
    ids.push(r.rows[0]!.id);
  }
  return { id: rows[0]!.id, options: ids };
}

beforeAll(async () => {
  const db = testPool();
  await db.query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at, attributes_fetched_at)
     values ('lazada', $1, 'Áo', true, 'Áo', 'ao', now(), now())`,
    [leaf],
  );
  for (const a of leafAttrs) {
    await db.query(
      `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, options, allow_custom, required, tier, fetched_at)
       values ('lazada', $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [leaf, a.code, a.label, a.kind, a.input, JSON.stringify(a.options), a.allowCustom, a.required, a.tier],
    );
  }
  // Mã thứ hai của Chất liệu chỉ có ở leaf khác (một thông số nhiều mã theo category).
  const leaf2 = `LEAF509B-${tag}`;
  await db.query(`insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at) values ('lazada', $1, 'Quần', true, 'Quần', 'quan', now())`, [leaf2]);
  await db.query(
    `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, options, tier, fetched_at)
     values ('lazada', $1, $2, 'Chất liệu vải', 'property', 'select', '[{"id":"x1","label":"Bông"}]', 'category', now())`,
    [leaf2, MATERIAL2],
  );
  const c = await createCompany({ optionalModules: [] });
  ceo = { token: c.ceo.token, companyId: c.companyId };
  const o = await createCompany({ optionalModules: [] });
  other = { token: o.ceo.token, companyId: o.companyId };
  const m = await field(c.companyId, 'chat_lieu_t', 'multiselect', ['Cotton', 'Polyester']);
  materialField = { id: m.id, cotton: m.options[0]!, poly: m.options[1]! };
  styleField = (await field(c.companyId, 'phong_cach_t', 'text')).id;
  productId = (await createVariant(c.companyId)).productId;
});

const putMapping = (fieldId: string, codes: object[], token = ceo.token) =>
  request(app).put(`/api/v1/channel/platforms/lazada/spec-mappings/${fieldId}`).set(auth(token)).send({ codes });
const listMappings = (token = ceo.token) => request(app).get('/api/v1/channel/platforms/lazada/spec-mappings').set(auth(token));

describe('ánh xạ thông số sang sàn', () => {
  it('seed: công ty mới có ánh xạ mặc định cho thông số mặc định', async () => {
    const { rows } = await testPool().query(`select count(*)::int as n from channel.spec_field_mappings where company_id = $1`, [ceo.companyId]);
    expect(rows[0].n).toBeGreaterThan(0);
  });

  it('thay tập mã: thứ tự là priority; lựa chọn đã ánh xạ hiện nhãn sàn; đọc lại qua GET', async () => {
    const res = await putMapping(materialField.id, [
      { attributeCode: MATERIAL, options: [{ optionId: materialField.cotton, platformOptionId: 'm1' }] },
      { attributeCode: MATERIAL2, options: [] },
    ]);
    expect(res.status).toBe(200);
    expect(SpecMappingSchema.parse(res.body).codes.map((c) => [c.attributeCode, c.priority])).toEqual([[MATERIAL, 1], [MATERIAL2, 2]]);
    const list = SpecMappingList.parse((await listMappings()).body);
    const row = list.items.find((i) => i.fieldId === materialField.id)!;
    expect(row.codes[0]!.options).toEqual([
      { optionId: materialField.cotton, platformOptionId: 'm1', platformLabel: 'Bông' },
      { optionId: materialField.poly, platformOptionId: null, platformLabel: null },
    ]);
  });

  it('gợi ý tính lúc đọc: attribute trùng tên thông số, chưa ánh xạ; không ghi DB', async () => {
    await testPool().query(`update catalog.spec_fields set name = 'Phong cách' || $2 where id = $1`, [styleField, '']);
    const list = SpecMappingList.parse((await listMappings()).body);
    expect(list.items.find((i) => i.fieldId === styleField)!.suggestions.map((s) => s.attributeCode)).toContain(STYLE);
    const { rows } = await testPool().query(`select 1 from channel.spec_field_mappings where field_id = $1`, [styleField]);
    expect(rows).toHaveLength(0);
  });

  it('mã đã thuộc thông số khác, mã lặp, mã chưa gặp: 422 theo ô', async () => {
    const taken = await putMapping(styleField, [{ attributeCode: MATERIAL }]);
    expect(taken.status).toBe(422);
    expect(taken.body.errors['codes.0.attributeCode']).toBeDefined();
    const dup = await putMapping(styleField, [{ attributeCode: STYLE }, { attributeCode: STYLE }]);
    expect(dup.body.errors['codes.1.attributeCode']).toBeDefined();
    const unknown = await putMapping(styleField, [{ attributeCode: `khong_co_${tag}` }]);
    expect(unknown.body.errors['codes.0.attributeCode']).toBeDefined();
    const badOption = await putMapping(materialField.id, [{ attributeCode: MATERIAL, options: [{ optionId: materialField.cotton, platformOptionId: 'zz' }] }]);
    expect(badOption.body.errors['codes.0.options.0']).toBeDefined();
  });

  it('bỏ một mã thì CSDL xoá ánh xạ lựa chọn của mã đó', async () => {
    expect((await putMapping(materialField.id, [{ attributeCode: MATERIAL2, options: [] }])).status).toBe(200);
    const { rows } = await testPool().query(`select 1 from channel.spec_option_mappings where field_id = $1 and attribute_code = $2`, [materialField.id, MATERIAL]);
    expect(rows).toHaveLength(0);
    await putMapping(materialField.id, [{ attributeCode: MATERIAL, options: [{ optionId: materialField.cotton, platformOptionId: 'm1' }] }]);
  });

  it('công ty khác: thông số không thấy (404), danh sách không có ánh xạ của công ty này', async () => {
    expect((await putMapping(materialField.id, [], other.token)).status).toBe(404);
    const list = SpecMappingList.parse((await listMappings(other.token)).body);
    expect(list.items.some((i) => i.fieldId === materialField.id)).toBe(false);
  });

  it('attribute-catalog: tìm theo nhãn, gộp theo mã, không trả số leaf', async () => {
    const res = await request(app).get(`/api/v1/channel/platforms/lazada/attribute-catalog?search=${encodeURIComponent('t509_material')}`).set(auth(ceo.token));
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { code: string }) => i.code).sort()).toEqual([MATERIAL, MATERIAL2].sort());
    expect((await request(app).get('/api/v1/channel/platforms/lazada/attribute-catalog?search=a').set(auth(ceo.token))).status).toBe(422);
  });
});

describe('tự điền thông số khi đọc và lưu spec', () => {
  beforeAll(async () => {
    await putMapping(styleField, [{ attributeCode: STYLE }]);
    const db = testPool();
    await db.query(`insert into catalog.product_spec_values (company_id, product_id, field_id, option_id) values ($1, $2, $3, $4), ($1, $2, $3, $5)`, [
      ceo.companyId, productId, materialField.id, materialField.cotton, materialField.poly,
    ]);
    await db.query(`insert into catalog.product_spec_values (company_id, product_id, field_id, value_text) values ($1, $2, $3, 'Basic')`, [ceo.companyId, productId, styleField]);
  });

  const putSpec = (attributes: object, version: number | null) =>
    request(app).put(`/api/v1/channel/products/${productId}/specs/lazada`).set(auth(ceo.token)).send({ externalCategoryId: leaf, attributes, version });

  it('PUT không gửi ghi đè: attribute bắt buộc có giá trị catalog nên không lỗi; không lưu khoá', async () => {
    const res = await putSpec({}, null);
    expect(res.status).toBe(200);
    expect(res.body.spec.attributes).toEqual({});
    expect(res.body.resolved[MATERIAL]).toEqual({ value: ['m1', 'm2'], source: 'catalog', fieldId: materialField.id });
    expect(res.body.resolved[STYLE]).toEqual({ value: 'Basic', source: 'catalog', fieldId: styleField });
    expect(res.body.missing).toEqual([]);
  });

  it('ghi đè khác catalog thì lưu và thắng; gửi trùng catalog thì không lưu', async () => {
    const v = (await request(app).get(`/api/v1/channel/products/${productId}/specs/lazada`).set(auth(ceo.token))).body.spec.version;
    const res = await putSpec({ [STYLE]: 'Công sở', [MATERIAL]: ['Bông', 'Polyester'] }, v);
    expect(res.status).toBe(200);
    expect(res.body.spec.attributes).toEqual({ [STYLE]: 'Công sở' });
    expect(res.body.resolved[STYLE]).toEqual({ value: 'Công sở', source: 'override', fieldId: null });
  });
});
