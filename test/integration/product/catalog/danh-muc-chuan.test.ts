// Danh mục chuẩn 27 và thuộc tính biến thể được phép (#531, Documents/21 mục 5.7, 19 §3.2): bất biến dữ liệu chuẩn so với
// hằng (`domain/defaults.ts`, `spec-defaults.ts`), `allowedAttributes` của mẫu, `GET /attributes?groupId=`, `PUT …/template`
// với `allowedAttributeIds`, chép mẫu, `renamedFrom`/`splitInto`, RLS của `group_allowed_attributes`.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_ATTRIBUTES,
  DEFAULT_GROUP_TEMPLATES,
  DEFAULT_GROUPS,
  DEFAULT_SPEC_FIELDS,
  GROUP_RENAMES,
  GROUP_SPLITS,
  PLATFORM_KINDS,
} from '#src/modules/product/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { api, uniq } from './helpers.ts';

const ok = (res: { status: number; body: unknown }, status = 200) => expect(res.status, JSON.stringify(res.body)).toBe(status);
const problem = (res: { status: number; body: { type?: string } }, status: number, code: string) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.type).toBe(`/problems/${code}`);
};

interface Group {
  id: string;
  name: string;
  scope: string;
  renamedFrom: string | null;
  splitInto: { id: string; name: string }[];
}
interface Allowed {
  attributeId: string;
  name: string;
  platformKind: string | null;
  scope: string;
  isAxis: boolean;
}
interface Attribute {
  id: string;
  name: string;
  platformKind: string | null;
  scope: string;
  values: { value: string; code: string; scope: string }[];
}

let token: string;

async function groups(t = token): Promise<Group[]> {
  const res = await api(t).get('/groups?includeHidden=true');
  ok(res);
  return res.body.items;
}
const groupNamed = async (name: string) => (await groups()).find((g) => g.name === name && g.scope === 'platform')!;
async function template(groupId: string, t = token) {
  const res = await api(t).get(`/groups/${groupId}/template`);
  ok(res);
  return res.body as { axes: { attributeId: string; platformKind: string }[]; allowedAttributes: Allowed[]; version: number };
}
async function attributes(query = '', t = token): Promise<Attribute[]> {
  const res = await api(t).get(`/attributes${query}`);
  ok(res);
  return res.body;
}

beforeAll(async () => {
  token = (await createCompany()).ceo.token;
});

describe('dữ liệu chuẩn 27 danh mục (#531)', () => {
  it('mọi công ty thấy 27 danh mục, 98 thông số, 23 thuộc tính chuẩn đúng hằng; trục mặc định đứng đầu danh sách được phép', async () => {
    expect(DEFAULT_GROUPS).toHaveLength(27);
    expect(DEFAULT_SPEC_FIELDS).toHaveLength(98);
    expect(DEFAULT_ATTRIBUTES.map((a) => a.kind)).toEqual(expect.arrayContaining([...PLATFORM_KINDS]));
    expect(DEFAULT_ATTRIBUTES).toHaveLength(PLATFORM_KINDS.length);

    const gs = (await groups()).filter((g) => g.scope === 'platform');
    expect(gs.map((g) => g.name).sort()).toEqual([...DEFAULT_GROUPS].sort());
    const attrs = (await attributes()).filter((a) => a.scope === 'platform');
    expect(attrs.map((a) => [a.platformKind, a.name, a.values.filter((v) => v.scope === 'platform').map((v) => [v.value, v.code])])).toEqual(
      DEFAULT_ATTRIBUTES.map((a) => [a.kind, a.name, a.values.map(([v, c]) => [v, c])]),
    );
    const kindOf = new Map(attrs.map((a) => [a.id, a.platformKind]));
    for (const t of DEFAULT_GROUP_TEMPLATES) {
      const g = gs.find((x) => x.name === t.group)!;
      const tpl = await template(g.id);
      expect(tpl.axes.map((a) => a.platformKind), t.group).toEqual([...t.axes]);
      expect(tpl.allowedAttributes.map((a) => [kindOf.get(a.attributeId), a.scope, a.isAxis]), t.group).toEqual([
        ...t.axes.map((k) => [k, 'platform', true]),
        ...t.allowed.map((k) => [k, 'platform', false]),
      ]);
    }
  });

  it('danh mục cũ giữ id, đổi tên ghi `renamedFrom`; `splitInto` theo hằng', async () => {
    const gs = await groups();
    for (const [from, to] of Object.entries(GROUP_RENAMES)) expect(gs.find((g) => g.name === to)?.renamedFrom, to).toBe(from);
    expect(gs.find((g) => g.name === 'Đồ chơi')?.renamedFrom).toBeNull();
    for (const [name, into] of Object.entries(GROUP_SPLITS)) {
      expect(gs.find((g) => g.name === name)!.splitInto.map((s) => s.name), name).toEqual(into);
    }
    expect(gs.find((g) => g.name === 'Giày dép')!.splitInto).toEqual([]);
    const own = await api(token).post('/groups', { name: uniq('Riêng') });
    ok(own, 201);
    expect(own.body).toMatchObject({ renamedFrom: null, splitInto: [] });
  });
});

