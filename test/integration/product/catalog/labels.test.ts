import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductDetail, ProductPage } from '#src/modules/product/catalog/api/schemas.ts';
import { variantReadiness } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, archiveSku, businessStatus, createAttribute, createCategory, createProduct, uniq, valueId } from './helpers.ts';

// Ba lớp nhãn của SKU và nhãn cha suy từ con (#204 PR 3, Documents/21 §17.1, 25 §5.1–§5.4; spec mục 5.3; D7, D8).
let companyId: string;
let token: string;
let color: AttributeBody;
let shopA: string;
let shopB: string;

const newShop = async () => {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'lazada', $2, 'Shop Thử') returning id`,
    [companyId, randomUUID()],
  );
  return rows[0]!.id;
};

beforeAll(async () => {
  const company = await createCompany({ optionalModules: ['channel'] });
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xám', 'Nâu', 'Xanh', 'Đỏ']);
  shopA = await newShop();
  shopB = await newShop();
});

/** Sản phẩm `n` SKU (mỗi SKU một màu), danh mục riêng. */
async function product(n = 1, name = uniq('SP')) {
  const category = await createCategory(token, uniq('Nhãn'), 'NH-{SEQ}-{VAL}');
  const colors = ['Đen', 'Trắng', 'Xám', 'Nâu', 'Xanh', 'Đỏ'].slice(0, n);
  return createProduct(token, { name, categoryId: category.id, variants: colors.map((c) => [valueId(color, c)]) });
}

const listing = (variantId: string, status: string, shop = shopA) =>
  testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, status, seller_sku, reject_reason)
     values ($1, $2, $3, $4::channel.listing_status, $5, case when $4::text = 'rejected' then 'Sai danh mục' end)`,
    [companyId, shop, variantId, status, `CMR-${randomUUID().slice(0, 8)}`],
  );

