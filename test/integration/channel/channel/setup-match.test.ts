// Gợi ý ghép và quyết định từng SKU khi thiết lập (#198; Documents/21 §18.7.5): mọi SKU người bán trên sàn, ghép theo
// SKU rồi theo tên (`similarity` của pg_trgm, ngưỡng 0.4); `POST /setup` nhận `decisions`. Mỗi ca một công ty riêng.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { ShopSetupPreview } from '#src/modules/channel/channel/api/schemas.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const variant = (sku: string, productName: string, attributesLabel = ''): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName,
  sku,
  categoryId: randomUUID(),
  attributesLabel,
  archived: false,
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const vSku = variant('CMR-1', 'Áo thun', 'Trắng');
const vName = variant('CMR-2', 'Quần jean nam', 'Xanh / 32');
const vListed = variant('CMR-3', 'Mũ lưỡi trai');
const vOther = variant('CMR-4', 'Giày thể thao', '42');
const vArchived = { ...variant('CMR-5', 'Bình giữ nhiệt'), archived: true };
const variants = [vSku, vName, vListed, vOther, vArchived];

setProductPort({
  variants: async (ids) => variants.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 9])),
});

const sku = (externalSkuId: string, sellerSku: string, title: string, state: RemoteSku['state'] = 'live'): RemoteSku => ({
  externalProductId: `item-${externalSkuId}`,
  externalSkuId,
  sellerSku,
  title,
  state,
  rejectReason: null,
  quantity: 4,
});
const remote: RemoteSku[] = [
  sku('sku-1', 'CMR-1', 'Áo thun trắng'),
  sku('sku-2', 'LZ-JEAN', 'Quần jean nam xanh 32'),
  sku('sku-3', 'LZ-MU', 'Mũ lưỡi trai'),
  sku('sku-4', 'LZ-BINH', 'Bình giữ nhiệt'),
  sku('sku-5', 'LZ-DEL', 'Áo thun trắng', 'deleted'),
];
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
    listSkus: async () => remote,
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
  }),
);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

