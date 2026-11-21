// Dữ liệu chuẩn hai tầng (#521, Documents/21 mục 5.6, 19 mục 2): dòng nền tảng (`company_id` NULL) dùng chung mọi công ty,
// công ty không sửa được; công ty thêm dòng của mình. Test bất biến (công ty mới và công ty có bản sao kiểu cũ sau migration
// thấy cùng dữ liệu chuẩn), RLS bốn policy, 403 `platform_managed`, ẩn nhóm, mẫu, lựa chọn và giá trị riêng.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import {
  DEFAULT_ATTRIBUTES,
  DEFAULT_GROUP_TEMPLATES,
  DEFAULT_GROUPS,
  DEFAULT_SPEC_FIELDS,
  getProductSpecs,
  getSpecFields,
  getVariants,
} from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { api, uniq } from './helpers.ts';

const TABLES = ['product_groups', 'attributes', 'attribute_values', 'spec_fields', 'spec_field_options', 'group_spec_fields'];

const ok = (res: { status: number; body: unknown }, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status);
const problem = (res: { status: number; body: { type?: string } }, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};

interface Group {
  id: string;
  name: string;
  scope: string;
  hidden: boolean;
  version: number;
  suggest: Record<string, unknown>;
}
interface Field {
  id: string;
  code: string;
  name: string;
  input: string;
  scope: string;
  options: { id: string; value: string; scope: string; inUse: boolean }[];
}
interface Attribute {
  id: string;
  name: string;
  platformKind: string | null;
  scope: string;
  values: { id: string; value: string; code: string; scope: string }[];
}

let token: string;
let companyId: string;

async function groups(t = token, query = ''): Promise<Group[]> {
  const res = await api(t).get(`/groups${query}`);
  ok(res);
  return res.body.items;
}
async function fields(t = token): Promise<Field[]> {
  const res = await api(t).get('/spec-fields');
  ok(res);
  return res.body.items;
}
async function attributes(t = token): Promise<Attribute[]> {
  const res = await api(t).get('/attributes');
  ok(res);
  return res.body;
}
const platformGroup = async (name: string) => (await groups(token, '?includeHidden=true')).find((g) => g.name === name && g.scope === 'platform')!;
const selectField = async () => (await fields()).find((f) => f.scope === 'platform' && f.input === 'multiselect' && f.options.length >= 2)!;

async function simpleProduct(groupId: string, extra: object = {}) {
  const res = await api(token).post('/products', {
    name: uniq('SP'),
    groupId,
    description: '',
    imageFileIds: [],
    axes: [],
    variants: [{ options: [] }],
    ...extra,
  });
  ok(res, 201);
  return res.body as { id: string };
}

/** Dữ liệu chuẩn thấy được của một công ty qua API, để so hai công ty. */
async function standardView(t: string) {
  const gs = (await groups(t, '?includeHidden=true')).filter((g) => g.scope === 'platform');
  const templates = [];
  for (const g of gs) {
    const res = await api(t).get(`/groups/${g.id}/template`);
    ok(res);
    templates.push({
      group: g.name,
      axes: res.body.axes.map((a: { platformKind: string }) => a.platformKind),
      fields: res.body.fields.filter((f: { scope: string }) => f.scope === 'platform').map((f: { code: string; required: boolean }) => [f.code, f.required]),
    });
  }
  return {
    groups: gs.map((g) => g.id).sort(),
    fields: (await fields(t)).filter((f) => f.scope === 'platform').map((f) => f.id).sort(),
    attributes: (await attributes(t)).filter((a) => a.scope === 'platform').map((a) => [a.platformKind, a.values.filter((v) => v.scope === 'platform').map((v) => v.code)]),
    templates: templates.sort((a, b) => a.group.localeCompare(b.group)),
  };
}

beforeAll(async () => {
  const c = await createCompany();
  token = c.ceo.token;
  companyId = c.companyId;
});

