// Việc nền đẩy theo cha `channel.product_push` (#295, Documents/21 §18.8.4): gọi thẳng handler với adapter giả.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runProductPush } from '#src/modules/channel/channel/service/product-push.ts';
import {
  type CreatedProduct,
  type CreatedSku,
  MarketplaceError,
  type NewProduct,
  type NewVariants,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter, seedSpecs } from './helpers.ts';

const variants: ListingVariant[] = [];
const noPrice = new Set<string>();
const port = {
  variants: async (ids?: readonly string[], opts?: { productIds?: readonly string[] }) =>
    variants.filter((v) => (!ids || ids.includes(v.id)) && (!opts?.productIds || opts.productIds.includes(v.productId))),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, noPrice.has(id) ? null : new Decimal(150000)])),
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
  countedOf: async (ids: readonly string[]) => new Set(ids),
};
setProductPort(port);

let onCreate: (p: NewProduct) => Promise<CreatedProduct>;
let onAdd: (externalProductId: string, p: NewVariants) => Promise<{ skus: CreatedSku[]; live: boolean }>;
const createProduct = vi.fn((_t: string, p: NewProduct) => onCreate(p));
const addVariants = vi.fn((_t: string, id: string, p: NewVariants) => onAdd(id, p));
const uploadImage = vi.fn(async (_t: string, url: string) => `https://slatic.test/${encodeURIComponent(url)}`);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    productFields: { brand: 'brand', country_origin_hb: 'originCountry' },
    uploadImage,
    createProduct,
    addVariants,
  }),
);
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  await stopJobs();
});