/** Đủ mọi phần của SKU: giá muốn bán, số đo (PATCH), ngưỡng tồn (dòng tồn). Ảnh ở cha (`withImage`). */
async function complete(productId: string, variantId: string, version = 1) {
  const res = await api(token).patch(`/products/${productId}/variants/${variantId}`, {
    version,
    targetNetPrice: 150000,
    weightG: 200,
    lengthMm: 100,
    widthMm: 100,
    heightMm: 50,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await testPool().query(
    `insert into product.stock_levels (company_id, variant_id, min_qty) values ($1, $2, 3)
     on conflict (company_id, variant_id) do update set min_qty = 3`,
    [companyId, variantId],
  );
}

/** Ảnh gắn thẳng bảng (tệp không cần có thật: độ hoàn thiện chỉ đếm ảnh của cha). */
const withImage = (productId: string) =>
  testPool().query('insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, 0)', [
    companyId,
    productId,
    randomUUID(),
  ]);

const detail = async (productId: string) => {
  const res = await api(token).get(`/products/${productId}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const sku = (body: { variants: { id: string; [field: string]: unknown }[] }, id: string) => body.variants.find((v) => v.id === id)!;
const listItem = async (productId: string, query = '') => {
  const res = await api(token).get(`/products?pageSize=100${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return (res.body.items as { id: string }[]).find((p) => p.id === productId);
};

describe('độ hoàn thiện (US-SP-03)', () => {
  it('dòng 1: SKU mới thiếu mọi phần theo thứ tự cố định, readiness incomplete', async () => {
    const p = await product();
    const v = sku(await detail(p.id), p.variants[0]!.id);
    expect(v).toMatchObject({
      readiness: 'incomplete',
      missing: ['image', 'price', 'minQty', 'weight', 'dimensions'],
      minQty: null,
    });
  });

  it('dòng 2: điền đủ ảnh, giá muốn bán, ngưỡng tồn, số đo → ready; chi tiết khớp schema', async () => {
    const p = await product();
    await withImage(p.id);
    await complete(p.id, p.variants[0]!.id);
    const body = await detail(p.id);
    expect(sku(body, p.variants[0]!.id)).toMatchObject({ readiness: 'ready', missing: [], minQty: 3 });
    expect(body).toMatchObject({ incompleteCount: 0, variantTotal: 1 });
    expect(ProductDetail.parse(body)).toEqual(body);
  });

  it('dòng 3: cha không ảnh thì mọi SKU thiếu image; một cạnh trống là dimensions', async () => {
    const p = await product(2);
    await complete(p.id, p.variants[0]!.id);
    await complete(p.id, p.variants[1]!.id);
    await api(token).patch(`/products/${p.id}/variants/${p.variants[1]!.id}`, { version: 2, heightMm: null });
    const body = await detail(p.id);
    expect(sku(body, p.variants[0]!.id).missing).toEqual(['image']);
    expect(sku(body, p.variants[1]!.id).missing).toEqual(['image', 'dimensions']);
    expect(body.incompleteCount).toBe(2);
  });

  it('variantReadiness cho channel: đủ mọi id, cùng luật với chi tiết', async () => {
    const p = await product(2);
    await withImage(p.id);
    await complete(p.id, p.variants[0]!.id);
    const result = await withCompany(companyId, () => variantReadiness([p.variants[0]!.id, p.variants[1]!.id]));
    expect(result.get(p.variants[0]!.id)).toEqual({ readiness: 'ready', missing: [] });
    expect(result.get(p.variants[1]!.id)).toEqual({ readiness: 'incomplete', missing: ['price', 'minQty', 'weight', 'dimensions'] });
  });
});

describe('hiện diện trên sàn (US-SP-08, D8)', () => {
  it('dòng 1: SKU có listing live → presence live, listingCount 1', async () => {
    const p = await product();
    await listing(p.variants[0]!.id, 'live');
    expect(sku(await detail(p.id), p.variants[0]!.id)).toMatchObject({ presence: 'live', hasListingError: false, listingCount: 1 });
  });

  it('dòng 2: live và rejected → live kèm hasListingError; danh sách errorCount 1, labelCounts.live 1', async () => {
    const p = await product();
    await listing(p.variants[0]!.id, 'live', shopA);
    await listing(p.variants[0]!.id, 'rejected', shopB);
    expect(sku(await detail(p.id), p.variants[0]!.id)).toMatchObject({ presence: 'live', hasListingError: true, listingCount: 2 });
    expect(await listItem(p.id)).toMatchObject({ errorCount: 1, labelCounts: { live: 1, error: 0 } });
  });

  it('D8: chỉ rejected → error là nhãn chính; chỉ hidden → not_listed', async () => {
    const p = await product(2);
    await listing(p.variants[0]!.id, 'rejected');
    await listing(p.variants[1]!.id, 'hidden');
    const body = await detail(p.id);
    expect(sku(body, p.variants[0]!.id)).toMatchObject({ presence: 'error', hasListingError: true });
    expect(sku(body, p.variants[1]!.id)).toMatchObject({ presence: 'not_listed', hasListingError: false, listingCount: 1 });
    expect(body.labelCounts).toEqual({ archived: 0, discontinued: 0, paused: 0, live: 0, error: 1, pending: 0, not_listed: 1 });
  });

  it('dòng 3: cha 6 SKU, 4 có listing live → labelCounts.live 4; SKU tạm ngừng lấy nhãn paused', async () => {
    const p = await product(6);
    for (const v of p.variants.slice(0, 4)) await listing(v.id, 'live');
    expect((await businessStatus(token, p.id, 'pause', [p.variants[5]!.id])).status).toBe(200);
    expect(await listItem(p.id)).toMatchObject({
      variantCount: 6,
      variantTotal: 6,
      labelCounts: { live: 4, not_listed: 1, paused: 1 },
      incompleteCount: 6,
      errorCount: 0,
    });
  });
});

describe('nhãn cha và lọc danh sách', () => {
  it('dòng 4: mọi SKU lưu trữ → không ở danh sách mặc định, ở status=archived; thêm SKU mới thì hiện lại (Review Focus 5)', async () => {
    const p = await product(1, uniq('Lưu trữ hết'));
    await archiveSku(token, p.id, p.variants[0]!.id);
    expect(await listItem(p.id)).toBeUndefined();
    expect(await listItem(p.id, '&status=archived')).toMatchObject({
      status: 'archived',
      variantCount: 0,
      variantTotal: 1,
      labelCounts: { archived: 1 },
      incompleteCount: 0,
    });
    const added = await api(token).post(`/products/${p.id}/variants`, { attributeValueIds: [valueId(color, 'Trắng')] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body).toMatchObject({ readiness: 'incomplete', presence: 'not_listed', listingCount: 0 });
    expect(await listItem(p.id)).toMatchObject({ status: 'active', variantCount: 1, variantTotal: 2 });
  });

  it('businessStatus=paused chỉ trả sản phẩm có SKU tạm ngừng; archived → 422', async () => {
    const paused = await product(2);
    const selling = await product(1);
    expect((await businessStatus(token, paused.id, 'pause', [paused.variants[0]!.id])).status).toBe(200);
    const res = await api(token).get('/products?businessStatus=paused&pageSize=100');
    const ids = res.body.items.map((p: { id: string }) => p.id);
    expect(ids).toContain(paused.id);
    expect(ids).not.toContain(selling.id);
    const bad = await api(token).get('/products?businessStatus=archived');
    expect(bad.status).toBe(422);
    expect(bad.body.errors.businessStatus).toBeTruthy();
  });

  it('trang danh sách khớp schema ProductPage', async () => {
    await product(2);
    const res = await api(token).get('/products?pageSize=5');
    expect(ProductPage.parse(res.body)).toEqual(res.body);
  });
});

describe('số câu truy vấn của trang danh sách (Review Focus 2)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('trang 2 dòng và trang 20 dòng dùng cùng số câu', async () => {
    const own = await createCompany({ optionalModules: ['channel'] });
    const category = await createCategory(own.ceo.token, 'Đếm', 'DC-{SEQ}');
    for (let i = 0; i < 20; i++) {
      await createProduct(own.ceo.token, { name: `Đếm ${i}`, categoryId: category.id, variants: [[]] });
    }
    const count = async (pageSize: number) => {
      const spy = vi.spyOn(pg.Client.prototype, 'query');
      const res = await api(own.ceo.token).get(`/products?pageSize=${pageSize}`);
      expect(res.body.items).toHaveLength(pageSize);
      const n = spy.mock.calls.length;
      spy.mockRestore();
      expect(n).toBeGreaterThan(0);
      return n;
    };
    expect(await count(2)).toBe(await count(20));
  });
});
