import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProductDetail, ProductPage } from '#src/modules/product/catalog/api/schemas.ts';
import { variantReadiness } from '#src/modules/product/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { type AttributeBody, api, archiveSku, businessStatus, createAttribute, createGroup, createProduct, uniq, valueId } from './helpers.ts';

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
  const company = await createCompany({ optionalModules: [] });
  companyId = company.companyId;
  token = company.ceo.token;
  color = await createAttribute(token, 'Màu', ['Đen', 'Trắng', 'Xám', 'Nâu', 'Xanh', 'Đỏ']);
  shopA = await newShop();
  shopB = await newShop();
});

/** Sản phẩm `n` SKU (mỗi SKU một màu), nhóm hàng riêng. */
async function product(n = 1, name = uniq('SP')) {
  const group = await createGroup(token, uniq('Nhãn'), 'NH-{SEQ}-{VAL}');
  const colors = ['Đen', 'Trắng', 'Xám', 'Nâu', 'Xanh', 'Đỏ'].slice(0, n);
  return createProduct(token, { name, groupId: group.id, variants: colors.map((c) => [valueId(color, c)]) });
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
    const own = await createCompany({ optionalModules: [] });
    const group = await createGroup(own.ceo.token, 'Đếm', 'DC-{SEQ}');
    for (let i = 0; i < 20; i++) {
      await createProduct(own.ceo.token, { name: `Đếm ${i}`, groupId: group.id, variants: [[]] });
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

// Ảnh phân loại có một phần (#340, Documents/21 §17.1): đã có ảnh cho một giá trị đang dùng mà còn giá trị đang dùng
// (SKU chưa lưu trữ mang) chưa có ảnh thì mọi SKU thiếu `variantImages`.
describe('độ hoàn thiện: ảnh phân loại (#340, AC-12)', () => {
  /** Sản phẩm 3 SKU (Đen, Trắng, Xám) đã đủ mọi phần, chọn Màu làm thuộc tính gắn ảnh. */
  async function ready() {
    const p = await product(3);
    await withImage(p.id);
    for (const v of p.variants) await complete(p.id, v.id);
    await testPool().query('update product.products set image_attribute_id = $2 where id = $1', [p.id, color.id]);
    return p;
  }
  const image = (productId: string, value: string) =>
    testPool().query(
      `insert into product.product_attribute_value_images (company_id, product_id, attribute_id, attribute_value_id, file_id)
       values ($1, $2, $3, $4, $5)`,
      [companyId, productId, color.id, valueId(color, value), randomUUID()],
    );
  /** Kết quả ở ba nơi: chi tiết, danh sách (`incompleteCount`), `variantReadiness`. */
  async function everywhere(p: { id: string; variants: { id: string }[] }) {
    const body = await detail(p.id);
    const item = (await listItem(p.id)) as unknown as { incompleteCount: number };
    const port = await withCompany(companyId, () => variantReadiness(p.variants.map((v) => v.id)));
    return {
      detail: p.variants.map((v) => sku(body, v.id).missing),
      incompleteCount: [body.incompleteCount, item.incompleteCount],
      port: p.variants.map((v) => port.get(v.id)!.missing),
    };
  }

  it('chưa có ảnh phân loại nào, hoặc chưa chọn thuộc tính: không thiếu', async () => {
    const p = await ready();
    expect(await everywhere(p)).toEqual({ detail: [[], [], []], incompleteCount: [0, 0], port: [[], [], []] });
    await testPool().query('update product.products set image_attribute_id = null where id = $1', [p.id]);
    expect((await everywhere(p)).incompleteCount).toEqual([0, 0]);
  });

  it('có ảnh Đen, thiếu Trắng, Xám: mọi SKU thiếu variantImages ở chi tiết, danh sách, variantReadiness', async () => {
    const p = await ready();
    await image(p.id, 'Đen');
    const partial = ['variantImages'];
    expect(await everywhere(p)).toEqual({ detail: [partial, partial, partial], incompleteCount: [3, 3], port: [partial, partial, partial] });
    expect(sku(await detail(p.id), p.variants[0]!.id).readiness).toBe('incomplete');
  });

  it('variantImages đứng ngay sau image', async () => {
    const p = await product(2);
    await testPool().query('update product.products set image_attribute_id = $2 where id = $1', [p.id, color.id]);
    await image(p.id, 'Đen');
    expect(sku(await detail(p.id), p.variants[0]!.id).missing).toEqual(['image', 'variantImages', 'price', 'minQty', 'weight', 'dimensions']);
  });

  it('đủ ảnh mọi giá trị → hết thiếu; giá trị chỉ còn SKU lưu trữ mang thì không cần ảnh', async () => {
    const p = await ready();
    await image(p.id, 'Đen');
    await image(p.id, 'Trắng');
    await archiveSku(token, p.id, p.variants[2]!.id);
    const after = await everywhere(p);
    expect(after.detail.slice(0, 2)).toEqual([[], []]);
    expect(after.incompleteCount).toEqual([0, 0]);
    await image(p.id, 'Xám');
    expect((await everywhere(p)).detail).toEqual([[], [], []]);
  });

  it('ảnh chỉ nằm ở giá trị mà mọi SKU mang nó đã lưu trữ: không tính là có một phần', async () => {
    const p = await ready();
    await archiveSku(token, p.id, p.variants[0]!.id);
    await image(p.id, 'Đen');
    expect((await everywhere(p)).incompleteCount).toEqual([0, 0]);
  });
});

describe('lọc readiness (Documents/21 §17.2, lọc "Chờ hoàn thiện")', () => {
  const ids = async (query: string) => {
    const res = await api(token).get(`/products?pageSize=100${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { items: { id: string; incompleteCount: number }[]; total: number };
  };

  it('incomplete: có SKU chưa lưu trữ thiếu; ready: mọi SKU chưa lưu trữ đủ; SKU lưu trữ không tính', async () => {
    const done = await product(2);
    await withImage(done.id);
    for (const v of done.variants) await complete(done.id, v.id);
    const half = await product(2);
    await withImage(half.id);
    await complete(half.id, half.variants[0]!.id);
    const archivedGap = await product(2);
    await withImage(archivedGap.id);
    await complete(archivedGap.id, archivedGap.variants[0]!.id);
    await archiveSku(token, archivedGap.id, archivedGap.variants[1]!.id);
    const noImage = await product(1);
    await complete(noImage.id, noImage.variants[0]!.id);

    const incomplete = (await ids('&readiness=incomplete')).items.map((p) => p.id);
    const ready = (await ids('&readiness=ready')).items.map((p) => p.id);
    expect(incomplete).toEqual(expect.arrayContaining([half.id, noImage.id]));
    expect(incomplete).not.toContain(done.id);
    expect(incomplete).not.toContain(archivedGap.id);
    expect(ready).toEqual(expect.arrayContaining([done.id, archivedGap.id]));
    expect(ready).not.toContain(half.id);
  });

  it('thông số bắt buộc của mẫu nhóm còn trống làm sản phẩm incomplete', async () => {
    const groups = (await api(token).get('/groups')).body.items as { id: string; requiredCount: number }[];
    const withRequired = groups.find((g) => g.requiredCount > 0)!;
    const p = await createProduct(token, { name: uniq('Thông số'), groupId: withRequired.id, variants: [[valueId(color, 'Đen')]] });
    await withImage(p.id);
    await complete(p.id, p.variants[0]!.id);
    expect((await ids('&readiness=incomplete')).items.map((x) => x.id)).toContain(p.id);
  });

  it('bộ lọc khớp incompleteCount của từng dòng trên mọi sản phẩm của công ty; giá trị lạ 422', async () => {
    const all = await ids('');
    expect(all.total).toBeLessThanOrEqual(100);
    const incomplete = new Set((await ids('&readiness=incomplete')).items.map((p) => p.id));
    const ready = new Set((await ids('&readiness=ready')).items.map((p) => p.id));
    for (const p of all.items) {
      expect([p.id, incomplete.has(p.id)]).toEqual([p.id, p.incompleteCount > 0]);
      expect([p.id, ready.has(p.id)]).toEqual([p.id, p.incompleteCount === 0]);
    }
    const bad = await api(token).get('/products?readiness=done');
    expect(bad.status).toBe(422);
    expect(bad.body.errors.readiness).toBeTruthy();
  });
});