let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await request(testApp())
    .post('/api/v1/channel/shops/lazada/token')
    .set('Authorization', `Bearer ${company.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;

});

const echoSkus = (p: { skus?: { sellerSku: string }[] }) => (p.skus ?? []).map((s) => ({ sellerSku: s.sellerSku, externalSkuId: `sku-${s.sellerSku}` }));
beforeEach(() => {
  createProduct.mockClear();
  addVariants.mockClear();
  uploadImage.mockClear();
  noPrice.clear();
  onCreate = async (p) => ({ externalProductId: `item-${p.skus![0]!.sellerSku}`, externalSkuId: `sku-${p.skus![0]!.sellerSku}`, skus: echoSkus(p), live: true });
  onAdd = async (_id, p) => ({ skus: echoSkus(p), live: false });
});

const color = (value: string) => [{ attributeId: 'a-color', attributeName: 'Màu', platformKind: 'color' as const, valueId: randomUUID(), value }];

/** Một sản phẩm cha với các SKU theo màu, spec trục `__custom`. */
async function product(colors: readonly string[]) {
  const productId = randomUUID();
  const vs = colors.map((c) => ({
    id: randomUUID(),
    productId,
    productName: 'Áo thun cotton nhiều màu',
    sku: `CMR-${randomUUID().slice(0, 8)}`,
    attributesLabel: c,
    productCode: 'SP-TEST',
    groupId: 'GROUP-TEST',
    attributes: color(c),
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
  return { productId, vs };
}

/** Dòng `shop_products` `app` và các listing `pushing` cùng mốc lượt, như request `push` để lại. */
async function lot(productId: string, vs: readonly ListingVariant[], externalProductId: string | null = null) {
  const at = new Date();
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shop_products (company_id, shop_id, product_id, origin, external_product_id, push_started_at)
     values ($1, $2, $3, 'app', $4, $5) returning id`,
    [company.companyId, shopId, productId, externalProductId, at],
  );
  const spId = rows[0]!.id;
  const ids: string[] = [];
  for (const v of vs) {
    const r = await testPool().query<{ id: string }>(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, push_started_at, content_source, shop_product_id)
       values ($1, $2, $3, $4, 'pushing', $5, 'app', $6) returning id`,
      [company.companyId, shopId, v.id, v.sku, at, spId],
    );
    ids.push(r.rows[0]!.id);
  }
  return { spId, ids, job: { companyId: company.companyId, shopId, shopProductId: spId, pushStartedAt: at.toISOString(), imageUrls: ['https://img.test/a.png'] } };
}

async function listings(ids: readonly string[]) {
  const { rows } = await testPool().query(
    `select id, status, external_product_id, external_sku_id, shop_product_id, push_error, push_attempts from channel.listings where id = any($1) order by array_position($1, id)`,
    [ids],
  );
  return rows;
}

async function shopProduct(id: string) {
  const { rows } = await testPool().query('select external_product_id, status, push_error from channel.shop_products where id = $1', [id]);
  return rows[0];
}

describe('việc nền channel.product_push', () => {
  it('cha chưa có sản phẩm sàn: một lần tạo nhiều phân loại, mỗi SKU ghi mã sàn theo seller_sku, dòng shop_products có mã', async () => {
    const { productId, vs } = await product(['Đen', 'Trắng']);
    const { spId, ids, job } = await lot(productId, vs);
    await runProductPush(port, job);
    expect(createProduct).toHaveBeenCalledTimes(1);
    const sent = createProduct.mock.calls[0]![1];
    expect(sent.name).toBe('Áo thun cotton nhiều màu');
    expect(sent.salesAttributes).toEqual([{ code: null, name: 'Màu', values: [{ optionId: null, label: 'Đen' }, { optionId: null, label: 'Trắng' }] }]);
    expect(sent.skus!.map((s) => [s.sellerSku, s.values])).toEqual([
      [vs[0]!.sku, ['Đen']],
      [vs[1]!.sku, ['Trắng']],
    ]);
    expect(sent.idempotencyKey).toBe(`cm-sp-${spId}-${Date.parse(job.pushStartedAt)}`);
    const ext = `item-${vs[0]!.sku}`;
    expect(await listings(ids)).toMatchObject([
      { status: 'live', external_product_id: ext, external_sku_id: `sku-${vs[0]!.sku}`, shop_product_id: spId },
      { status: 'live', external_product_id: ext, external_sku_id: `sku-${vs[1]!.sku}`, shop_product_id: spId },
    ]);
    expect(await shopProduct(spId)).toMatchObject({ external_product_id: ext, status: 'active', push_error: null });
  });

  it('cha đã có sản phẩm sàn: thêm phân loại chỉ gửi SKU mới, không tạo sản phẩm', async () => {
    const { productId, vs } = await product(['Xanh']);
    const { spId, ids, job } = await lot(productId, vs, 'item-cu');
    await runProductPush(port, job);
    expect(createProduct).not.toHaveBeenCalled();
    expect(addVariants).toHaveBeenCalledTimes(1);
    expect(addVariants.mock.calls[0]![1]).toBe('item-cu');
    expect(addVariants.mock.calls[0]![2].skus.map((s) => s.sellerSku)).toEqual([vs[0]!.sku]);
    expect(await listings(ids)).toMatchObject([{ status: 'under_review', external_product_id: 'item-cu', shop_product_id: spId }]);
  });

  it('KB3: biến thể mới của sản phẩm đã ghép từ sàn (dòng match) thì thêm phân loại vào sản phẩm sàn đó, không tạo sản phẩm mới', async () => {
    await activateShop(shopId);
    const { productId, vs } = await product(['Đỏ', 'Hồng đất']);
    const [red, pink] = vs as [ListingVariant, ListingVariant];
    const ext = `item-nb-${randomUUID().slice(0, 8)}`;
    // Đỏ đã liên kết với SKU của sản phẩm người bán có sẵn trên sàn: trigger gắn dòng `match` cùng mã.
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status, stock_sync, price_sync)
       values ($1, $2, $3, $4, $5, $6, 'live', 'synced', 'synced')`,
      [company.companyId, shopId, red.id, ext, `sku-${red.sku}`, red.sku],
    );
    const images = port.productImageUrls;
    port.productImageUrls = async () => new Map([[productId, ['https://img.test/a.png']]]);
    try {
      const res = await request(testApp())
        .post(`/api/v1/channel/shops/${shopId}/listings/push`)
        .set('Authorization', `Bearer ${company.ceo.token}`)
        .send({ variantIds: [pink.id] });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.results).toMatchObject([{ variantId: pink.id, status: 'pushing', code: null }]);
    } finally {
      port.productImageUrls = images;
    }
    const { rows } = await testPool().query<{ id: string; origin: string; push_started_at: Date }>(
      `select sp.id, sp.origin, sp.push_started_at from channel.listings l join channel.shop_products sp on sp.id = l.shop_product_id
       where l.shop_id = $1 and l.variant_id = $2`,
      [shopId, pink.id],
    );
    expect(rows[0]!.origin).toBe('match');
    const appRows = await testPool().query("select 1 from channel.shop_products where shop_id = $1 and product_id = $2 and origin = 'app'", [shopId, productId]);
    expect(appRows.rowCount).toBe(0);
    await runProductPush(port, {
      companyId: company.companyId,
      shopId,
      shopProductId: rows[0]!.id,
      productId,
      pushStartedAt: rows[0]!.push_started_at.toISOString(),
      imageUrls: ['https://img.test/a.png'],
    });
    expect(createProduct).not.toHaveBeenCalled();
    expect(addVariants).toHaveBeenCalledTimes(1);
    expect(addVariants.mock.calls[0]![1]).toBe(ext);
    expect(addVariants.mock.calls[0]![2].skus.map((x) => x.sellerSku)).toEqual([pink.sku]);
  });

  it('SKU sàn không trả về thì push_failed riêng SKU đó, SKU còn lại lên sàn', async () => {
    const { productId, vs } = await product(['Đỏ', 'Vàng']);
    onCreate = async (p) => ({ externalProductId: 'item-mot', externalSkuId: 'x', skus: echoSkus(p).slice(0, 1), live: true });
    const { ids, job } = await lot(productId, vs);
    await runProductPush(port, job);
    const [a, b] = await listings(ids);
    expect(a).toMatchObject({ status: 'live', external_sku_id: `sku-${vs[0]!.sku}` });
    expect(b).toMatchObject({ status: 'push_failed', external_product_id: null, push_error: { code: 'marketplace_rejected' } });
  });

  it('SKU bị chặn (thiếu giá) fail riêng, SKU còn lại vẫn đẩy', async () => {
    const { productId, vs } = await product(['Tím', 'Hồng']);
    noPrice.add(vs[1]!.id);
    const { ids, job } = await lot(productId, vs);
    await runProductPush(port, job);
    expect(createProduct.mock.calls[0]![1].skus!.map((s) => s.sellerSku)).toEqual([vs[0]!.sku]);
    const [a, b] = await listings(ids);
    expect(a!.status).toBe('live');
    expect(b).toMatchObject({ status: 'push_failed', push_error: { code: 'price_missing' } });
  });

  it('mốc lượt khác pushStartedAt (lượt mới hơn đã thay): bỏ, không gọi sàn', async () => {
    const { productId, vs } = await product(['Nâu']);
    const { ids, job } = await lot(productId, vs);
    await runProductPush(port, { ...job, pushStartedAt: new Date(Date.parse(job.pushStartedAt) - 1000).toISOString() });
    expect(createProduct).not.toHaveBeenCalled();
    expect((await listings(ids))[0]!.status).toBe('pushing');
  });

  it('sàn từ chối: fail cả lượt, ghi lỗi lên dòng shop_products, không ghi mã sàn', async () => {
    const { productId, vs } = await product(['Cam', 'Xám']);
    onCreate = async () => {
      throw new MarketplaceError('rejected', 'C006', 'Thiếu thuộc tính');
    };
    const { spId, ids, job } = await lot(productId, vs);
    await runProductPush(port, job);
    expect((await listings(ids)).map((r) => r.status)).toEqual(['push_failed', 'push_failed']);
    expect(await shopProduct(spId)).toMatchObject({ external_product_id: null, push_error: { code: 'marketplace_rejected' } });
  });

  it('sàn lỗi tạm: ném để thử lại, listing vẫn pushing, tăng số lần thử', async () => {
    const { productId, vs } = await product(['Be']);
    onCreate = async () => {
      throw new MarketplaceError('unavailable');
    };
    const { ids, job } = await lot(productId, vs);
    await expect(runProductPush(port, job)).rejects.toMatchObject({ kind: 'unavailable' });
    expect((await listings(ids))[0]).toMatchObject({ status: 'pushing', push_attempts: 1, push_error: { code: 'marketplace_unavailable' } });
  });
});
