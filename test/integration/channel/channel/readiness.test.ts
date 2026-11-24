// Readiness đăng theo gian hàng (be#564, Documents/21 §18.10): cùng hàm kiểm với `listings/push`.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ProductReadiness, PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedFeeConfig, seedSpecs } from './helpers.ts';

const productId = randomUUID();
const sizeAxis = randomUUID();
// Một trục chung (seedSpecs ánh xạ `__custom`): sản phẩm nhiều SKU không trục thì `axis_shape` (gom biến thể, 21 §18.10).
const size = (value: string) => [{ attributeId: sizeAxis, attributeName: 'Cỡ', platformKind: null, valueId: randomUUID(), value }];
const variant = (sku: string, extra: Partial<ListingVariant> = {}): ListingVariant => ({
  id: randomUUID(),
  productId,
  productName: 'Áo thun',
  sku: `${sku}-${randomUUID().slice(0, 6)}`,
  attributesLabel: '',
  productCode: 'SP-RD',
  groupId: 'GROUP-RD',
  attributes: [],
  archived: false,
  businessStatus: 'selling',
  description: 'Áo cotton',
  weightG: 250,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 15,
  ...extra,
});
const ok = variant('RD-OK', { attributes: size('S') });
const noPrice = variant('RD-NOPRICE', { attributes: size('M') });
const noWeight = variant('RD-NOWEIGHT', { weightG: null, attributes: size('L') });
const archived = variant('RD-ARCH', { archived: true, attributes: size('XL') });
const all = [ok, noPrice, noWeight, archived];

setProductPort({
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    all.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === noPrice.id ? null : new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://files.commerio.test/a.jpg']] as const)),
});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  await seedFeeConfig(company.companyId, shopId);
  await seedSpecs(company.companyId, 'lazada', '14275', all, { brand: 'No Brand' });
});

describe('GET /channel/products/:productId/readiness', () => {
  it('gom mục chặn theo mã, chỗ sửa; đếm biến thể chưa lưu trữ; đúng hợp đồng', async () => {
    const res = await auth(app().get(`/api/v1/channel/products/${productId}/readiness`));
    expect(res.status).toBe(200);
    const body = ProductReadiness.parse(res.body);
    const shop = body.items.find((i) => i.shopId === shopId)!;
    expect(shop.counts).toEqual({ ready: 1, blocked: 2, listed: 0 });
    expect(shop.status).toBe('ready');
    expect(shop.category).toMatchObject({ state: 'chosen', externalCategoryId: '14275' });
    expect(shop.blockers.map((b) => [b.code, b.scope, b.target, b.variantIds])).toEqual([
      ['price_missing', 'common', { kind: 'variant_field', field: 'price' }, [noPrice.id]],
      ['dimensions_missing', 'common', { kind: 'variant_field', field: 'weight' }, [noWeight.id]],
    ]);
    expect(shop.variants.find((v) => v.variantId === archived.id)).toBeUndefined();
  });

  it('cùng mã chặn với listings/push (một luật, một hàm)', async () => {
    const readiness = ProductReadiness.parse((await auth(app().get(`/api/v1/channel/products/${productId}/readiness?shopId=${shopId}`))).body);
    const push = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds: [noPrice.id, noWeight.id] });
    const results = PushResults.parse(push.body).results;
    const codes = new Map(readiness.items[0]!.variants.map((v) => [v.variantId, v.blockerCodes]));
    for (const r of results) {
      expect(r.blockers?.map((b) => b.code)).toEqual(codes.get(r.variantId));
      expect(r.code).toBe(codes.get(r.variantId)![0]);
    }
  });

  it('sản phẩm không có: 404; shopId lạ: 404; shopId sai dạng: 422', async () => {
    expect((await auth(app().get(`/api/v1/channel/products/${randomUUID()}/readiness`))).status).toBe(404);
    expect((await auth(app().get(`/api/v1/channel/products/${productId}/readiness?shopId=${randomUUID()}`))).status).toBe(404);
    expect((await auth(app().get(`/api/v1/channel/products/${productId}/readiness?shopId=x`))).status).toBe(422);
  });
});
