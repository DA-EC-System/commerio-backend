// Gom lại dữ liệu cũ (#295, Documents/21 §18.8.4): `separateProducts`, route `regroup` và việc nền `channel.product_regroup`
// với adapter giả.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runProductRegroup } from '#src/modules/channel/channel/service/product-regroup.ts';
import { type CreatedProduct, MarketplaceError, type NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const noPrice = new Set<string>();
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, noPrice.has(id) ? null : new Decimal(150000)])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://img.test/a.png']])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  countedOf: async (ids: readonly string[]) => new Set(ids),
};
setProductPort(port);

let onCreate: (p: NewProduct) => Promise<CreatedProduct>;
const createProduct = vi.fn((_t: string, p: NewProduct) => onCreate(p));
const deleteProducts = vi.fn(async (_t: string, _ids: readonly string[]) => {});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    productFields: { brand: 'brand', country_origin_hb: 'originCountry' },
    uploadImage: async (_t, url) => `https://slatic.test/${encodeURIComponent(url)}`,
    createProduct,
    deleteProducts,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const db = () => testPool();
const auth = () => ({ Authorization: `Bearer ${company.ceo.token}` });

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set(auth())
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
});

const echoSkus = (p: { skus?: { sellerSku: string }[] }) => (p.skus ?? []).map((s) => ({ sellerSku: s.sellerSku, externalSkuId: `sku-${s.sellerSku}` }));
beforeEach(() => {
  createProduct.mockClear();
  deleteProducts.mockClear();
  noPrice.clear();
  onCreate = async (p) => ({ externalProductId: `item-${p.skus![0]!.sellerSku}`, externalSkuId: `sku-${p.skus![0]!.sellerSku}`, skus: echoSkus(p), live: true });
});

