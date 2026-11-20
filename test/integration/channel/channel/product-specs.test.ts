// Spec sàn của sản phẩm (#400 lát 8, Documents/21 §18.5): lưu, đọc lại (AC-6, AC-9), kiểm theo attribute leaf (AC-7), tự
// lấy attribute khi thiếu (A16), `version` (AC-10), công ty khác (AC-S2), quyền, nhật ký (AC-S4).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProductSpecView } from '#src/modules/channel/channel/api/schemas.ts';
import type { PlatformAttribute } from '#src/modules/channel/channel/domain/product-spec.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const app = testApp();
afterAll(() => resetAdapters());

const attr = (code: string, extra: Partial<PlatformAttribute> = {}): PlatformAttribute => ({
  code,
  label: code,
  kind: 'property',
  input: 'text',
  options: [],
  allowCustom: true,
  required: false,
  requiredWhen: null,
  isKey: false,
  tier: 'category',
  raw: {},
  ...extra,
});

let attrCalls = 0;
registerAdapter(
  'lazada',
  fakeAdapter({
    categoriesNeedToken: false,
    productFields: { brand: 'brand', country_origin_hb: 'originCountry' },
    defaultBrand: 'No Brand',
    leafAttributes: async () => {
      attrCalls++;
      return [
        attr('material', { required: true, input: 'select', allowCustom: false, options: [{ id: '11', label: 'Cotton' }], raw: { options: [{ id: 11, en_name: 'Cotton EN' }] } }),
        attr('brand', { tier: 'product', required: true }),
        attr('color_family', { kind: 'sales', input: 'select', options: [{ id: '21', label: 'Đỏ' }] }),
      ];
    },
  }),
);

const leaf = `LEAF-${randomUUID().slice(0, 8)}`;
const branch = `BR-${randomUUID().slice(0, 8)}`;
let ceo: { token: string; companyId: string };
let productId: string;

beforeAll(async () => {
  await testPool().query(
    `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
     values ('lazada', $1, 'Áo thun', true, 'Áo > Áo thun', 'ao > ao thun', now()), ('lazada', $2, 'Áo', false, 'Áo', 'ao', now())`,
    [leaf, branch],
  );
  const c = await createCompany({ optionalModules: [] });
  ceo = { token: c.ceo.token, companyId: c.companyId };
  productId = (await createVariant(c.companyId)).productId;
});

const put = (body: object, token = ceo.token, id = productId) =>
  request(app).put(`/api/v1/channel/products/${id}/specs/lazada`).set('Authorization', `Bearer ${token}`).send(body);
const get = (token = ceo.token, id = productId) =>
  request(app).get(`/api/v1/channel/products/${id}/specs/lazada`).set('Authorization', `Bearer ${token}`);