describe('dữ liệu chuẩn hai tầng: bất biến (#521)', () => {
  it('công ty mới không có bản sao; thấy 12 nhóm, 76 thông số, mẫu đủ, 4 thuộc tính chuẩn của nền tảng', async () => {
    for (const table of TABLES) {
      const { rows } = await testPool().query(`select count(*)::int as n from product.${table} where company_id = $1`, [companyId]);
      expect(rows[0].n, table).toBe(0);
    }
    const settings = await testPool().query('select sku_pattern from product.company_product_settings where company_id = $1', [companyId]);
    expect(settings.rows).toEqual([{ sku_pattern: 'SP{SEQ:5}-{VAL}' }]);

    const gs = await groups();
    expect(gs.map((g) => g.name).sort()).toEqual([...DEFAULT_GROUPS].sort());
    expect(gs.every((g) => g.scope === 'platform' && g.hidden === false && g.version === 0)).toBe(true);

    const fs = await fields();
    expect(fs.map((f) => f.code).sort()).toEqual(DEFAULT_SPEC_FIELDS.map((f) => f.code).sort());
    expect(fs.every((f) => f.scope === 'platform' && f.options.every((o) => o.scope === 'platform'))).toBe(true);
    for (const def of DEFAULT_SPEC_FIELDS) {
      expect(fs.find((f) => f.code === def.code)!.options.map((o) => o.value), def.code).toEqual(def.options ?? []);
    }

    const attrs = await attributes();
    expect(attrs.map((a) => [a.name, a.platformKind, a.scope, a.values.map((v) => [v.value, v.code])])).toEqual(
      DEFAULT_ATTRIBUTES.map((a) => [a.name, a.kind, 'platform', a.values.map(([v, c]) => [v, c])]),
    );

    const view = await standardView(token);
    expect(view.templates).toEqual(
      DEFAULT_GROUP_TEMPLATES.map((t) => ({ group: t.group, axes: [...t.axes], fields: t.fields.map(([code, required]) => [code, required]) })).sort((a, b) =>
        a.group.localeCompare(b.group),
      ),
    );
    // Hai công ty thấy đúng cùng dòng nền tảng (cùng id).
    const other = await createCompany();
    expect(await standardView(other.ceo.token)).toEqual(view);
  });

  it('cổng getSpecFields, getProductSpecs, getVariants trả `scope`', async () => {
    const field = await selectField();
    const color = (await attributes()).find((a) => a.platformKind === 'color')!;
    const group = await platformGroup('Thời trang nam');
    const res = await api(token).post('/products', {
      name: uniq('Áo'),
      groupId: group.id,
      description: '',
      imageFileIds: [],
      axes: [{ attributeId: color.id, values: [{ id: color.values[0]!.id, value: color.values[0]!.value }, { value: 'Xanh ngọc riêng' }] }],
      variants: [{ options: [color.values[0]!.value] }, { options: ['Xanh ngọc riêng'] }],
      specs: [{ fieldId: field.id, optionIds: [field.options[0]!.id], newValues: ['Lựa chọn riêng cổng'] }],
    });
    ok(res, 201);
    const productId = res.body.id as string;
    await withCompany(companyId, async () => {
      const lib = await getSpecFields();
      const f = lib.find((x) => x.id === field.id)!;
      expect(f.scope).toBe('platform');
      expect(f.options.map((o) => [o.value, o.scope]).at(-1)).toEqual(['Lựa chọn riêng cổng', 'company']);
      const specs = (await getProductSpecs([productId])).get(productId)!;
      const v = specs.values.find((x) => x.fieldId === field.id)!;
      expect(v.scope).toBe('platform');
      expect(v.optionScopes).toEqual(['platform', 'company']);
      const variants = await getVariants(undefined, { productIds: [productId] });
      expect(variants.map((x) => [x.attributes[0]!.scope, x.attributes[0]!.valueScope]).sort()).toEqual([
        ['platform', 'company'],
        ['platform', 'platform'],
      ]);
    });
  });
});

