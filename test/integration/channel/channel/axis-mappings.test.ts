// Ánh xạ trục phân loại sang sales attribute của sàn theo công ty (#448 L4, Documents/21 §18.8.1): GET trả mỗi thuộc tính
// một dòng kèm `defaultCodes` theo platformKind; PUT thay danh sách, mã phải là sales attribute đã gặp ở leaf nào đó.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AxisMappingItemSchema, AxisMappingList } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const app = testApp();
const powerId = randomUUID();
const noneId = randomUUID();
// Thuộc tính chuẩn của nền tảng (dữ liệu chung, chốt 3): ánh xạ do nền tảng giữ, công ty chỉ đọc.
const colorId = randomUUID();
const attributes = [
  { id: colorId, name: 'Màu sắc', platformKind: 'color' as const, scope: 'platform' as const },
  { id: powerId, name: 'Dung lượng pin', platformKind: null, scope: 'company' as const },
];
setProductPort({
  attributes: async () => attributes,
  variants: async () => [],
  standardPrices: async () => new Map(),
  availableOf: async () => new Map(),
  productImageUrls: async () => new Map(),
});
registerAdapter('tiktok', fakeAdapter({ standardSalesAttributes: { color: ['100000'], size: ['100007'] } }));
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const code1 = `AXT-${randomUUID().slice(0, 8)}`;
const code2 = `AXT-${randomUUID().slice(0, 8)}`;
const leaf = `AXT-${randomUUID().slice(0, 8)}`;
let ceo: string;
let companyId: string;

const url = (id = '') => `/api/v1/channel/platforms/tiktok/axis-mappings${id ? `/${id}` : ''}`;
const put = (attributeId: string, codes: string[], token = ceo) =>
  request(app).put(url(attributeId)).set('Authorization', `Bearer ${token}`).send({ codes: codes.map((attributeCode) => ({ attributeCode })) });

