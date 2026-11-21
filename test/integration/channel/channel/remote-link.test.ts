// Liên kết SKU sàn ngoài thiết lập gian hàng (Documents/21 §18.9 R2): gợi ý ở `remote-skus`, liên kết hàng loạt, tạo SKU kho
// từ SKU sàn. Cổng catalog thật; bản sao SKU sàn chèn thẳng (không gọi sàn). Mỗi ca dùng SKU sàn riêng.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateVariantResult, MatchBulkResult, RemoteSkuList } from '#src/modules/channel/channel/api/schemas.ts';
import { getAdapter, registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import type { RemoteProductCategory } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { clearFillBackCache } from '#src/modules/channel/channel/service/fill-back.ts';
import { setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
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
const as = (token: string) => (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
const ceo = (r: request.Test) => as(company.ceo.token)(r);

/** Một SKU sàn trong bản sao của gian hàng (như sau lần Tải lại). */
async function remoteSku(sellerSku: string, title = `Cốc thử ${randomUUID().slice(0, 6)}`) {
  const externalSkuId = `sku-${randomUUID().slice(0, 10)}`;
  await db().query(
    `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity, price)
     values ($1, $2, $3, $4, $5, $6, 'live', 3, 120000)`,
    [company.companyId, shopId, `item-${externalSkuId}`, externalSkuId, sellerSku, title],
  );
  return externalSkuId;
}
const list = async () => {
  const res = await ceo(app().get(`/api/v1/channel/shops/${shopId}/remote-skus`));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return RemoteSkuList.parse(res.body).items;
};

beforeAll(async () => {
  company = await createCompany({ optionalModules: [] });
  const res = await ceo(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  // Có bản sao rồi: GET không xếp lượt tải nền.
  await db().query('update channel.shops set remote_skus_synced_at = now() where id = $1', [shopId]);
  saleToken = (await addMember(company.companyId, 'sale')).token;
});

describe('GET remote-skus: gợi ý liên kết', () => {
  it('SKU người bán trùng SKU kho: gợi ý match sku, không tạo được (sku_taken); liên kết xong thì hết gợi ý (already_matched)', async () => {
    const v = await createVariant(company.companyId);
    const ext = await remoteSku(v.sku);
    const before = (await list()).find((i) => i.externalSkuId === ext)!;
    expect(before).toMatchObject({ suggestion: { variantId: v.variantId, sku: v.sku, match: 'sku', score: null }, canCreate: false, cannotCreateReason: 'sku_taken' });
    expect((await ceo(app().post(`/api/v1/channel/shops/${shopId}/listings/match`)).send({ externalSkuId: ext, variantId: v.variantId })).status).toBe(200);
    const after = (await list()).find((i) => i.externalSkuId === ext)!;
    expect(after).toMatchObject({ mode: 'mapped', suggestion: null, canCreate: false, cannotCreateReason: 'already_matched' });
  });

  it('SKU người bán chưa có trong kho: không gợi ý theo SKU, tạo được', async () => {
    const ext = await remoteSku(`NEW-${randomUUID().slice(0, 8)}`);
    expect((await list()).find((i) => i.externalSkuId === ext)).toMatchObject({ canCreate: true, cannotCreateReason: null });
  });
});

describe('POST listings/match-bulk', () => {
  const bulk = (pairs: unknown[]) => ceo(app().post(`/api/v1/channel/shops/${shopId}/listings/match-bulk`)).send({ pairs });

  it('thành công được một phần: 200, cặp lỗi mang mã của listings/match', async () => {
    const v = await createVariant(company.companyId);
    const ok = await remoteSku(v.sku);
    const bad = await remoteSku(`X-${randomUUID().slice(0, 8)}`);
    const res = await bulk([
      { externalSkuId: ok, variantId: v.variantId },
      { externalSkuId: bad, variantId: randomUUID() },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(MatchBulkResult.parse(res.body).results).toMatchObject([
      { externalSkuId: ok, outcome: 'matched', code: null },
      { externalSkuId: bad, outcome: 'failed', code: 'validation_failed' },
    ]);
    const { rows } = await db().query('select variant_id from channel.listings where shop_id = $1 and external_sku_id = $2', [shopId, ok]);
    expect(rows).toEqual([{ variant_id: v.variantId }]);
  });

  it('hai cặp trùng SKU sàn: 422 ở cặp sau, không ghi cặp nào', async () => {
    const v = await createVariant(company.companyId);
    const ext = await remoteSku(v.sku);
    const res = await bulk([
      { externalSkuId: ext, variantId: v.variantId },
      { externalSkuId: ext, variantId: v.variantId },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual({ 'pairs.1.externalSkuId': expect.any(String) });
    const { rowCount } = await db().query('select 1 from channel.listings where shop_id = $1 and external_sku_id = $2', [shopId, ext]);
    expect(rowCount).toBe(0);
  });
});

describe('POST remote-skus/:externalSkuId/create-variant', () => {
  const create = (ext: string, groupId: string, token = company.ceo.token) =>
    as(token)(app().post(`/api/v1/channel/shops/${shopId}/remote-skus/${ext}/create-variant`)).send({ groupId });

  it('SKU người bán mới: 201, tạo SKU kho mã = SKU người bán, giá chuẩn = giá sàn, liên kết live', async () => {
    const { groupId } = await createVariant(company.companyId);
    const sellerSku = `NEW-${randomUUID().slice(0, 8)}`;
    const ext = await remoteSku(sellerSku);
    const res = await create(ext, groupId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = CreateVariantResult.parse(res.body);
    expect(body).toMatchObject({ created: true, pending: false, listing: { status: 'live' } });
    const { rows } = await db().query('select sku, standard_price from product.product_variants where id = $1', [body.variantId]);
    expect(rows[0]).toEqual({ sku: sellerSku, standard_price: '120000.00' });
    const linked = await db().query('select variant_id from channel.listings where shop_id = $1 and external_sku_id = $2', [shopId, ext]);
    expect(linked.rows).toEqual([{ variant_id: body.variantId }]);
  });

  it('SKU người bán trùng SKU kho có sẵn: 200, liên kết vào SKU đó, không tạo', async () => {
    const v = await createVariant(company.companyId);
    const ext = await remoteSku(v.sku);
    const res = await create(ext, v.groupId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ variantId: v.variantId, created: false, pending: false });
  });

  it('không có SKU người bán: 422 errors.externalSkuId; Sale thiếu quyền tạo sản phẩm: 403, không tạo gì', async () => {
    const { groupId } = await createVariant(company.companyId);
    const empty = await remoteSku('');
    const res = await create(empty, groupId);
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveProperty('externalSkuId');
    const sellerSku = `NEW-${randomUUID().slice(0, 8)}`;
    const forbidden = await create(await remoteSku(sellerSku), groupId, saleToken);
    expect(forbidden.status).toBe(403);
    const { rowCount } = await db().query('select 1 from product.product_variants where company_id = $1 and sku = $2', [company.companyId, sellerSku]);
    expect(rowCount).toBe(0);
  });

  // KB3 3.4: SKU anh em của một sản phẩm sàn đã liên kết vào sản phẩm app thì thành biến thể của sản phẩm đó.
  async function siblings(title: string, skus: { sellerSku: string; label: string }[]) {
    const product = `item-${randomUUID().slice(0, 10)}`;
    const ids: string[] = [];
    for (const k of skus) {
      const ext = `sku-${randomUUID().slice(0, 10)}`;
      await db().query(
        `insert into channel.remote_skus (company_id, shop_id, external_product_id, external_sku_id, seller_sku, title, state, quantity, price)
         values ($1, $2, $3, $4, $5, $6, 'live', 3, 99000)`,
        [company.companyId, shopId, product, ext, k.sellerSku, `${title} - ${k.label}`],
      );
      ids.push(ext);
    }
    return ids;
  }

  /** Sản phẩm app "Son lì …" một thuộc tính Màu son {Đỏ}, hai SKU sàn Đỏ (liên kết sẵn) và một SKU mới. */
  async function lipstick(camTitleTail: string) {
    const groups = await ceo(app().get('/api/v1/catalog/groups'));
    const groupId = groups.body.items[0].id as string;
    const made = await ceo(app().post('/api/v1/catalog/products')).send({
      name: `Son lì ${randomUUID().slice(0, 6)}`,
      groupId,
      description: '',
      imageFileIds: [],
      axes: [{ name: 'Màu son', values: [{ value: 'Đỏ' }] }],
      variants: [{ options: ['Đỏ'] }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const red = made.body.variants[0] as { id: string; sku: string };
    const cam = `SON-CAM-${randomUUID().slice(0, 6)}`;
    const [redExt, camExt] = await siblings('Son lì bản thử', [
      { sellerSku: red.sku, label: 'Đỏ' },
      { sellerSku: cam, label: camTitleTail },
    ]);
    expect((await ceo(app().post(`/api/v1/channel/shops/${shopId}/listings/match`)).send({ externalSkuId: redExt, variantId: red.id })).status).toBe(200);
    const { rows } = await db().query<{ external_product_id: string }>('select external_product_id from channel.remote_skus where external_sku_id = $1', [camExt]);
    return { groupId, productId: made.body.id as string, red, cam, camExt: camExt!, externalProductId: rows[0]!.external_product_id };
  }
  const valuesOf = async (productId: string) =>
    ((await ceo(app().get(`/api/v1/catalog/products/${productId}`))).body.variants as { sku: string; attributes: { value: string }[] }[]).map((v) => [
      v.sku,
      v.attributes.map((a) => a.value),
    ]);
  function withSaleValues(externalProductId: string, bySku: Record<string, string[]>) {
    const lazada = getAdapter('lazada') as { productCategory?: (t: string, id: string) => Promise<RemoteProductCategory | null> };
    clearFillBackCache();
    lazada.productCategory = async (_t, id) => ({
      externalCategoryId: '1',
      attributes: [],
      facts: {
        brand: null,
        description: null,
        imageUrls: [],
        sizeChartUrl: null,
        skus: id === externalProductId ? Object.entries(bySku).map(([externalSkuId, saleValues]) => ({ externalSkuId, saleValues, weightG: null, lengthMm: null, widthMm: null, heightMm: null })) : [],
      },
    });
    return () => {
      delete lazada.productCategory;
      clearFillBackCache();
    };
  }

  it('KB3: giá trị phân loại lấy từ sàn (Get Product), không đoán từ tên', async () => {
    const p = await lipstick('Cam đất tên dài khác');
    const restore = withSaleValues(p.externalProductId, { [p.camExt]: ['Cam đất'] });
    try {
      expect((await create(p.camExt, p.groupId)).status).toBe(201);
    } finally {
      restore();
    }
    expect(await valuesOf(p.productId)).toEqual([
      [p.red.sku, ['Đỏ']],
      [p.cam, ['Cam đất']],
    ]);
  });

  it('KB3: sàn có hai giá trị phân loại mà sản phẩm app một thuộc tính: tạo sản phẩm riêng như trước', async () => {
    const p = await lipstick('Cam, M');
    const restore = withSaleValues(p.externalProductId, { [p.camExt]: ['Cam', 'M'] });
    try {
      expect((await create(p.camExt, p.groupId)).status).toBe(201);
    } finally {
      restore();
    }
    expect((await valuesOf(p.productId)).map((v) => v[0])).toEqual([p.red.sku]);
  });

  it('KB3: SKU anh em của sản phẩm sàn đã liên kết vào sản phẩm app (một thuộc tính biến thể), sàn không trả giá trị phân loại: tách nhãn từ tên', async () => {
    const groups = await ceo(app().get('/api/v1/catalog/groups'));
    const groupId = groups.body.items[0].id as string;
    const name = `Son lì ${randomUUID().slice(0, 6)}`;
    const made = await ceo(app().post('/api/v1/catalog/products')).send({
      name,
      groupId,
      description: '',
      imageFileIds: [],
      axes: [{ name: 'Màu son', values: [{ value: 'Đỏ' }] }],
      variants: [{ options: ['Đỏ'] }],
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const red = made.body.variants[0] as { id: string; sku: string };
    const cam = `SON-CAM-${randomUUID().slice(0, 6)}`;
    const [redExt, camExt] = await siblings('Son lì mềm mịn lâu trôi - bản thử', [
      { sellerSku: red.sku, label: 'Đỏ' },
      { sellerSku: cam, label: 'Cam' },
    ]);
    expect((await ceo(app().post(`/api/v1/channel/shops/${shopId}/listings/match`)).send({ externalSkuId: redExt, variantId: red.id })).status).toBe(200);

    const res = await create(camExt!, groupId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const body = CreateVariantResult.parse(res.body);
    expect(body).toMatchObject({ created: true, listing: { status: 'live' } });
    const detail = await ceo(app().get(`/api/v1/catalog/products/${made.body.id}`));
    expect(detail.body.variants.map((v: { sku: string; attributes: { value: string }[] }) => [v.sku, v.attributes.map((a) => a.value)])).toEqual([
      [red.sku, ['Đỏ']],
      [cam, ['Cam']],
    ]);
    const { rowCount } = await db().query('select 1 from product.products where company_id = $1 and code = $2', [company.companyId, cam]);
    expect(rowCount).toBe(0);
  });

  it('KB3: SKU anh em đã liên kết vào sản phẩm không có thuộc tính biến thể: vẫn tạo sản phẩm riêng như trước', async () => {
    const v = await createVariant(company.companyId);
    const other = `SON-X-${randomUUID().slice(0, 6)}`;
    const [aExt, bExt] = await siblings('Cốc gốm thử', [
      { sellerSku: v.sku, label: 'Trắng' },
      { sellerSku: other, label: 'Đen' },
    ]);
    expect((await ceo(app().post(`/api/v1/channel/shops/${shopId}/listings/match`)).send({ externalSkuId: aExt, variantId: v.variantId })).status).toBe(200);
    const res = await create(bExt!, v.groupId);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { rows } = await db().query<{ product_id: string }>('select product_id from product.product_variants where id = $1', [res.body.variantId]);
    expect(rows[0]!.product_id).not.toBe(v.productId);
  });
});