describe('RLS bốn policy tier_* (#521)', () => {
  it('commerio_app đọc dòng nền tảng, không ghi được dòng nền tảng, không đọc dòng riêng của công ty khác', async () => {
    const other = await createCompany();
    const own = await api(other.ceo.token).post('/groups', { name: uniq('Nhóm riêng') });
    ok(own, 201);
    await asCompany(companyId, async (c) => {
      for (const table of TABLES) {
        const { rows } = await c.query(`select count(*)::int as n from product.${table} where company_id is null`);
        expect(rows[0].n, table).toBeGreaterThan(0);
      }
      const hidden = await c.query('select id from product.product_groups where id = $1', [own.body.id]);
      expect(hidden.rows).toEqual([]);
      const upd = await c.query("update product.product_groups set name = name || 'x' where company_id is null");
      expect(upd.rowCount).toBe(0);
      const del = await c.query('delete from product.spec_field_options where company_id is null');
      expect(del.rowCount).toBe(0);
      await c.query('savepoint s');
      await expect(c.query("insert into product.product_groups (company_id, name) values (null, 'Nhóm lậu')")).rejects.toThrow(/row-level security/);
      await c.query('rollback to savepoint s');
    });
  });
});

describe('ghi vào dữ liệu chuẩn (#521, Documents/21 mục 5.6)', () => {
  it('PUT/DELETE nhóm, thông số, thuộc tính nền tảng: 403 platform_managed; đổi tên nhóm chuẩn 422; gợi ý của công ty 200', async () => {
    const group = await platformGroup('Phụ kiện');
    problem(await api(token).delete(`/groups/${group.id}?version=1`), 403, 'platform_managed');
    const renamed = await api(token).put(`/groups/${group.id}`, { name: 'Đổi tên', version: group.version });
    problem(renamed, 422, 'validation_failed');
    expect(renamed.body.errors.name).toBe('Nhóm chuẩn không đổi tên được');
    const suggest = { marginCoefficient: 1.4, priceRounding: 1000, reorderLeadDays: null, reorderSafetyQty: null, reorderDefaultQty: null };
    const set = await api(token).put(`/groups/${group.id}`, { suggest, version: 0 });
    ok(set);
    expect(set.body).toMatchObject({ scope: 'platform', version: 1, suggest: { marginCoefficient: 1.4, priceRounding: 1000 } });
    problem(await api(token).put(`/groups/${group.id}`, { suggest, version: 0 }), 409, 'version_conflict');
    // Công ty khác không thấy gợi ý của công ty này.
    const other = await createCompany();
    const theirs = (await groups(other.ceo.token)).find((g) => g.id === group.id)!;
    expect(theirs).toMatchObject({ version: 0, suggest: { marginCoefficient: null } });

    const field = (await fields()).find((f) => f.scope === 'platform')!;
    problem(await api(token).put(`/spec-fields/${field.id}`, { name: 'X', allowCustom: true, version: 1 }), 403, 'platform_managed');
    problem(await api(token).delete(`/spec-fields/${field.id}?version=1`), 403, 'platform_managed');
    const attr = (await attributes()).find((a) => a.scope === 'platform')!;
    problem(await api(token).put(`/attributes/${attr.id}`, { name: 'X', values: [{ value: 'A' }], version: 1 }), 403, 'platform_managed');
    problem(await api(token).delete(`/attributes/${attr.id}?version=1`), 403, 'platform_managed');
  });

  it('tạo tên hoặc mã trùng dòng nền tảng: 409', async () => {
    problem(await api(token).post('/groups', { name: 'giày dép' }), 409, 'name_taken');
    problem(await api(token).post('/attributes', { name: 'Màu sắc', values: [{ value: 'Tím' }] }), 409, 'name_taken');
    const std = DEFAULT_SPEC_FIELDS[0]!;
    problem(await api(token).post('/spec-fields', { code: std.code, name: uniq('TS'), input: 'text', allowCustom: false }), 409, 'code_taken');
    problem(await api(token).post('/spec-fields', { name: std.name, input: 'text', allowCustom: false }), 409, 'name_taken');
  });

  it('lựa chọn riêng trên thông số chuẩn: thêm 201, trùng 409, đang dùng 409 in_use, xoá 204; lựa chọn chuẩn 403; newValues trùng chuẩn dùng lại dòng chuẩn', async () => {
    const field = await selectField();
    problem(await api(token).post(`/spec-fields/${field.id}/options`, { value: field.options[0]!.value.toUpperCase() }), 409, 'name_taken');
    const added = await api(token).post(`/spec-fields/${field.id}/options`, { value: 'Riêng A' });
    ok(added, 201);
    expect(added.body).toMatchObject({ value: 'Riêng A', scope: 'company', inUse: false });
    problem(await api(token).post(`/spec-fields/${field.id}/options`, { value: 'riêng a' }), 409, 'name_taken');
    problem(await api(token).delete(`/spec-fields/${field.id}/options/${field.options[0]!.id}`), 403, 'platform_managed');

    const group = await platformGroup('Khác');
    const product = await simpleProduct(group.id, {
      specs: [{ fieldId: field.id, optionIds: [added.body.id], newValues: [field.options[1]!.value.toUpperCase()] }],
    });
    const saved = await testPool().query('select option_id from product.product_spec_values where product_id = $1 order by option_id', [product.id]);
    expect(saved.rows.map((r) => r.option_id).sort()).toEqual([added.body.id, field.options[1]!.id].sort());
    problem(await api(token).delete(`/spec-fields/${field.id}/options/${added.body.id}`), 409, 'in_use');

    const spare = await api(token).post(`/spec-fields/${field.id}/options`, { value: 'Riêng B' });
    ok(spare, 201);
    ok(await api(token).delete(`/spec-fields/${field.id}/options/${spare.body.id}`), 204);
    const own = await api(token).post('/spec-fields', { name: uniq('TS riêng'), input: 'select', allowCustom: false, options: [{ value: 'a' }] });
    ok(own, 201);
    problem(await api(token).post(`/spec-fields/${own.body.id}/options`, { value: 'b' }), 422, 'validation_failed');
    // Công ty khác không thấy lựa chọn riêng.
    const other = await createCompany();
    const theirs = (await fields(other.ceo.token)).find((f) => f.id === field.id)!;
    expect(theirs.options.every((o) => o.scope === 'platform')).toBe(true);
  });

  it('giá trị riêng trên thuộc tính chuẩn: thêm 201 (mã trùng thêm hậu tố), trùng 409, xoá 204; giá trị chuẩn 403', async () => {
    const color = (await attributes()).find((a) => a.platformKind === 'color')!;
    problem(await api(token).post(`/attributes/${color.id}/values`, { value: 'đen' }), 409, 'name_taken');
    const added = await api(token).post(`/attributes/${color.id}/values`, { value: 'Đen nhám' });
    ok(added, 201);
    expect(added.body).toMatchObject({ value: 'Đen nhám', scope: 'company' });
    expect(added.body.code).not.toBe('DEN');
    problem(await api(token).delete(`/attributes/${color.id}/values/${color.values[0]!.id}`), 403, 'platform_managed');
    ok(await api(token).delete(`/attributes/${color.id}/values/${added.body.id}`), 204);
  });

  it('ẩn nhóm chuẩn: mặc định không trả, includeHidden trả kèm hidden; nhóm của công ty 422; gọi lại 200', async () => {
    const group = await platformGroup('Mẹ & bé');
    const hidden = await api(token).put(`/groups/${group.id}/hidden`, { hidden: true });
    ok(hidden);
    expect(hidden.body).toMatchObject({ hidden: true });
    ok(await api(token).put(`/groups/${group.id}/hidden`, { hidden: true }));
    expect((await groups()).some((g) => g.id === group.id)).toBe(false);
    expect((await groups(token, '?includeHidden=true')).find((g) => g.id === group.id)).toMatchObject({ hidden: true });
    const own = await api(token).post('/groups', { name: uniq('Nhóm') });
    ok(own, 201);
    problem(await api(token).put(`/groups/${own.body.id}/hidden`, { hidden: true }), 422, 'validation_failed');
    ok(await api(token).put(`/groups/${group.id}/hidden`, { hidden: false }));
    expect((await groups()).some((g) => g.id === group.id)).toBe(true);
  });

  it('mẫu nhóm chuẩn: dòng chuẩn rồi dòng công ty; gửi trục hoặc thông số đã có trong mẫu chuẩn 422', async () => {
    const group = await platformGroup('Điện tử');
    const tpl = await api(token).get(`/groups/${group.id}/template`);
    ok(tpl);
    const std = tpl.body.fields.filter((f: { scope: string }) => f.scope === 'platform');
    const own = await api(token).post('/spec-fields', { name: uniq('Bảo hành riêng'), input: 'text', allowCustom: false });
    ok(own, 201);
    const withAxes = await api(token).put(`/groups/${group.id}/template`, { axisAttributeIds: [], fields: [], version: tpl.body.version });
    problem(withAxes, 422, 'validation_failed');
    expect(withAxes.body.errors.axisAttributeIds).toBe('Trục của nhóm chuẩn do nền tảng đặt');
    const dup = await api(token).put(`/groups/${group.id}/template`, { fields: [{ fieldId: std[0].fieldId, required: false }], version: tpl.body.version });
    problem(dup, 422, 'validation_failed');
    expect(dup.body.errors['fields.0.fieldId']).toBe('Đã có trong mẫu chuẩn');
    const put = await api(token).put(`/groups/${group.id}/template`, { fields: [{ fieldId: own.body.id, required: true }], version: tpl.body.version });
    ok(put);
    expect(put.body.fields.map((f: { scope: string }) => f.scope)).toEqual([...std.map(() => 'platform'), 'company']);
    expect(put.body.fields.at(-1)).toMatchObject({ fieldId: own.body.id, required: true });
    expect(put.body.version).toBe(tpl.body.version + 1);
    // Chép mẫu từ nhóm chuẩn: dòng chuẩn và dòng công ty thành dòng công ty của nhóm mới, cùng trục.
    const copy = await api(token).post('/groups', { name: uniq('Điện tử 2'), copyTemplateFromGroupId: group.id });
    ok(copy, 201);
    const copied = await api(token).get(`/groups/${copy.body.id}/template`);
    expect(copied.body.fields.map((f: { fieldId: string; scope: string }) => [f.fieldId, f.scope])).toEqual(
      put.body.fields.map((f: { fieldId: string }) => [f.fieldId, 'company']),
    );
    expect(copied.body.axes.map((a: { attributeId: string }) => a.attributeId)).toEqual(put.body.axes.map((a: { attributeId: string }) => a.attributeId));
    // Nhóm chuẩn không chép mẫu vào được.
    const into = await api(token).put(`/groups/${group.id}`, { copyTemplateFromGroupId: copy.body.id, version: put.body.version });
    problem(into, 422, 'validation_failed');
  });
});