describe('GET /attributes?groupId= (#531)', () => {
  it('điện thoại không có Hương vị; theo thứ tự allowedAttributes; danh mục lạ hoặc của công ty khác 404', async () => {
    const phone = await groupNamed('Điện thoại & máy tính bảng');
    const list = await attributes(`?groupId=${phone.id}`);
    expect(list.map((a) => a.platformKind)).toEqual(['color', 'storage', 'version']);
    expect(list.some((a) => a.platformKind === 'flavor')).toBe(false);
    expect(list[0]!.values.length).toBeGreaterThan(0);

    problem(await api(token).get('/attributes?groupId=khong-phai-uuid'), 404, 'not_found');
    const other = await createCompany();
    const theirs = await api(other.ceo.token).post('/groups', { name: uniq('Của công ty khác') });
    ok(theirs, 201);
    problem(await api(token).get(`/attributes?groupId=${theirs.body.id}`), 404, 'not_found');
  });
});

describe('PUT …/template với allowedAttributeIds (#531)', () => {
  it('danh mục nền tảng: thêm phần công ty sau dòng chuẩn; trùng dòng chuẩn 422; công ty khác không thấy', async () => {
    const c = await createCompany();
    const phone = await groupNamed('Điện thoại & máy tính bảng');
    const tpl = await template(phone.id, c.ceo.token);
    const attrs = await attributes('', c.ceo.token);
    const flavor = attrs.find((a) => a.platformKind === 'flavor')!;
    const dup = await api(c.ceo.token).put(`/groups/${phone.id}/template`, {
      fields: [],
      allowedAttributeIds: [tpl.allowedAttributes[0]!.attributeId],
      version: tpl.version,
    });
    problem(dup, 422, 'validation_failed');
    expect(dup.body.errors['allowedAttributeIds.0']).toBe('Đã có trong danh sách chuẩn');
    const missing = await api(c.ceo.token).put(`/groups/${phone.id}/template`, {
      fields: [],
      allowedAttributeIds: ['00000000-0000-4000-8000-000000000000'],
      version: tpl.version,
    });
    expect(missing.body.errors['allowedAttributeIds.0']).toBe('Không tìm thấy thuộc tính');

    const own = await api(c.ceo.token).post('/attributes', { name: uniq('Gói').slice(0, 15), values: [{ value: 'A' }] });
    ok(own, 201);
    const put = await api(c.ceo.token).put(`/groups/${phone.id}/template`, {
      fields: [],
      allowedAttributeIds: [own.body.id, flavor.id],
      version: tpl.version,
    });
    ok(put);
    expect(put.body.allowedAttributes.map((a: Allowed) => [a.attributeId, a.scope])).toEqual([
      ...tpl.allowedAttributes.map((a) => [a.attributeId, 'platform']),
      [own.body.id, 'company'],
      [flavor.id, 'company'],
    ]);
    expect(put.body.version).toBe(tpl.version + 1);
    expect((await attributes(`?groupId=${phone.id}`, c.ceo.token)).map((a) => a.id).slice(-2)).toEqual([own.body.id, flavor.id]);
    // Công ty khác vẫn chỉ thấy danh sách chuẩn.
    expect((await attributes(`?groupId=${phone.id}`)).map((a) => a.platformKind)).toEqual(['color', 'storage', 'version']);
    // Bỏ trường là giữ.
    const keep = await api(c.ceo.token).put(`/groups/${phone.id}/template`, { fields: [], version: put.body.version });
    ok(keep);
    expect(keep.body.allowedAttributes).toEqual(put.body.allowedAttributes);
  });

  it('danh mục của công ty: cả danh sách, trục tự thêm vào đầu; "Dựa trên danh mục chuẩn" chép danh sách', async () => {
    const c = await createCompany();
    const shoes = await groupNamed('Giày dép');
    const copy = await api(c.ceo.token).post('/groups', { name: uniq('Giày riêng'), copyTemplateFromGroupId: shoes.id });
    ok(copy, 201);
    const shoeTpl = await template(shoes.id, c.ceo.token);
    const copied = await template(copy.body.id, c.ceo.token);
    expect(copied.allowedAttributes.map((a) => [a.attributeId, a.scope, a.isAxis])).toEqual(
      shoeTpl.allowedAttributes.map((a) => [a.attributeId, 'company', a.isAxis]),
    );

    const attrs = await attributes('', c.ceo.token);
    const kind = (k: string) => attrs.find((a) => a.platformKind === k)!.id;
    const put = await api(c.ceo.token).put(`/groups/${copy.body.id}/template`, {
      axisAttributeIds: [kind('color'), kind('size')],
      fields: [],
      allowedAttributeIds: [kind('style')],
      version: copied.version,
    });
    ok(put);
    expect(put.body.allowedAttributes.map((a: Allowed) => [a.platformKind, a.isAxis])).toEqual([
      ['color', true],
      ['size', true],
      ['style', false],
    ]);
  });
});

describe('RLS group_allowed_attributes (#531)', () => {
  it('commerio_app đọc dòng nền tảng, không ghi được dòng nền tảng, không đọc dòng của công ty khác', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const g = await api(b.ceo.token).post('/groups', { name: uniq('B'), copyTemplateFromGroupId: (await groupNamed('Khác')).id });
    ok(g, 201);
    const { rows } = await testPool().query('select count(*)::int as n from product.group_allowed_attributes where company_id = $1', [b.companyId]);
    expect(rows[0].n).toBeGreaterThan(0);
    await asCompany(a.companyId, async (c) => {
      expect((await c.query('select count(*)::int as n from product.group_allowed_attributes where company_id is null')).rows[0].n).toBeGreaterThan(0);
      expect((await c.query('select count(*)::int as n from product.group_allowed_attributes where company_id = $1', [b.companyId])).rows[0].n).toBe(0);
      expect((await c.query('delete from product.group_allowed_attributes where company_id is null')).rowCount).toBe(0);
    });
  });
});
