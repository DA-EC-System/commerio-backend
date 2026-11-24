// Liên kết SKU sàn theo sản phẩm sàn (#565, Documents/21 §18.12): `GET remote-products` (trang theo sản phẩm sàn, tìm bỏ dấu,
// đếm theo trạng thái, gợi ý kèm độ tin cậy) và `POST sku-links` (link, unmanaged, create gom theo sản phẩm sàn). Cổng catalog
// thật; bản sao SKU sàn chèn thẳng (không gọi sàn). Mỗi ca dùng sản phẩm sàn riêng, tên có mã riêng để tìm không lẫn ca khác.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RemoteProductList, SkuLinksResult } from '#src/modules/channel/channel/api/schemas.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createAttribute, createGroup, createProduct, uniq, valueId } from '../../product/catalog/helpers.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

registerAdapter(
  'lazada',
  fakeAdapter({ getSeller: async (accessToken) => ({ externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' }) }),
);
setProductPort(null);
afterAll(async () => {
  resetAdapters();
  await stopJobs();
});

const app = () => request(testApp());
const db = () => testPool();
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId = '';
let saleToken = '';
let groupId = '';
const as = (token: string) => (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const ceo = (r: request.Test) => as(company.ceo.token)(r);
/** Mã chữ thường không dấu để tìm đúng sản phẩm sàn của ca. */
const tag = () =>
  Array.from(randomUUID().replace(/-/g, '').slice(0, 8), (c) => String.fromCharCode(97 + (parseInt(c, 16) % 26))).join('');

async function newShop(): Promise<string> {
  const res = await ceo(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  return res.body.shop.id as string;
}

/** Một sản phẩm sàn nhiều SKU trong bản sao; trả mã sản phẩm và mã SKU theo thứ tự nhãn. */
async function remoteProduct(
  title: string,
  skus: { sellerSku?: string; label?: string | null }[],
  shop = shopId,
): Promise<{ productId: string; skuIds: string[] }> {
  const productId = `item-${randomUUID().slice(0, 10)}`;
  const skuIds: string[] = [];
  for (const s of skus) {
    const externalSkuId = `sku-${randomUUID().slice(0, 10)}`;
    skuIds.push(externalSkuId);
    await db().query(
      `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, variant_label, state, quantity, price)
       values ($1, $2, $3, $4, $5, $6, $7, 'live', 3, 150000)`,
      [company.companyId, shop, productId, externalSkuId, s.sellerSku ?? `NEW-${randomUUID().slice(0, 8)}`, title, s.label ?? null],
    );
  }
  return { productId, skuIds };
}

const products = async (query: Record<string, string | number>, token = company.ceo.token) => {
  const res = await as(token)(app().get(`/api/v1/channel/shops/${shopId}/remote-products`)).query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return RemoteProductList.parse(res.body);
};
const links = (body: object, token = company.ceo.token, shop = shopId) =>
  as(token)(app().post(`/api/v1/channel/shops/${shop}/sku-links`)).send(body);

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  shopId = await newShop();
  await activateShop(shopId);
  // Có bản sao rồi: GET không xếp lượt tải nền.
  await db().query('update channel.shops set remote_skus_synced_at = now() where id = $1', [shopId]);
  saleToken = (await addMember(company.companyId, 'sale')).token;
  groupId = (await createVariant(company.companyId)).groupId;
});

describe('GET remote-products', () => {
  it('phân trang theo sản phẩm sàn: mọi SKU của một sản phẩm nằm cùng trang; tìm "ao thun" ra "Áo thun"', async () => {
    const t = tag();
    const a = await remoteProduct(`Áo thun ${t} A`, [{ label: 'Đỏ' }, { label: 'Xanh' }, { label: 'Vàng' }]);
    const b = await remoteProduct(`Áo thun ${t} B`, [{ label: null }]);

    const p1 = await products({ status: 'all', search: `AO THUN ${t}`, pageSize: 1, page: 1 });
    const p2 = await products({ status: 'all', search: `ao thun ${t}`, pageSize: 1, page: 2 });

    expect(p1.total).toBe(2);
    expect(p1.items.map((i) => [i.externalProductId, i.skus.length])).toEqual([[a.productId, 3]]);
    expect(p1.items[0]!.skus.map((s) => s.variantLabel).sort()).toEqual(['Vàng', 'Xanh', 'Đỏ'].sort());
    expect(p2.items.map((i) => [i.externalProductId, i.skus.length])).toEqual([[b.productId, 1]]);
    expect(p1.items[0]).toMatchObject({ suggestedGroupId: null, skus: [{ decision: null }, { decision: null }, { decision: null }] });
  });

  it('counts không phụ thuộc ô tìm và lọc trạng thái', async () => {
    await remoteProduct(`Quần ${tag()}`, [{}]);
    const all = await products({ status: 'all' });
    const searched = await products({ status: 'linked', search: tag() });
    expect(searched.items).toEqual([]);
    expect(searched.counts).toEqual(all.counts);
    expect(all.counts.unlinked).toBeGreaterThan(0);
  });

  it('SKU người bán trùng SKU kho: gợi ý match sku, confidence high', async () => {
    const t = tag();
    const v = await createVariant(company.companyId);
    await remoteProduct(`Cốc ${t}`, [{ sellerSku: v.sku }]);
    const page = await products({ search: t });
    expect(page.items[0]!.skus[0]).toMatchObject({
      suggestion: { variantId: v.variantId, match: 'sku', score: null, confidence: 'high' },
      canCreate: false,
      cannotCreateReason: 'sku_taken',
    });
  });

  it('Sale xin "không quản tồn": SKU sang pending, không còn ở unlinked', async () => {
    const t = tag();
    const { skuIds } = await remoteProduct(`Ví ${t}`, [{}]);
    const before = await products({ status: 'all' });
    const res = await links({ items: [{ externalSkuId: skuIds[0], action: 'unmanaged' }] }, saleToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(SkuLinksResult.parse(res.body).results).toMatchObject([{ externalSkuId: skuIds[0], result: 'pending' }]);

    expect((await products({ status: 'pending', search: t })).items.map((i) => i.skus[0]!.externalSkuId)).toEqual([skuIds[0]]);
    expect((await products({ status: 'unlinked', search: t })).items).toEqual([]);
    const after = await products({ status: 'all' });
    expect(after.counts.pending).toBe(before.counts.pending + 1);
    expect(after.counts.unlinked).toBe(before.counts.unlinked - 1);
  });

  it('Kho (không có listing.match): 403', async () => {
    const warehouse = (await addMember(company.companyId, 'warehouse')).token;
    const res = await as(warehouse)(app().get(`/api/v1/channel/shops/${shopId}/remote-products`));
    expect(res.status).toBe(403);
  });
});

describe('POST sku-links', () => {
  const variantsOf = async (externalSkuIds: string[]) =>
    (
      await db().query<{ external_sku_id: string; product_id: string; sku: string }>(
        `select l.external_sku_id, v.product_id, v.sku from channel.listings l join product.product_variants v on v.id = l.variant_id
          where l.shop_id = $1 and l.external_sku_id = any($2) and l.status <> 'delisted'`,
        [shopId, externalSkuIds],
      )
    ).rows;

  it('3 SKU create cùng sản phẩm sàn: một sản phẩm kho 3 biến thể; lần sau thêm SKU thứ tư vào đúng sản phẩm đó', async () => {
    const t = tag();
    const { productId, skuIds } = await remoteProduct(`Áo ${t}`, [{ label: 'S' }, { label: 'M' }, { label: 'L' }, { label: 'XL' }]);
    const first = skuIds.slice(0, 3);

    const res = await links({ items: first.map((externalSkuId) => ({ externalSkuId, action: 'create' })), groups: [{ externalProductId: productId, groupId }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const results = SkuLinksResult.parse(res.body).results;
    expect(results.map((r) => r.result)).toEqual(['created', 'created', 'created']);
    const rows = await variantsOf(first);
    expect(rows).toHaveLength(3);
    const parent = rows[0]!.product_id;
    expect(new Set(rows.map((r) => r.product_id))).toEqual(new Set([parent]));
    expect(results.every((r) => r.productId === parent)).toBe(true);

    const again = await links({ items: [{ externalSkuId: skuIds[3], action: 'create' }], groups: [{ externalProductId: productId, groupId }] });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body.results).toMatchObject([{ result: 'created', productId: parent }]);
    expect((await variantsOf([skuIds[3]!]))[0]!.product_id).toBe(parent);
  });

  it('SKU anh em ở hai sản phẩm kho: dòng create báo platform_product_split, không tạo', async () => {
    const v1 = await createVariant(company.companyId);
    const v2 = await createVariant(company.companyId);
    const { productId, skuIds } = await remoteProduct(`Giày ${tag()}`, [{ sellerSku: v1.sku }, { sellerSku: v2.sku }, { label: 'Đen' }]);
    const linked = await links({
      items: [
        { externalSkuId: skuIds[0], action: 'link', variantId: v1.variantId },
        { externalSkuId: skuIds[1], action: 'link', variantId: v2.variantId },
      ],
    });
    expect(linked.body.results.map((r: { result: string }) => r.result)).toEqual(['linked', 'linked']);

    const res = await links({ items: [{ externalSkuId: skuIds[2], action: 'create' }], groups: [{ externalProductId: productId, groupId }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ result: 'error', code: 'platform_product_split' }]);
    expect(await variantsOf([skuIds[2]!])).toEqual([]);
  });

  it('SKU anh em đã liên kết vào sản phẩm kho hai thuộc tính: dòng create báo platform_product_split, không tạo sản phẩm thứ hai', async () => {
    const color = await createAttribute(company.ceo.token, uniq('Màu'), ['Đen', 'Trắng']);
    const size = await createAttribute(company.ceo.token, uniq('Cỡ'), ['S', 'M']);
    const group = await createGroup(company.ceo.token, uniq('Hai trục'), 'HT-{SEQ}-{VAL}');
    const p = await createProduct(company.ceo.token, {
      name: uniq('SP hai trục'),
      groupId: group.id,
      variants: [[valueId(color, 'Đen'), valueId(size, 'S')]],
    });
    const v = p.variants[0]!;
    const { productId, skuIds } = await remoteProduct(`Áo khoác ${tag()}`, [{ sellerSku: v.sku }, { label: 'Trắng, M' }]);
    const linked = await links({ items: [{ externalSkuId: skuIds[0], action: 'link', variantId: v.id }] });
    expect(linked.body.results).toMatchObject([{ result: 'linked' }]);

    const res = await links({ items: [{ externalSkuId: skuIds[1], action: 'create' }], groups: [{ externalProductId: productId, groupId }] });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([{ result: 'error', code: 'platform_product_split' }]);
    expect(await variantsOf([skuIds[1]!])).toEqual([]);
  });

  it('một dòng create lỗi (SKU đã có trong kho): cả nhóm không tạo, dòng kia báo group_failed', async () => {
    const v = await createVariant(company.companyId);
    const { productId, skuIds } = await remoteProduct(`Mũ ${tag()}`, [{ sellerSku: v.sku, label: 'Trắng' }, { label: 'Đen' }]);
    const res = await links({
      items: skuIds.map((externalSkuId) => ({ externalSkuId, action: 'create' })),
      groups: [{ externalProductId: productId, groupId }],
    });
    expect(res.status).toBe(200);
    expect(res.body.results).toMatchObject([
      { result: 'error', code: 'sku_taken' },
      { result: 'error', code: 'group_failed' },
    ]);
    const { rowCount } = await db().query('select 1 from channel.listings where shop_id = $1 and external_sku_id = any($2)', [shopId, skuIds]);
    expect(rowCount).toBe(0);
  });

  it('thiếu groups cho sản phẩm sàn có dòng create: 422 kèm externalProductIds', async () => {
    const { productId, skuIds } = await remoteProduct(`Túi ${tag()}`, [{}]);
    const res = await links({ items: [{ externalSkuId: skuIds[0], action: 'create' }] });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ errors: { groups: expect.any(String) }, externalProductIds: [productId] });
  });

  it('Sale có dòng create (thiếu quyền tạo sản phẩm): 403', async () => {
    const { productId, skuIds } = await remoteProduct(`Khăn ${tag()}`, [{}]);
    const res = await links({ items: [{ externalSkuId: skuIds[0], action: 'create' }], groups: [{ externalProductId: productId, groupId }] }, saleToken);
    expect(res.status).toBe(403);
  });

  it('skip ở gian hàng đang bán: 422 errors.items.0.action; link thiếu variantId, trùng dòng: 422', async () => {
    const { skuIds } = await remoteProduct(`Ly ${tag()}`, [{}]);
    const skip = await links({ items: [{ externalSkuId: skuIds[0], action: 'skip' }] });
    expect(skip.status).toBe(422);
    expect(skip.body.errors).toHaveProperty(['items.0.action']);
    const bad = await links({
      items: [
        { externalSkuId: skuIds[0], action: 'link' },
        { externalSkuId: skuIds[0], action: 'unmanaged' },
      ],
    });
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual(['items.0.variantId', 'items.1.externalSkuId']);
  });

  it('gian hàng connecting: 501 not_implemented (nháp thiết lập là be#569)', async () => {
    const connecting = await newShop();
    const res = await links({ items: [], draftVersion: 0 }, company.ceo.token, connecting);
    expect(res.status).toBe(501);
    expect(res.body.code).toBe('not_implemented');
  });

  it('gian hàng needs_reauth: 409 shop_not_connected kèm current', async () => {
    const lost = await newShop();
    await activateShop(lost);
    await db().query("update channel.shops set status = 'needs_reauth', orders_pulled_ok_at = null where id = $1", [lost]);
    const res = await links({ items: [] }, company.ceo.token, lost);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_not_connected', current: 'needs_reauth' });
  });
});