/** Sản phẩm cha với các SKU theo màu; mỗi SKU đã là một sản phẩm sàn riêng (`separate`) hoặc cùng một sản phẩm. */
async function legacy(colors: readonly string[], separate = true) {
  const productId = randomUUID();
  const vs: ListingVariant[] = colors.map((c) => ({
    id: randomUUID(),
    productId,
    productName: 'Áo thun cotton nhiều màu',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    attributesLabel: c,
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
    attributes: [{ attributeId: 'a-color', attributeName: 'Màu', platformKind: 'color' as const, valueId: randomUUID(), value: c }],
    archived: false,
    businessStatus: 'selling' as const,
    description: 'Áo cotton',
    weightG: 250,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 15,
  }));
  variants.push(...vs);
  await seedSpecs(company.companyId, 'lazada', '14275', vs, { brand: 'No Brand' });
  const tag = randomUUID().slice(0, 6);
  const ids: string[] = [];
  for (const [i, v] of vs.entries()) {
    const { rows } = await db().query<{ id: string }>(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, content_source)
       values ($1, $2, $3, $4, 'live', $5, $6, 'app') returning id`,
      [company.companyId, shopId, v.id, v.sku, separate ? `old-${tag}-${i}` : `old-${tag}`, `osku-${tag}-${i}`],
    );
    ids.push(rows[0]!.id);
  }
  return { productId, vs, ids, tag };
}

const regroup = (productId: string, shop = shopId) =>
  request(testApp()).post(`/api/v1/channel/shops/${shop}/products/${productId}/regroup`).set(auth()).send({});

const job = (productId: string) => ({
  companyId: company.companyId,
  shopId,
  productId,
  startedAt: new Date().toISOString(),
  imageUrls: ['https://img.test/a.png'],
});

describe('separateProducts của GET /channel/products/:productId/listings', () => {
  it('chỉ gồm gian hàng có hơn một sản phẩm sàn; rỗng khi gom rồi', async () => {
    const a = await legacy(['Đen', 'Trắng', 'Đỏ']);
    const res = await request(testApp()).get(`/api/v1/channel/products/${a.productId}/listings`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.separateProducts).toEqual([{ shopId, platform: 'lazada', productCount: 3 }]);
    const b = await legacy(['Xanh', 'Vàng'], false);
    const same = await request(testApp()).get(`/api/v1/channel/products/${b.productId}/listings`).set(auth());
    expect(same.body.separateProducts).toEqual([]);
  });
});

describe('POST /channel/shops/:shopId/products/:productId/regroup', () => {
  it('404 gian hàng và sản phẩm không có', async () => {
    const a = await legacy(['Nâu', 'Be']);
    expect((await regroup(a.productId, randomUUID())).status).toBe(404);
    expect((await regroup(randomUUID())).status).toBe(404);
  });

  it('409 nothing_to_regroup khi các SKU đã nằm trong một sản phẩm sàn', async () => {
    const a = await legacy(['Cam', 'Xám'], false);
    const res = await regroup(a.productId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('nothing_to_regroup');
  });

  it('409 invalid_transition kèm current khi có listing đang pushing', async () => {
    const a = await legacy(['Tím', 'Hồng']);
    await db().query("update channel.listings set status = 'pushing' where id = $1", [a.ids[0]]);
    const res = await regroup(a.productId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
    expect(res.body.current.id).toBe(a.ids[0]);
  });

  it('409 push_blocked kèm rows theo từng SKU bị chặn', async () => {
    const a = await legacy(['Lam', 'Lục']);
    noPrice.add(a.vs[1]!.id);
    const res = await regroup(a.productId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('push_blocked');
    expect(res.body.rows).toEqual([{ variantId: a.vs[1]!.id, code: 'price_missing' }]);
  });

  it('403 với Admin (chỉ CEO được gom)', async () => {
    const admin = await addMember(company.companyId, 'admin');
    const a = await legacy(['Bạc', 'Vàng đồng']);
    const res = await request(testApp())
      .post(`/api/v1/channel/shops/${shopId}/products/${a.productId}/regroup`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('hợp lệ: 202 { queued: true }', async () => {
    const a = await legacy(['Tím than', 'Ghi']);
    const res = await regroup(a.productId);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true });
  });
});

describe('việc nền channel.product_regroup', () => {
  it('tạo một sản phẩm nhiều SKU, listing cũ delisted, listing mới trỏ listing cũ, xoá sản phẩm lẻ', async () => {
    const a = await legacy(['Đen', 'Trắng']);
    await runProductRegroup(port, job(a.productId));
    expect(createProduct).toHaveBeenCalledTimes(1);
    const sent = createProduct.mock.calls[0]![1];
    expect(sent.skipExistingSkuCheck).toBe(true);
    expect(sent.name).toBe('Áo thun cotton nhiều màu');
    expect(sent.skus!.map((s) => s.sellerSku)).toEqual(a.vs.map((v) => v.sku));
    const ext = `item-${a.vs[0]!.sku}`;
    const { rows: old } = await db().query('select status from channel.listings where id = any($1) order by array_position($1, id)', [a.ids]);
    expect(old.map((r) => r.status)).toEqual(['delisted', 'delisted']);
    const { rows: fresh } = await db().query(
      'select status, external_product_id, external_sku_id, replaces_listing_id, content_source, shop_product_id from channel.listings where replaces_listing_id = any($1) order by array_position($1, replaces_listing_id)',
      [a.ids],
    );
    expect(fresh).toMatchObject([
      { status: 'live', external_product_id: ext, external_sku_id: `sku-${a.vs[0]!.sku}`, replaces_listing_id: a.ids[0], content_source: 'app' },
      { status: 'live', external_product_id: ext, external_sku_id: `sku-${a.vs[1]!.sku}`, replaces_listing_id: a.ids[1], content_source: 'app' },
    ]);
    const { rows: sp } = await db().query("select origin, status, external_product_id, push_error from channel.shop_products where id = $1", [fresh[0]!.shop_product_id]);
    expect(sp[0]).toMatchObject({ origin: 'app', status: 'active', external_product_id: ext, push_error: null });
    expect(deleteProducts).toHaveBeenCalledTimes(1);
    expect([...deleteProducts.mock.calls[0]![1]].sort()).toEqual([`old-${a.tag}-0`, `old-${a.tag}-1`]);
  });

  it('tạo lỗi: shop_products failed, listing cũ giữ nguyên, không xoá gì', async () => {
    const a = await legacy(['Cam', 'Xám']);
    onCreate = async () => {
      throw new MarketplaceError('rejected', 'C006', 'Thiếu thuộc tính');
    };
    await runProductRegroup(port, job(a.productId));
    const { rows: old } = await db().query('select status, external_product_id from channel.listings where id = any($1)', [a.ids]);
    expect(old.map((r) => r.status)).toEqual(['live', 'live']);
    const { rows: sp } = await db().query(
      "select status, push_error from channel.shop_products where shop_id = $1 and product_id = $2 and origin = 'app'",
      [shopId, a.productId],
    );
    expect(sp).toHaveLength(1);
    expect(sp[0]).toMatchObject({ status: 'failed', push_error: { code: 'marketplace_rejected' } });
    expect(deleteProducts).not.toHaveBeenCalled();
  });

  it('xoá sản phẩm lẻ lỗi: ghi regroup_cleanup_failed và ném; lượt sau chỉ xoá tiếp', async () => {
    const a = await legacy(['Be', 'Kem']);
    deleteProducts.mockRejectedValueOnce(new MarketplaceError('unavailable'));
    await expect(runProductRegroup(port, job(a.productId))).rejects.toMatchObject({ kind: 'unavailable' });
    const { rows } = await db().query("select push_error from channel.shop_products where shop_id = $1 and product_id = $2 and status = 'active'", [shopId, a.productId]);
    expect(rows[0]!.push_error.code).toBe('regroup_cleanup_failed');
    createProduct.mockClear();
    await runProductRegroup(port, job(a.productId));
    expect(createProduct).not.toHaveBeenCalled();
    expect(deleteProducts).toHaveBeenCalledTimes(2);
    const { rows: after } = await db().query("select push_error from channel.shop_products where shop_id = $1 and product_id = $2 and status = 'active'", [shopId, a.productId]);
    expect(after[0]!.push_error).toBeNull();
  });
});
