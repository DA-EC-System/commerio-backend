// Xem trước số sẽ đẩy khi ghép SKU sàn có sẵn (#460; Documents/21 §18.3 `listings/match-preview`). Cổng product thật,
// bản sao SKU sàn ghi bằng `upsertRemoteSkus` (không gọi sàn).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertRemoteSkus } from '#src/modules/channel/channel/repository/remote-skus.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { MarketplaceError, type RemoteProductCategory } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { clearFillBackCache } from '#src/modules/channel/channel/service/fill-back.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

setProductPort(null);
/** Sản phẩm trên sàn theo mã sản phẩm sàn; vắng thì sàn lỗi tạm. */
const remoteProducts = new Map<string, RemoteProductCategory>();
let productReads = 0;
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop xem trước', region: 'VN' };
    },
    productFields: { country_origin: 'originCountry' },
    defaultBrand: 'No Brand',
    async productCategory(_t, externalProductId) {
      productReads++;
      const p = remoteProducts.get(externalProductId);
      if (!p) throw new MarketplaceError('unavailable', 'E500', 'Sàn bận');
      return p;
    },
  }),
);
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const preview = (q: Record<string, string>, token = company.ceo.token) =>
  request(testApp())
    .get(`/api/v1/channel/shops/${shopId}/listings/match-preview`)
    .query(q)
    .set('Authorization', `Bearer ${token}`);

/** Một SKU sàn trong bản sao: tồn 50, giá gốc `price` (chuỗi lạ thì bản sao bỏ giá). */
async function remoteSku(price: string | undefined) {
  const s = `PV-${randomUUID().slice(0, 8)}`;
  await withCompany(company.companyId, () =>
    upsertRemoteSkus(
      shopId,
      [{ externalProductId: `item-${s}`, externalSkuId: `sku-${s}`, sellerSku: s, title: s, state: 'live', quantity: 50, price }],
      new Date(),
    ),
  );
  return `sku-${s}`;
}

beforeAll(async () => {
  company = await createCompany();
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

describe('GET listings/match-preview (#460)', () => {
  it('SKU kho chưa có số: không đẩy tồn (not_counted, app.stock null), số sàn lấy từ bản sao', async () => {
    const externalSkuId = await remoteSku('189000');
    const { variantId } = await createVariant(company.companyId);
    const res = await preview({ externalSkuId, variantId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      platform: { stock: 50, price: '189000.00' },
      app: { stock: null },
      stockWillPush: false,
      stockHeldReason: 'not_counted',
    });
    expect(typeof res.body.platform.syncedAt).toBe('string');
    expect(res.body.priceWillPush).toBe(res.body.app.price !== null);
  });

  it('SKU đã nhập: đẩy số có thể bán', async () => {
    const externalSkuId = await remoteSku(undefined);
    const { variantId } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 4, 1000);
    const res = await preview({ externalSkuId, variantId });
    expect(res.body).toMatchObject({ platform: { stock: 50, price: null }, app: { stock: 4 }, stockWillPush: true, stockHeldReason: null });
  });

  it('bản sao bỏ giá lạ thay vì hỏng cả lượt ghi', async () => {
    const externalSkuId = await remoteSku('abc');
    const { variantId } = await createVariant(company.companyId);
    expect((await preview({ externalSkuId, variantId })).body.platform.price).toBeNull();
  });

  it('gian hàng chờ kiểm kê lần đầu: lý do shop_waiting_opening thắng not_counted', async () => {
    const externalSkuId = await remoteSku('1000');
    const { variantId } = await createVariant(company.companyId);
    await testPool().query("update channel.shops set opening_stocktake_id = $2, opening_stocktake_number = 'KK-T' where id = $1", [shopId, randomUUID()]);
    try {
      const res = await preview({ externalSkuId, variantId });
      expect(res.body).toMatchObject({ stockWillPush: false, stockHeldReason: 'shop_waiting_opening' });
    } finally {
      await testPool().query('update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null where id = $1', [shopId]);
    }
  });

  it('SKU sàn không có trong bản sao, biến thể công ty khác → 422 theo ô', async () => {
    const { variantId } = await createVariant(company.companyId);
    const missing = await preview({ externalSkuId: 'sku-khong-co', variantId });
    expect(missing.status).toBe(422);
    expect(Object.keys(missing.body.errors)).toEqual(['externalSkuId']);

    const other = await createCompany();
    const foreign = await createVariant(other.companyId);
    const res = await preview({ externalSkuId: await remoteSku('1000'), variantId: foreign.variantId });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors)).toEqual(['variantId']);
  });
});

describe('match-preview: fillBack, trường sẽ điền ngược (21 §18.9 R4)', () => {
  it('trường app trống mà sàn có: tên nước, thương hiệu, mô tả cắt 100 ký tự, cân nặng, kích thước, category; lần sau dùng bộ nhớ đệm', async () => {
    clearFillBackCache();
    const ext = await remoteSku('99000');
    const { variantId } = await createVariant(company.companyId);
    await testPool().query(
      "update product.products p set brand = null, origin_country = null, description = null from product.product_variants v where v.product_id = p.id and v.id = $1",
      [variantId],
    );
    await testPool().query('update product.product_variants set weight_g = null, length_mm = null, width_mm = null, height_mm = null where id = $1', [variantId]);
    remoteProducts.set(ext.replace('sku-', 'item-'), {
      externalCategoryId: '7930',
      attributes: [{ code: 'country_origin', values: [{ id: null, name: 'Việt Nam' }] }],
      facts: {
        brand: 'Hoa Sen',
        description: 'x'.repeat(150),
        imageUrls: [],
        sizeChartUrl: null,
        skus: [{ externalSkuId: ext, weightG: 250, lengthMm: 300, widthMm: 200, heightMm: 55 }],
      },
    });
    const before = productReads;
    const res = await preview({ externalSkuId: ext, variantId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fillBackError).toBeNull();
    expect(Object.fromEntries(res.body.fillBack.map((f: { field: string; value: string }) => [f.field, f.value]))).toEqual({
      originCountry: 'Việt Nam',
      brand: 'Hoa Sen',
      description: 'x'.repeat(100),
      weight: '250 g',
      dimensions: '30 × 20 × 5.5 cm',
      platformSpec: '7930',
    });
    expect((await preview({ externalSkuId: ext, variantId })).body.fillBack).toHaveLength(6);
    expect(productReads - before).toBe(1);
  });

  it('sàn lỗi: vẫn 200, fillBackError có mã, trường app trống value null', async () => {
    clearFillBackCache();
    const ext = await remoteSku('99000');
    const { variantId } = await createVariant(company.companyId);
    const res = await preview({ externalSkuId: ext, variantId });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.fillBackError).toMatchObject({ code: 'marketplace_unavailable' });
    expect(res.body.fillBack.length).toBeGreaterThan(0);
    expect(res.body.fillBack.every((f: { value: unknown }) => f.value === null)).toBe(true);
  });
});