/** Gian hàng `connecting` của công ty đã có gian hàng xong thiết lập (được `push`); `vListed` đã có listing ở gian hàng. */
async function connectingShop() {
  const c = await createCompany({ optionalModules: ['channel'] });
  await testPool().query(
    "insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Cũ', 'active', now())",
    [c.companyId, randomUUID()],
  );
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const shopId = res.body.shop.id as string;
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id, external_product_id)
     values ($1, $2, $3, 'OLD-MU', 'live', 'sku-old', 'item-old')`,
    [c.companyId, shopId, vListed.id],
  );
  const auth = (r: request.Test) => r.set('Authorization', `Bearer ${c.ceo.token}`);
  return {
    c,
    shopId,
    preview: () => auth(request(testApp()).get(`/api/v1/channel/shops/${shopId}/setup`)),
    setup: (body: object) => auth(request(testApp()).post(`/api/v1/channel/shops/${shopId}/setup`)).send({ openingStock: 'push', ...body }),
  };
}
const listingsOf = async (shopId: string) =>
  (
    await testPool().query(
      `select external_sku_id, variant_id, seller_sku from channel.listings where shop_id = $1 and external_sku_id <> 'sku-old' order by external_sku_id`,
      [shopId],
    )
  ).rows;

describe('gợi ý ghép theo SKU và theo tên (AC-22)', () => {
  it('mỗi SKU sàn một dòng: trùng SKU là `sku`, tên giống từ 0.4 là `name` kèm `score`, còn lại `none`; bỏ sản phẩm đã xoá', async () => {
    const { preview } = await connectingShop();
    const res = await preview();
    expect(res.status).toBe(200);
    expect(() => ShopSetupPreview.parse(res.body)).not.toThrow();
    const rows = res.body.suggestions as Record<string, unknown>[];
    expect(rows.map((r) => r.externalSkuId)).toEqual(['sku-1', 'sku-2', 'sku-3', 'sku-4']);
    expect(rows[0]).toEqual({
      externalSkuId: 'sku-1',
      title: 'Áo thun trắng',
      match: 'sku',
      score: null,
      variantId: vSku.id,
      sku: 'CMR-1',
      available: 9,
      platformStock: 4,
    });
    expect(rows[1]).toMatchObject({ match: 'name', variantId: vName.id, sku: 'CMR-2', available: 9 });
    expect(rows[1]!.score).toBeGreaterThanOrEqual(0.4);
    expect(rows[1]!.score).toBeLessThanOrEqual(1);
    // `vListed` đã có listing ở gian hàng, `vArchived` lưu trữ: không được gợi ý dù tên trùng.
    for (const r of rows.slice(2)) expect(r).toMatchObject({ match: 'none', score: null, variantId: null, sku: null, available: null, platformStock: 4 });
    expect(res.body.unmatchedRemote).toBe(2);
  });
});

describe('quyết định từng SKU khi thiết lập (AC-23)', () => {
  it('tạo listing theo biến thể người chọn (khác gợi ý được), `null` bỏ qua; SKU người bán của listing là SKU trên sàn', async () => {
    const { shopId, setup } = await connectingShop();
    const res = await setup({
      decisions: [
        { externalSkuId: 'sku-1', variantId: vSku.id },
        { externalSkuId: 'sku-2', variantId: vOther.id },
        { externalSkuId: 'sku-4', variantId: null },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(2);
    expect(await listingsOf(shopId)).toEqual([
      { external_sku_id: 'sku-1', variant_id: vSku.id, seller_sku: 'CMR-1' },
      { external_sku_id: 'sku-2', variant_id: vOther.id, seller_sku: 'LZ-JEAN' },
    ]);
    const { rows } = await testPool().query('select unmatched_sku_count from channel.shops where id = $1', [shopId]);
    expect(rows[0].unmatched_sku_count).toBe(2);
  });

  it('gửi cả `externalSkuIds` và `decisions` thì 422 `errors.decisions`', async () => {
    const { setup } = await connectingShop();
    const res = await setup({ externalSkuIds: ['sku-1'], decisions: [{ externalSkuId: 'sku-1', variantId: vSku.id }] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('decisions');
  });

  it('dòng sai báo theo vị trí: SKU không có trong gợi ý, biến thể lạ, biến thể đã ghép, lưu trữ, lặp; không tạo listing nào', async () => {
    const { shopId, setup } = await connectingShop();
    const res = await setup({
      decisions: [
        { externalSkuId: 'sku-1', variantId: vSku.id },
        { externalSkuId: 'sku-9', variantId: vName.id },
        { externalSkuId: 'sku-2', variantId: randomUUID() },
        { externalSkuId: 'sku-3', variantId: vListed.id },
        { externalSkuId: 'sku-4', variantId: vSku.id },
        { externalSkuId: 'sku-5', variantId: vArchived.id },
      ],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['decisions.1', 'decisions.2', 'decisions.3', 'decisions.4', 'decisions.5']);
    expect(await listingsOf(shopId)).toEqual([]);
  });

  it('`externalSkuIds` cũ vẫn chạy với biến thể gợi ý (kể cả ghép theo tên); SKU `none` thì 422 `errors.externalSkuIds`', async () => {
    const bad = await connectingShop();
    expect((await bad.setup({ externalSkuIds: ['sku-4'] })).status).toBe(422);
    const { shopId, setup } = await connectingShop();
    const res = await setup({ externalSkuIds: ['sku-1', 'sku-2'] });
    expect(res.status).toBe(200);
    expect(await listingsOf(shopId)).toEqual([
      { external_sku_id: 'sku-1', variant_id: vSku.id, seller_sku: 'CMR-1' },
      { external_sku_id: 'sku-2', variant_id: vName.id, seller_sku: 'LZ-JEAN' },
    ]);
  });
});
