// Đẩy lại SKU người bán đã ghép (`contentSource = 'platform'`, #399 Ca 1; review BE2 P1-1, Thành chốt 19/11/2026): đẩy lại chỉ
// bật lại SKU trên sàn, không gửi nội dung nên không xét spec (`category_unmapped`, `spec_incomplete`, `category_not_permitted`).
// Request đẩy và việc nền dùng chung một vị từ (`pushSpec`). SKU do app tạo (`contentSource = 'app'`) vẫn bị chặn như cũ.
import { randomInt, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { replaceLeaf } from '#src/modules/channel/channel/repository/platform-categories.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import type { ListingPushJob } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variants: ListingVariant[] = [];
const variant = (): ListingVariant => {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Áo thun',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    categoryId: randomUUID(),
    attributesLabel: 'Đen / M',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  };
  variants.push(v);
  return v;
};
const port = {
  variants: async (ids?: readonly string[], filter?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!filter?.productIds || filter.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(150000)])),
  productImageUrls: async (productIds: readonly string[]) => new Map(productIds.map((id) => [id, [`https://img.test/${id}.png`]])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};
setProductPort(port);

/** SKU trên sàn giả theo SellerSku: `getSkus` đọc, `activate` bật lên `live`. */
const remote = new Map<string, { productId: string; skuId: string; state: RemoteSku['state'] }>();
const getSkus = vi.fn(async (_t: string, sellerSkus: readonly string[]): Promise<RemoteSku[]> =>
  sellerSkus.flatMap((sellerSku) => {
    const r = remote.get(sellerSku);
    return r ? [{ externalProductId: r.productId, externalSkuId: r.skuId, sellerSku, title: 'Áo của người bán', state: r.state, rejectReason: null, quantity: 3 }] : [];
  }),
);
const activate = vi.fn(async (_t: string, productId: string) => {
  for (const r of remote.values()) if (r.productId === productId) r.state = 'live';
});
const createProduct = vi.fn(async () => ({ externalProductId: 'x', externalSkuId: 'y', live: false }));
const updateProduct = vi.fn(async () => ({ live: true }));
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoriesNeedToken: false,
    uploadImage: async (_t: string, url: string) => url,
    createProduct,
    updateProduct,
    getSkus,
    activate,
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
// Leaf có attribute bắt buộc: spec không có giá trị thì `missing` khác rỗng (`spec_incomplete`).
const leaf = String(randomInt(700_000_000, 799_999_999));

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  await replaceLeaf('lazada', leaf, {
    attributes: [
      {
        code: 'clothing_material',
        label: 'Chất liệu',
        kind: 'property',
        input: 'select',
        options: [{ id: '9937', label: 'Denim' }],
        allowCustom: false,
        required: true,
        requiredWhen: null,
        isKey: false,
        tier: 'category',
        raw: {},
      },
    ],
    sizeChartRule: null,
    fetchedAt: new Date(),
  });
});

beforeEach(() => {
  getSkus.mockClear();
  activate.mockClear();
  createProduct.mockClear();
  updateProduct.mockClear();
});

type Spec = 'none' | 'incomplete';
/** Listing ghép đã có mã sàn ở `status`; SKU trên sàn đang tắt. `spec`: chưa có spec, hay spec thiếu attribute bắt buộc. */
async function matched(contentSource: 'platform' | 'app', status: 'push_failed' | 'platform_hold', spec: Spec) {
  const v = variant();
  const tag = randomUUID().slice(0, 8);
  remote.set(`NB-${tag}`, { productId: `P-${tag}`, skuId: `S-${tag}`, state: 'inactive' });
  if (spec === 'incomplete') {
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source, version) values ($1, $2, 'lazada', $3, 'match', 1)`,
      [company.companyId, v.productId, leaf],
    );
  }
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, content_source)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [company.companyId, shopId, v.id, `NB-${tag}`, status, `P-${tag}`, `S-${tag}`, contentSource],
  );
  return { v, id: rows[0]!.id };
}

const push = async (variantId: string) => {
  const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds: [variantId] });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.results[0] as { code: string | null; status: string | null };
};
const jobOf = async (listingId: string) =>
  (await testPool().query<{ data: ListingPushJob }>("select data from pgboss.job where name = 'channel.listing_push' and data->>'listingId' = $1", [listingId]))
    .rows[0]?.data;
const listing = async (id: string) =>
  (await testPool().query('select status, content_source, push_error from channel.listings where id = $1', [id])).rows[0];

describe('đẩy lại SKU người bán (contentSource platform) không xét spec', () => {
  it.each<['push_failed' | 'platform_hold', Spec]>([
    ['push_failed', 'none'],
    ['push_failed', 'incomplete'],
    ['platform_hold', 'none'],
    ['platform_hold', 'incomplete'],
  ])('%s, spec %s: request xếp việc; việc nền chỉ bật lại SKU, lên live', async (status, spec) => {
    const { v, id } = await matched('platform', status, spec);
    expect(await push(v.id)).toMatchObject({ code: null, status: 'pushing' });
    const job = await jobOf(id);
    expect(job).toBeDefined();
    await runListingPush(port, job!);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(createProduct).not.toHaveBeenCalled();
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'live', content_source: 'platform', push_error: null });
  });

  it('việc nền: listing platform đang pushing mà sản phẩm chưa có spec vẫn bật lại (không category_unmapped)', async () => {
    const { id } = await matched('platform', 'push_failed', 'none');
    await testPool().query("update channel.listings set status = 'pushing', push_started_at = now() where id = $1", [id]);
    await runListingPush(port, { companyId: company.companyId, shopId, listingId: id, imageUrls: ['https://img.test/a.png'] });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(await listing(id)).toMatchObject({ status: 'live', push_error: null });
  });
});

describe('SKU do app tạo (contentSource app) vẫn chặn theo spec', () => {
  it.each<[Spec, string]>([
    ['none', 'category_unmapped'],
    ['incomplete', 'spec_incomplete'],
  ])('spec %s → request chặn %s, không xếp việc', async (spec, code) => {
    const { v, id } = await matched('app', 'push_failed', spec);
    expect(await push(v.id)).toMatchObject({ code, status: 'push_failed' });
    expect(await jobOf(id)).toBeUndefined();
  });

  it('việc nền: listing app đang pushing mà chưa có spec → push_failed category_unmapped, không gọi sàn', async () => {
    const { id } = await matched('app', 'push_failed', 'none');
    await testPool().query("update channel.listings set status = 'pushing', push_started_at = now() where id = $1", [id]);
    await runListingPush(port, { companyId: company.companyId, shopId, listingId: id, imageUrls: ['https://img.test/a.png'] });
    expect(activate).not.toHaveBeenCalled();
    expect(updateProduct).not.toHaveBeenCalled();
    expect(await listing(id)).toMatchObject({ status: 'push_failed', push_error: { code: 'category_unmapped' } });
  });
});
