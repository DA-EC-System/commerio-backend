// Đẩy tồn lên sàn bằng cổng `availableOf` thật của inventory (#222), không thay cổng product bằng bản giả.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PerSkuResult, PriceQuantity } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive, setBuckets } from '../../product/inventory/helpers.ts';
import { fakeAdapter } from './helpers.ts';

setProductPort(null);
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) =>
  items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true })),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async () => [],
    updatePriceQuantity,
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

/** Listing đã trên sàn, chờ đẩy tồn; ghi thẳng vì luồng đẩy sản phẩm đã có test riêng. */
async function liveListing(variantId: string, sellerSku: string) {
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status)
     values ($1, $2, $3, $4, $5, $6, 'live')`,
    [company.companyId, shopId, variantId, `item-${sellerSku}`, `sku-${sellerSku}`, sellerSku],
  );
}
async function listing(variantId: string) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [
    shopId,
    variantId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({
    accessToken: `tok-${randomUUID().slice(0, 12)}`,
  });
  shopId = res.body.shop.id;
});

describe('đẩy tồn bằng số có thể bán của inventory', () => {
  it('tồn thực 5, đang giữ 2 → sàn nhận 3, đọc lại synced với platform_stock 3', async () => {
    const { variantId, sku } = await createVariant(company.companyId);
    await receive(company.companyId, variantId, 5, 1000);
    await setBuckets(company.companyId, variantId, { reserved: 2 });
    await liveListing(variantId, sku);
    updatePriceQuantity.mockClear();

    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
    expect(res.status).toBe(200);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: `item-${sku}`, externalSkuId: `sku-${sku}`, quantity: 3 },
    ]);
    expect(await listing(variantId)).toMatchObject({ stock_sync: 'synced', platform_stock: 3 });
  });

  it('biến thể không có trong Map (không còn trong catalog) → không gửi SKU đó, giữ stock_sync pending', async () => {
    const ghost = randomUUID();
    await liveListing(ghost, 'GHOST-1');
    updatePriceQuantity.mockClear();

    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
    expect(res.status).toBe(200);
    const sent = updatePriceQuantity.mock.calls.flatMap(([, items]) => items);
    expect(sent.find((i) => i.externalSkuId === 'sku-GHOST-1')).toBeUndefined();
    expect(await listing(ghost)).toMatchObject({ stock_sync: 'pending', platform_stock: null });
  });
});