// Phần gộp của migration `*_du-lieu-chung-chuyen` (bỏ phần ghi dòng nền tảng, tạo bảng tạm) chạy trong giao dịch rồi
// rollback, trên công ty dựng bản sao kiểu cũ (trước #521 mỗi công ty có bản sao dữ liệu chuẩn, thuộc tính mang
// `platform_kind`: gỡ CHECK tầng trong giao dịch để dựng lại, migration thêm lại).
describe('migration gộp bản sao vào dòng nền tảng (#521)', () => {
  const DIR = join(process.cwd(), 'db', 'migrations');
  const SQL = readFileSync(join(DIR, readdirSync(DIR).find((f) => f.endsWith('_du-lieu-chung-chuyen.sql'))!), 'utf8');
  const merge = SQL.slice(0, SQL.indexOf('-- 1. Dòng nền tảng')) + SQL.slice(SQL.indexOf('-- 2. Khớp'));
  const statements = merge
    .split('--> statement-breakpoint')
    .filter((s) => !/CREATE TABLE|REVOKE ALL/.test(s) && s.replace(/--.*$/gm, '').trim());

  // Migration có DDL (gỡ, thêm khoá ngoại, CHECK) cần AccessExclusiveLock trong lúc file test khác chạy song song:
  // lấy hết khoá một lần ở đầu giao dịch (NOWAIT, bận thì rollback và thử lại) để không deadlock giữa chừng.
  const LOCKED = [
    'attributes', 'attribute_values', 'variant_attribute_values', 'product_attribute_value_images', 'product_groups',
    'products', 'product_variants', 'spec_fields', 'spec_field_options', 'group_spec_fields', 'product_spec_values',
    'company_group_settings', 'purchase_request_lines',
  ].map((t) => `product.${t}`).join(', ');
  const lockMigrationTables = async (client: PoolClient) => {
    for (let attempt = 0; ; attempt++) {
      await client.query('begin');
      try {
        await client.query(`lock table ${LOCKED} in access exclusive mode nowait`);
        return;
      } catch (e) {
        await client.query('rollback');
        if ((e as { code?: string }).code !== '55P03' || attempt >= 200) throw e;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  };

  it('sản phẩm cũ giữ nguyên giá trị thông số và trục; bản sao biến mất; gợi ý sang cài đặt công ty; ghi bảng remap', async () => {
    const c = await createCompany();
    const db = testPool();
    const one = async <T>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
    const std = (await fields()).find((f) => f.scope === 'platform' && f.input === 'multiselect' && f.options.length >= 2)!;
    const platformColor = (await attributes()).find((a) => a.platformKind === 'color')!;
    const platformShoes = await platformGroup('Giày dép');
    const stdTemplateField = (await api(token).get(`/groups/${platformShoes.id}/template`)).body.fields[0].fieldId as string;

    // Bản sao kiểu cũ.
    const g = await one<{ id: string }>(
      `insert into product.product_groups (company_id, name, margin_coefficient) values ($1, 'Giày dép', 1.5) returning id`,
      [c.companyId],
    );
    const a = await one<{ id: string }>(`insert into product.attributes (company_id, name, platform_kind) values ($1, 'Màu sắc', null) returning id`, [c.companyId]);
    const black = await one<{ id: string }>(`insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, 'Đen', 'DEN') returning id`, [c.companyId, a.id]);
    const moss = await one<{ id: string }>(`insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, 'Xanh rêu', 'XANHRE') returning id`, [c.companyId, a.id]);
    const f = await one<{ id: string }>(
      `insert into product.spec_fields (company_id, code, name, input, allow_custom) values ($1, $2, $3, 'multiselect', true) returning id`,
      [c.companyId, std.code, std.name],
    );
    const o1 = await one<{ id: string }>(`insert into product.spec_field_options (company_id, field_id, value, position) values ($1, $2, $3, 0) returning id`, [c.companyId, f.id, std.options[0]!.value.toUpperCase()]);
    const o2 = await one<{ id: string }>(`insert into product.spec_field_options (company_id, field_id, value, position) values ($1, $2, 'Tự thêm', 1) returning id`, [c.companyId, f.id]);
    const ownField = await one<{ id: string }>(`insert into product.spec_fields (company_id, code, name, input, allow_custom) values ($1, 'rieng_cu', 'Riêng cũ', 'text', false) returning id`, [c.companyId]);
    const stdCopy = await one<{ id: string }>(
      `insert into product.spec_fields (company_id, code, name, input, unit, allow_custom)
       select $1, code, name, input, unit, allow_custom from product.spec_fields where id = $2 returning id`,
      [c.companyId, stdTemplateField],
    );
    await db.query(
      `insert into product.group_spec_fields (company_id, group_id, field_id, required, position) values ($1, $2, $3, true, 0), ($1, $2, $4, false, 1)`,
      [c.companyId, g.id, stdCopy.id, ownField.id],
    );
    const res = await api(c.ceo.token).post('/products', {
      name: uniq('Giày'),
      groupId: g.id,
      description: '',
      imageFileIds: [],
      axes: [{ attributeId: a.id, values: [{ id: black.id, value: 'Đen' }, { id: moss.id, value: 'Xanh rêu' }] }],
      variants: [{ options: ['Đen'] }, { options: ['Xanh rêu'] }],
      specs: [{ fieldId: f.id, optionIds: [o1.id, o2.id] }],
    });
    ok(res, 201);
    const productId = res.body.id as string;

    const client = await db.connect();
    try {
      await lockMigrationTables(client);
      // Bảng gộp do migration tạo, migration channel `*_anh-xa-hai-tang-du-lieu` (#522) đã xoá: dựng lại trong giao dịch.
      await client.query(
        `create table if not exists product.tier_merge_remap (kind text not null, old_id uuid not null, new_id uuid not null, primary key (kind, old_id))`,
      );
      await client.query('alter table product.attributes drop constraint attributes_platform_kind_tier');
      await client.query(`update product.attributes set platform_kind = 'color' where id = $1`, [a.id]);
      for (const s of statements) await client.query(s);
      const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;

      expect(await q('select group_id from product.products where id = $1', [productId])).toEqual([{ group_id: platformShoes.id }]);
      const vav = await q(
        `select av.id, av.attribute_id, av.company_id from product.variant_attribute_values x join product.product_variants v on v.id = x.variant_id
         join product.attribute_values av on av.id = x.attribute_value_id where v.product_id = $1 order by av.value`,
        [productId],
      );
      expect(vav).toEqual([
        { id: platformColor.values.find((v) => v.value === 'Đen')!.id, attribute_id: platformColor.id, company_id: null },
        { id: moss.id, attribute_id: platformColor.id, company_id: c.companyId },
      ]);
      const psv = await q('select field_id, option_id from product.product_spec_values where product_id = $1 order by option_id', [productId]);
      expect(psv.map((r) => r.field_id)).toEqual([std.id, std.id]);
      expect(psv.map((r) => r.option_id).sort()).toEqual([std.options[0]!.id, o2.id].sort());
      expect(await q('select field_id from product.spec_field_options where id = $1', [o2.id])).toEqual([{ field_id: std.id }]);
      expect(await q('select margin_coefficient from product.company_group_settings where company_id = $1 and group_id = $2', [c.companyId, platformShoes.id])).toEqual([
        { margin_coefficient: '1.50' },
      ]);
      expect(await q('select field_id from product.group_spec_fields where company_id = $1 and group_id = $2', [c.companyId, platformShoes.id])).toEqual([
        { field_id: ownField.id },
      ]);
      // Không còn dòng công ty trùng tên, mã với dòng nền tảng.
      const dup = await q(
        `select 'group' k from product.product_groups x where x.company_id = $1 and exists (select 1 from product.product_groups p where p.company_id is null and lower(p.name) = lower(x.name))
         union all select 'attr' from product.attributes x where x.company_id = $1 and exists (select 1 from product.attributes p where p.company_id is null and lower(p.name) = lower(x.name))
         union all select 'field' from product.spec_fields x where x.company_id = $1 and exists (select 1 from product.spec_fields p where p.company_id is null and (p.code = x.code or lower(p.name) = lower(x.name)))`,
        [c.companyId],
      );
      expect(dup).toEqual([]);
      const kinds = await q(
        `select distinct kind from product.tier_merge_remap where old_id in ($1, $2, $3, $4, $5) order by kind`,
        [g.id, a.id, black.id, f.id, o1.id],
      );
      expect(kinds.map((r) => r.kind)).toEqual(['attribute', 'attribute_value', 'group', 'spec_field', 'spec_option']);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
