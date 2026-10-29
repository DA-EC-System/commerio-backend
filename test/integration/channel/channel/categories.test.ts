import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CategoryMap } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { asCompany } from '../../helpers/rls.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    async listCategories() {
      return [
        { externalId: '14275', name: 'Quần áo nam > Áo > Áo thun có cổ nam' },
        { externalId: '7932', name: 'Quần áo nữ > Áo nữ > Áo thun nữ' },
        { externalId: '1', name: 'Điện thoại > Điện thoại di động' },
      ];
    },
    async categoryAttributes(_token, externalCategoryId) {
      if (externalCategoryId !== '14275') return [];
      return [
        { name: 'brand', label: 'Thương hiệu', options: ['No Brand', 'Khác'] },
        { name: 'clothing_material', label: 'Chất liệu', options: [] },
      ];
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const categoryId = randomUUID();

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  shopId = res.body.shop.id;
});

const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);

describe('danh mục sàn', () => {
  it('tìm danh mục lá theo tên, không phân biệt hoa thường', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/categories`).query({ search: 'ÁO THUN' }));
    expect(res.status).toBe(200);
    expect(res.body.items.map((c: { externalId: string }) => c.externalId)).toEqual(['14275', '7932']);
  });

  it('thuộc tính bắt buộc của danh mục', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/categories/14275/attributes`));
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it('gian hàng công ty khác: 404', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/categories`), other.ceo.token);
    expect(res.status).toBe(404);
  });
});

describe('ghép danh mục', () => {
  it('thiếu hoặc sai thuộc tính bắt buộc: 422 theo từng thuộc tính', async () => {
    const res = await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
      externalCategoryId: '14275',
      attributes: { brand: 'Hãng lạ' },
      version: null,
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toMatchObject({
      'attributes.brand': expect.any(String),
      'attributes.clothing_material': expect.any(String),
    });
  });

  it('ghép mới, đọc lại, sửa theo version; version cũ 409', async () => {
    const put = (body: object) => auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send(body);
    const created = await put({
      externalCategoryId: '14275',
      attributes: { brand: 'No Brand', clothing_material: 'Cotton' },
      version: null,
    });
    expect(created.status).toBe(200);
    expect(CategoryMap.parse(created.body)).toMatchObject({ categoryId, platform: 'lazada', externalCategoryId: '14275', version: 1 });

    expect((await put({ externalCategoryId: '7932', attributes: {}, version: null })).status).toBe(409);
    const updated = await put({ externalCategoryId: '7932', attributes: {}, version: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ externalCategoryId: '7932', version: 2 });
    expect((await put({ externalCategoryId: '7932', attributes: {}, version: 1 })).status).toBe(409);

    const list = await auth(app().get(`/api/v1/channel/shops/${shopId}/category-maps`));
    expect(list.body.items).toEqual([expect.objectContaining({ categoryId, externalCategoryId: '7932' })]);
  });

  it('thiếu quyền channel.listing.manage: 403', async () => {
    const sale = await addMember(company.companyId, 'sale');
    const res = await auth(
      app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`),
      sale.token,
    ).send({ externalCategoryId: '7932', attributes: {}, version: 2 });
    expect(res.status).toBe(403);
  });

  it('RLS: công ty khác không đọc được bảng ghép', async () => {
    const other = await createCompany({ optionalModules: ['channel'] });
    const rows = await asCompany(other.companyId, (c) => c.query('select * from channel.category_maps'));
    expect(rows.rows).toEqual([]);
  });
});