describe('spec sàn của sản phẩm', () => {
  it('chưa có spec: spec null, missing rỗng', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ spec: null, resolved: {}, missing: [], remote: null, suggestedAxisMap: null, suggestedValueMap: null, variantCapabilities: null });
  });

  it('AC-7: thiếu attribute bắt buộc 422 theo ô; lần đầu tự lấy attribute leaf (A16); đọc lại vẫn rỗng', async () => {
    const res = await put({ externalCategoryId: leaf, attributes: {}, version: null });
    expect(res.status).toBe(422);
    expect(res.body.errors['attributes.material']).toBeDefined();
    // Thương hiệu là `tier = product` (catalog, mặc định "No Brand"): không bao giờ thiếu.
    expect(res.body.errors['attributes.brand']).toBeUndefined();
    expect(attrCalls).toBe(1);
    expect((await get()).body.spec).toBeNull();
  });

  it('AC-7: giá trị ngoài lựa chọn, trục lạ, category không phải lá: 422', async () => {
    const bad = await put({ externalCategoryId: leaf, attributes: { material: 'Lụa' }, axisMap: { [randomUUID()]: '__custom' }, version: null });
    expect(bad.status).toBe(422);
    expect(bad.body.errors['attributes.material']).toBeDefined();
    expect(Object.keys(bad.body.errors).some((k) => k.startsWith('axisMap.'))).toBe(true);
    const notLeaf = await put({ externalCategoryId: branch, attributes: { material: '11' }, version: null });
    expect(notLeaf.status).toBe(422);
    expect(notLeaf.body.errors.externalCategoryId).toBeDefined();
  });

  it('AC-6, AC-9, AC-S4: lưu theo nhãn tiếng Anh thành mã lựa chọn, thương hiệu khác catalog là ghi đè (E179), đọc lại đúng; ghi nhật ký; không gọi sàn lần hai', async () => {
    const res = await put({ externalCategoryId: leaf, attributes: { material: 'cotton en', brand: 'X' }, version: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    ProductSpecView.parse(res.body);
    expect(res.body.spec).toMatchObject({ externalCategoryId: leaf, attributes: { material: '11', brand: 'X' }, version: 1, source: 'push', categoryPath: 'Áo > Áo thun' });
    expect(res.body.resolved.brand).toEqual({ value: 'X', source: 'override', fieldId: null });
    expect(res.body.missing).toEqual([]);
    expect(attrCalls).toBe(1);
    expect((await get()).body.spec.version).toBe(1);
    const audit = await testPool().query(
      `select action from core.audit_logs where company_id = $1 and entity_type = 'channel.product_specs'`,
      [ceo.companyId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(['create']);
  });

  it('AC-10: version cũ hoặc null khi đã có: 409 kèm current; đọc lại không đổi', async () => {
    const stale = await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: 7 });
    expect(stale.status).toBe(409);
    expect(stale.body.current.version).toBe(1);
    expect((await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: null })).status).toBe(409);
    const ok = await put({ externalCategoryId: leaf, attributes: { material: 'Cotton' }, version: 1 });
    expect(ok.body.spec.version).toBe(2);
  });

  it('AC-S2: sản phẩm công ty khác, id sai dạng: 404', async () => {
    const other = await createCompany({ optionalModules: [] });
    expect((await get(other.ceo.token)).status).toBe(404);
    expect((await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: null }, other.ceo.token)).status).toBe(404);
    expect((await get(ceo.token, 'khong-phai-uuid')).status).toBe(404);
  });

  it('bản chép version 0 do migration để lại: GET trả đúng bản đó, PUT theo version 0 được', async () => {
    const v = await createVariant(ceo.companyId);
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, source, version) values ($1, $2, 'lazada', $3, '{"material":"Cotton"}', 'push', 0)`,
      [ceo.companyId, v.productId, leaf],
    );
    const res = await get(ceo.token, v.productId);
    expect(res.status).toBe(200);
    expect(res.body.spec).toMatchObject({ externalCategoryId: leaf, attributes: { material: 'Cotton' }, version: 0, source: 'push' });
    const saved = await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: 0 }, ceo.token, v.productId);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.spec.version).toBe(1);
  });

  it('#497: nguồn từng attribute: giữ giá trị thì giữ nguồn (bản cũ chưa có nguồn thì theo source), đổi thì user', async () => {
    const spec = async (attributes: string, fieldSources: string) => {
      const v = await createVariant(ceo.companyId);
      await testPool().query(
        `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, field_sources, source, version)
         values ($1, $2, 'lazada', $3, $4, $5, 'match', 1)`,
        [ceo.companyId, v.productId, leaf, attributes, fieldSources],
      );
      return v.productId;
    };
    const kept = await spec('{"material":"11"}', '{"material":"match"}');
    const res = await put({ externalCategoryId: leaf, attributes: { material: 'Cotton' }, version: 1 }, ceo.token, kept);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.spec.fieldSources).toEqual({ material: 'match' });
    const legacy = await spec('{"material":"11"}', '{}');
    expect((await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: 1 }, ceo.token, legacy)).body.spec.fieldSources).toEqual({
      material: 'match',
    });
    const changed = await spec('{"material":"99"}', '{"material":"match"}');
    expect((await put({ externalCategoryId: leaf, attributes: { material: '11' }, version: 1 }, ceo.token, changed)).body.spec.fieldSources).toEqual({
      material: 'user',
    });
  });

  it('#497: remote là bản sàn đang ghi; tên gian hàng hiện tại, gian hàng đã xoá thì tên lúc đọc', async () => {
    const v = await createVariant(ceo.companyId);
    const { rows } = await testPool().query<{ id: string }>(
      `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Tên mới') returning id`,
      [ceo.companyId, randomUUID().slice(0, 12)],
    );
    const facts = {
      shopName: 'Tên cũ',
      originCountry: 'VN',
      brand: null,
      description: 'Áo thun',
      sizeChartUrl: null,
      imageUrls: ['https://cdn.example/a.jpg'],
      variants: [{ variantId: v.variantId, weightG: 200, lengthMm: 300, widthMm: 200, heightMm: 20 }],
    };
    const readAt = new Date('2026-11-20T10:00:00Z');
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, source, version, remote_facts, remote_read_at, remote_shop_id)
       values ($1, $2, 'lazada', $3, '{}', 'match', 1, $4, $5, $6)`,
      [ceo.companyId, v.productId, leaf, facts, readAt, rows[0]!.id],
    );
    const res = await get(ceo.token, v.productId);
    expect(res.status).toBe(200);
    ProductSpecView.parse(res.body);
    expect(res.body.remote).toEqual({ ...facts, shopId: rows[0]!.id, shopName: 'Tên mới', readAt: readAt.toISOString() });
    await testPool().query('update channel.product_specs set remote_shop_id = null where product_id = $1', [v.productId]);
    expect((await get(ceo.token, v.productId)).body.remote).toMatchObject({ shopId: null, shopName: 'Tên cũ' });
  });

  it('AC-S1: Sale đọc được, lưu bị 403 trước 422; sàn không có adapter 422', async () => {
    const sale = await addMember(ceo.companyId, 'sale');
    const token = sale.token;
    expect((await get(token)).status).toBe(200);
    expect((await put({}, token)).status).toBe(403);
    const mock = await request(app).get(`/api/v1/channel/products/${productId}/specs/mock`).set('Authorization', `Bearer ${ceo.token}`);
    expect(mock.status).toBe(422);
  });
});