beforeAll(async () => {
  const c = await createCompany({ optionalModules: [] });
  ceo = c.ceo.token;
  companyId = c.companyId;
  const q = testPool();
  await q.query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('tiktok', $1, 'Lá thử', true, 'Lá thử', 'la thu', now())`,
    [leaf],
  );
  for (const [code, label, kind] of [[code1, 'Dung lượng pin', 'sales'], [code2, 'Công suất', 'sales'], ['AXT-prop', 'Chất liệu', 'property']]) {
    await q.query(
      `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, tier, fetched_at)
       values ('tiktok', $1, $2, $3, $4, 'select', 'category', now()) on conflict do nothing`,
      [leaf, code, label, kind],
    );
  }
});

describe('axis-mappings', () => {
  it('GET: mỗi thuộc tính một dòng; defaultCodes theo platformKind, thuộc tính tự đặt không có mặc định', async () => {
    const res = await request(app).get(url()).set('Authorization', `Bearer ${ceo}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    AxisMappingList.parse(res.body);
    expect(res.body.items).toEqual([
      { attributeId: colorId, platformKind: 'color', scope: 'platform', editable: false, codes: [], defaultCodes: ['100000'] },
      { attributeId: powerId, platformKind: null, scope: 'company', editable: true, codes: [], defaultCodes: [] },
    ]);
  });

  it('PUT: lưu theo thứ tự priority, GET thấy nhãn; ghi nhật ký; [] là bỏ', async () => {
    const res = await put(powerId, [code2, code1]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    AxisMappingItemSchema.parse(res.body);
    expect(res.body.codes).toEqual([
      { attributeCode: code2, attributeLabel: 'Công suất', priority: 1 },
      { attributeCode: code1, attributeLabel: 'Dung lượng pin', priority: 2 },
    ]);
    const rows = await testPool().query('select attribute_code, priority from channel.axis_mappings where company_id = $1 order by priority', [companyId]);
    expect(rows.rows).toEqual([
      { attribute_code: code2, priority: 1 },
      { attribute_code: code1, priority: 2 },
    ]);
    const audit = await testPool().query("select count(*)::int as n from core.audit_logs where company_id = $1 and entity_type = 'channel.axis_mappings'", [companyId]);
    expect(audit.rows[0].n).toBe(1);

    const list = await request(app).get(url()).set('Authorization', `Bearer ${ceo}`);
    expect(list.body.items[1].codes.map((c: { attributeCode: string }) => c.attributeCode)).toEqual([code2, code1]);

    expect((await put(powerId, [code1])).body.codes).toEqual([{ attributeCode: code1, attributeLabel: 'Dung lượng pin', priority: 1 }]);
    expect((await put(powerId, [])).body.codes).toEqual([]);
  });

  it('PUT: mã không phải sales attribute đã gặp hoặc trùng trong mảng: 422 theo ô; không lưu gì', async () => {
    await put(powerId, [code1]);
    const bad = await put(powerId, [code2, 'AXT-prop', code2, 'khong-co']);
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toEqual({
      'codes.1.attributeCode': expect.any(String),
      'codes.2.attributeCode': expect.any(String),
      'codes.3.attributeCode': expect.any(String),
    });
    const rows = await testPool().query('select attribute_code from channel.axis_mappings where company_id = $1', [companyId]);
    expect(rows.rows).toEqual([{ attribute_code: code1 }]);
  });

  it('PUT thuộc tính chuẩn: 403 platform_managed, không ghi gì; dòng nền tảng hiện cho mọi công ty, công ty không xoá được', async () => {
    const res = await put(colorId, [code1]);
    expect(res.status).toBe(403);
    expect(res.body.type).toMatch(/platform_managed$/);
    const db = testPool();
    await db.query(`insert into channel.axis_mappings (company_id, attribute_id, platform, attribute_code, priority) values (null, $1, 'tiktok', $2, 1)`, [colorId, code2]);
    const list = await request(app).get(url()).set('Authorization', `Bearer ${ceo}`);
    expect(list.body.items[0].codes).toEqual([{ attributeCode: code2, attributeLabel: 'Công suất', priority: 1 }]);
    await asCompany(companyId, async (c) => {
      expect((await c.query(`delete from channel.axis_mappings where attribute_id = $1`, [colorId])).rowCount).toBe(0);
      await expect(
        c.query(`insert into channel.axis_mappings (company_id, attribute_id, platform, attribute_code, priority) values (null, $1, 'lazada', 'x', 1)`, [colorId]),
      ).rejects.toThrow(/row-level security/);
    });
    await db.query(`delete from channel.axis_mappings where attribute_id = $1`, [colorId]);
  });

  it('RLS: công ty không đọc được ánh xạ trục của công ty khác', async () => {
    await put(powerId, [code1]);
    const other = await createCompany({ optionalModules: [] });
    await asCompany(other.companyId, async (c) => {
      expect((await c.query(`select 1 from channel.axis_mappings where attribute_id = $1`, [powerId])).rowCount).toBe(0);
    });
  });

  it('PUT: quá 10 mã 422; thuộc tính không phải của công ty 404; sàn lạ 422; Sale không có catalog.group.manage 403', async () => {
    expect((await put(powerId, Array.from({ length: 11 }, (_, i) => `c${i}`))).status).toBe(422);
    expect((await put(noneId, [code1])).status).toBe(404);
    expect((await put('khong-phai-uuid', [code1])).status).toBe(404);
    const lazada = await request(app).put('/api/v1/channel/platforms/nope/axis-mappings/' + powerId).set('Authorization', `Bearer ${ceo}`).send({ codes: [] });
    expect(lazada.status).toBe(422);
    const sale = await addMember(companyId, 'sale');
    expect((await put(powerId, [code1], sale.token)).status).toBe(403);
    expect((await request(app).get(url()).set('Authorization', `Bearer ${sale.token}`)).status).toBe(200);
  });
});
