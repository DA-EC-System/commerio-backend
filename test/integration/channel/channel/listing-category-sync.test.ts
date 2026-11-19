// Đồng bộ category của listing (#400 lát 13, Documents/19 mục 3.3): lượt đồng bộ đọc category thật của SKU trên sàn
// (`RemoteSku.externalCategoryId`, Lazada `primary_category` của GetProducts); khác cột thì ghi `listings.external_category_id`
// (không tăng `version`); giá trị cũ trùng category của spec thì spec `category_status = 'changed'` (người dùng chọn lại trước
// khi đẩy). Sàn không trả category thì không đổi gì.
import { randomInt, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runListingSync } from '#src/modules/channel/channel/service/background.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import type { RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, type ProductPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variants: ListingVariant[] = [];
const port: ProductPort = {
  variants: async (ids, opts) => variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async () => new Map(),
  availableOf: async (ids) => new Map(ids.map((id) => [id, 5])),
};
setProductPort(port);

const remote: RemoteSku[] = [];
/** SKU sàn trả cho lần đọc theo giờ sửa (`listSkusChanged`, TikTok lấy category từ Get Product của sản phẩm vừa sửa). */
let changed: RemoteSku[] = [];
const listSkusChanged = vi.fn(async () => changed);
registerAdapter(
  'lazada',
  fakeAdapter({
    getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }),
    getSkus: async (_t, skus) => remote.filter((r) => skus.includes(r.sellerSku)),
    updatePriceQuantity: async (_t, items) => items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true })),
    listSkusChanged,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

let companyId: string;
let shopId: string;
const num = () => String(randomInt(800_000_000, 900_000_000));

/** Listing `live` đã đồng bộ tồn, giá, có category `current`; sản phẩm có spec Lazada ở `specCategory` (null: không có spec). */
async function setup(current: string | null, specCategory: string | null, remoteCategory: string | undefined) {
  const v: ListingVariant = {
    id: randomUUID(),
    productId: randomUUID(),
    productName: 'Bình',
    sku: `CS-${randomUUID().slice(0, 8)}`,
    categoryId: randomUUID(),
    attributesLabel: '',
    productCode: 'SP-TEST',
    attributes: [],
    archived: false,
    businessStatus: 'selling',
    description: null,
    weightG: 1,
    lengthMm: 1,
    widthMm: 1,
    heightMm: 1,
  };
  variants.push(v);
  const id = randomUUID().slice(0, 8);
  remote.push({
    externalProductId: `item-${id}`,
    externalSkuId: `sku-${id}`,
    sellerSku: v.sku,
    title: 'Bình',
    state: 'live',
    rejectReason: null,
    quantity: 5,
    ...(remoteCategory && { externalCategoryId: remoteCategory }),
  });
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.listings (company_id, shop_id, variant_id, external_sku_id, external_product_id, seller_sku, status, content_source,
       stock_sync, price_sync, listed_price, platform_stock, external_category_id)
     values ($1, $2, $3, $4, $5, $6, 'live', 'app', 'synced', 'synced', 50000, 5, $7) returning id`,
    [companyId, shopId, v.id, `sku-${id}`, `item-${id}`, v.sku, current],
  );
  if (specCategory) {
    await testPool().query(
      `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source, version) values ($1, $2, 'lazada', $3, 'push', 2)`,
      [companyId, v.productId, specCategory],
    );
  }
  return { listingId: rows[0]!.id, productId: v.productId, sku: remote.at(-1)! };
}
const listing = async (id: string) => (await testPool().query('select external_category_id, version from channel.listings where id = $1', [id])).rows[0];
const specStatus = async (productId: string) =>
  (await testPool().query("select category_status from channel.product_specs where product_id = $1 and platform = 'lazada'", [productId])).rows[0]?.category_status;

beforeAll(async () => {
  const c = await createCompany({ optionalModules: ['channel'] });
  companyId = c.companyId;
  const shop = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = shop.body.shop.id;
  await activateShop(shopId);
});

describe('đồng bộ category của listing', () => {
  it('sàn đổi category: ghi cột, không tăng version; spec đang ở category cũ → changed; spec ở category khác giữ ok; cột null thì chỉ ghi', async () => {
    const [a, b] = [num(), num()];
    const moved = await setup(a, a, b);
    const otherSpec = await setup(a, num(), b);
    const fresh = await setup(null, a, b);
    const same = await setup(a, a, a);
    const silent = await setup(a, a, undefined);
    const before = await Promise.all([moved, otherSpec, fresh, same, silent].map((x) => listing(x.listingId)));

    await syncListings(port, companyId, shopId);

    expect(await listing(moved.listingId)).toEqual({ external_category_id: b, version: before[0].version });
    expect(await specStatus(moved.productId)).toBe('changed');
    expect((await listing(otherSpec.listingId)).external_category_id).toBe(b);
    expect(await specStatus(otherSpec.productId)).toBe('ok');
    expect((await listing(fresh.listingId)).external_category_id).toBe(b);
    expect(await specStatus(fresh.productId)).toBe('ok');
    expect(await listing(same.listingId)).toEqual({ external_category_id: a, version: before[3].version });
    expect(await specStatus(same.productId)).toBe('ok');
    expect((await listing(silent.listingId)).external_category_id).toBe(a);
  });
});

// TikTok (#400 lát 13, Thành chốt cách 2 ngày 19/11/2026): Search Products không trả category nên lượt đồng bộ không biết; lần đọc
// theo giờ sửa sau lượt đồng bộ (`listSkusChanged`, lọc `update_time_ge` từ `remote_skus_changed_since`) đã gọi Get Product cho
// sản phẩm vừa sửa, adapter điền `externalCategoryId` từ `category_chains`; áp như nhánh Lazada. Không thêm lời gọi, không thêm cột.
describe('đồng bộ category theo sản phẩm sàn vừa sửa', () => {
  it('lần đọc theo giờ sửa trả category khác: ghi cột, spec ở category cũ → changed; SKU không có category hay không đổi thì giữ', async () => {
    const [a, b] = [num(), num()];
    const moved = await setup(a, a, undefined);
    const quiet = await setup(a, a, undefined);
    const same = await setup(a, a, undefined);
    await testPool().query(
      "update channel.shops set remote_skus_synced_at = now() - interval '2 minutes', remote_skus_changed_since = now() - interval '70 minutes' where id = $1",
      [shopId],
    );
    changed = [{ ...moved.sku, externalCategoryId: b }, quiet.sku, { ...same.sku, externalCategoryId: a }];
    const before = await listing(moved.listingId);

    await runListingSync(port, { companyId, shopId });

    expect(listSkusChanged).toHaveBeenCalledTimes(1);
    expect(await listing(moved.listingId)).toEqual({ external_category_id: b, version: before.version });
    expect(await specStatus(moved.productId)).toBe('changed');
    expect((await listing(quiet.listingId)).external_category_id).toBe(a);
    expect((await listing(same.listingId)).external_category_id).toBe(a);
    expect(await specStatus(same.productId)).toBe('ok');
  });
});
