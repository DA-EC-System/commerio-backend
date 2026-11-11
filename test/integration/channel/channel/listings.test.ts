// Request đẩy listing chạy nền và gỡ listing (#104, #219; Documents/21 §18.3, §18.6.4). Việc nền chạy ở
// `listing-push.test.ts`; ở đây chỉ gọi handler khi cần listing có mã sàn.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ChannelListing, ListingList, PushResults } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import type { NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const productId = randomUUID();
const variant = (sku: string, extra: Partial<ListingVariant> = {}): ListingVariant => ({
  id: randomUUID(),
  productId,
  productName: 'Áo thun',
  sku,
  categoryId,
  attributesLabel: 'Đen / M',
  archived: false,
  businessStatus: 'selling',
  description: 'Áo cotton',
  weightG: 250,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 15,
  ...extra,
});
const ok = variant('CMR-OK');
const noPrice = variant('CMR-NOPRICE');
const noDims = variant('CMR-NODIMS', { weightG: null });
const unmapped = variant('CMR-UNMAPPED', { categoryId: randomUUID() });
const paused = variant('CMR-PAUSED', { businessStatus: 'paused' });
const archived = variant('CMR-ARCHIVED', { archived: true });
const all = [ok, noPrice, noDims, unmapped, paused, archived];
/** Biến thể thêm theo ca, mỗi ca một SKU mới để không phụ thuộc thứ tự. */
const fresh = (sku: string) => {
  const v = variant(`${sku}-${randomUUID().slice(0, 6)}`);
  all.push(v);
  return v;
};

const port = {
  variants: async (ids?: readonly string[]) => all.filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === noPrice.id ? null : new Decimal(150000)])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};
setProductPort(port);

const createProduct = vi.fn(async (_t: string, p: NewProduct) => ({ externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false }));
const deactivate = vi.fn(async () => {});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    uploadImage: async (_t, url) => `https://slatic.test/${encodeURIComponent(url)}`,
    createProduct,
    deactivate,
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
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const IMAGES = { [productId]: ['https://img.test/a.png'] };
const push = (variantIds: string[], imageUrls: Record<string, string[]> = IMAGES) =>
  auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({ variantIds, imageUrls });
const results = async (variantIds: string[], imageUrls?: Record<string, string[]>) => {
  const res = await push(variantIds, imageUrls);
  expect(res.status).toBe(200);
  return PushResults.parse(res.body).results;
};

async function rowsOf(variantId: string) {
  const { rows } = await testPool().query(
    `select id, status, seller_sku, external_product_id, external_sku_id, external_image_urls, push_error, push_attempts,
            reject_reason, replaces_listing_id, version from channel.listings where shop_id = $1 and variant_id = $2 order by created_at`,
    [shopId, variantId],
  );
  return rows;
}

async function jobsOf(listingId: string) {
  const { rows } = await testPool().query<{ data: Record<string, unknown> }>(
    "select data from pgboss.job where name = 'channel.listing_push' and data->>'listingId' = $1",
    [listingId],
  );
  return rows.map((r) => r.data);
}

/** Chạy việc nền của listing như worker: listing có mã sàn, `under_review`. */
async function runJob(listingId: string) {
  await runListingPush(port, { companyId: company.companyId, shopId, listingId, imageUrls: IMAGES[productId]! });
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  const map = await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
    externalCategoryId: '14275',
    attributes: { brand: 'No Brand' },
    version: null,
  });
  expect(map.status).toBe(200);
});

describe('đẩy listing: request chỉ kiểm và xếp việc', () => {
  it('AC-2…5, AC-12: mỗi dòng pushing hoặc mã chặn; không gọi sàn trong request; chỉ dòng hợp lệ có bản ghi và việc', async () => {
    const res = await results(all.slice(0, 6).map((v) => v.id));
    const byV = new Map(res.map((r) => [r.variantId, r]));
    expect(byV.get(ok.id)).toEqual({ variantId: ok.id, listingId: expect.any(String), status: 'pushing', code: null, message: null });
    expect(byV.get(noPrice.id)).toMatchObject({ listingId: null, status: null, code: 'price_missing' });
    expect(byV.get(noDims.id)).toMatchObject({ code: 'dimensions_missing' });
    expect(byV.get(unmapped.id)).toMatchObject({ code: 'category_unmapped' });
    expect(byV.get(paused.id)).toMatchObject({ code: 'sku_not_ready' });
    expect(byV.get(archived.id)).toMatchObject({ code: 'not_found' });
    expect(createProduct).not.toHaveBeenCalled();

    const [row] = await rowsOf(ok.id);
    expect(row).toMatchObject({ status: 'pushing', seller_sku: 'CMR-OK', push_attempts: 0 });
    expect(await jobsOf(row.id)).toEqual([{ companyId: company.companyId, shopId, listingId: row.id, imageUrls: ['https://img.test/a.png'] }]);
    expect(await rowsOf(noPrice.id)).toEqual([]);
    const history = await testPool().query(
      "select from_state, to_state, action, actor_id is null as by_system from core.state_transitions where entity_type = 'listings' and entity_id = $1",
      [row.id],
    );
    expect(history.rows).toEqual([{ from_state: null, to_state: 'pushing', action: 'push', by_system: false }]);
  });

  it('chưa có ảnh trên sàn mà không gửi URL ảnh thì images_missing', async () => {
    const v = fresh('CMR-NOIMG');
    expect((await results([v.id], {}))[0]).toMatchObject({ code: 'images_missing' });
  });

  it('AC-S1: listing đang pushing thì push_in_progress, không thêm việc', async () => {
    const [row] = await rowsOf(ok.id);
    expect((await results([ok.id]))[0]).toMatchObject({ listingId: row.id, status: 'pushing', code: 'push_in_progress' });
    expect(await jobsOf(row.id)).toHaveLength(1);
  });

  it('DoD#2, AC-6: hai request song song cùng SKU chỉ ra một bản ghi, một việc; request thua ra push_in_progress', async () => {
    const v = fresh('CMR-RACE');
    const [a, b] = await Promise.all([results([v.id]), results([v.id])]);
    const codes = [a[0]!.code, b[0]!.code].sort();
    expect(codes).toEqual([null, 'push_in_progress'].sort());
    const rows = await rowsOf(v.id);
    expect(rows).toHaveLength(1);
    expect(await jobsOf(rows[0].id)).toHaveLength(1);
  });

  it('AC-13: listing đã lên sàn (under_review, live, hidden) thì already_listed', async () => {
    const [row] = await rowsOf(ok.id);
    await runJob(row.id);
    expect((await rowsOf(ok.id))[0]).toMatchObject({ status: 'under_review', external_sku_id: 'sku-CMR-OK' });
    expect((await results([ok.id]))[0]).toMatchObject({ status: 'under_review', code: 'already_listed' });
  });

  it.each(['push_failed', 'rejected', 'platform_hold'] as const)(
    'AC-1, AC-14, C2-02…04: %s đẩy lại được, lượt mới đặt lại số lần thử, lỗi, lý do từ chối',
    async (from) => {
      const v = fresh(`CMR-${from}`);
      const { rows } = await testPool().query<{ id: string }>(
        `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id,
           external_image_urls, push_attempts, push_error, reject_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 3, $9, $10) returning id`,
        [
          company.companyId,
          shopId,
          v.id,
          v.sku,
          from,
          `P-${v.sku}`,
          `S-${v.sku}`,
          ['https://slatic.test/cu.png'],
          JSON.stringify({ code: 'marketplace_rejected', message: 'Sai', at: new Date().toISOString() }),
          from === 'rejected' ? 'Ảnh mờ' : null,
        ],
      );
      expect((await results([v.id], {}))[0]).toMatchObject({ listingId: rows[0]!.id, status: 'pushing', code: null });
      expect((await rowsOf(v.id))[0]).toMatchObject({ status: 'pushing', push_attempts: 0, push_error: null, reject_reason: null });
      expect(await jobsOf(rows[0]!.id)).toEqual([expect.objectContaining({ imageUrls: [] })]);
    },
  );

  it('AC-4, DoD#4: listing đã gỡ đẩy lại thành bản ghi mới trỏ bản cũ, chép mã sàn, SellerSku, ảnh; bảng hiện bản mới', async () => {
    const v = fresh('CMR-GO');
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, external_image_urls)
       values ($1, $2, $3, 'SKU-SAN-CU', 'delisted', 'P-CU', 'S-CU', $4)`,
      [company.companyId, shopId, v.id, ['https://slatic.test/cu.png']],
    );
    const [old] = await rowsOf(v.id);
    const res = (await results([v.id], {}))[0]!;
    expect(res).toMatchObject({ status: 'pushing', code: null });
    expect(res.listingId).not.toBe(old.id);
    const [before, now] = await rowsOf(v.id);
    expect(before).toMatchObject({ id: old.id, status: 'delisted', version: old.version });
    expect(now).toMatchObject({
      id: res.listingId,
      status: 'pushing',
      seller_sku: 'SKU-SAN-CU',
      external_product_id: 'P-CU',
      external_sku_id: 'S-CU',
      external_image_urls: ['https://slatic.test/cu.png'],
      replaces_listing_id: old.id,
    });
    const list = ListingList.parse((await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`))).body);
    expect(list.items.find((i) => i.variantId === v.id)!.listing).toMatchObject({ id: res.listingId, status: 'pushing' });
  });

  it('GET listings: mọi biến thể đang bán kèm listing hiện hành, đúng schema; pushError là object', async () => {
    const res = await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`));
    expect(res.status).toBe(200);
    const items = ListingList.parse(res.body).items;
    expect(items.map((i) => i.sku)).not.toContain('CMR-ARCHIVED');
    expect(items.find((i) => i.sku === 'CMR-OK')).toMatchObject({ price: 150000, listing: { status: 'under_review', pushError: null } });
    expect(items.find((i) => i.sku === 'CMR-NOPRICE')).toMatchObject({ price: null, listing: null });
  });

  it('kiểm đầu vào và quyền', async () => {
    expect((await push([])).status).toBe(422);
    expect((await push(Array.from({ length: 21 }, () => randomUUID()))).status).toBe(422);
    expect((await push([ok.id], { [productId]: ['ftp://x/a.png'] })).status).toBe(422);
    const sale = await addMember(company.companyId, 'sale');
    expect((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`), sale.token).send({ variantIds: [ok.id] })).status).toBe(403);
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await auth(app().get(`/api/v1/channel/shops/${shopId}/listings`), other.ceo.token)).status).toBe(404);
    // Biến thể của công ty khác: cổng không thấy (RLS) nên not_found.
    expect((await results([randomUUID()]))[0]).toMatchObject({ code: 'not_found', status: null });
  });
});

describe('gỡ listing', () => {
  it('tắt sản phẩm trên sàn rồi chuyển delisted; version cũ 409; chưa có listing 404', async () => {
    const [row] = await rowsOf(ok.id);
    const url = `/api/v1/channel/shops/${shopId}/listings/${ok.id}/delist`;
    expect((await auth(app().post(url)).send({ version: row.version + 5 })).status).toBe(409);
    const res = await auth(app().post(url)).send({ version: row.version });
    expect(res.status).toBe(200);
    expect(ChannelListing.parse(res.body)).toMatchObject({ status: 'delisted', platformStock: 0 });
    expect(deactivate).toHaveBeenCalledWith(expect.any(String), 'item-CMR-OK', 'sku-CMR-OK');
    const again = await auth(app().post(url)).send({ version: res.body.version });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('invalid_transition');
    expect((await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${noPrice.id}/delist`)).send({ version: 1 })).status).toBe(404);
  });

  it('listing đang pushing thì gỡ 409 invalid_transition (21 §18.6.4)', async () => {
    const v = fresh('CMR-PUSHING');
    await results([v.id]);
    const [row] = await rowsOf(v.id);
    const res = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/${v.id}/delist`)).send({ version: row.version });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('invalid_transition');
  });

  it('gian hàng đã ngắt: đẩy 409 shop_not_active kèm current', async () => {
    const shop = await auth(app().get(`/api/v1/channel/shops/${shopId}`));
    await auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send({ version: shop.body.version });
    const res = await push([fresh('CMR-OFF').id]);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_not_active', current: 'disconnected' });
  });
});

describe('AC-11: lỗi cả request theo thứ tự 21 §18.6.11, không dòng nào đổi, không xếp việc', () => {
  /** Gian hàng mới nối của công ty (`connecting`), chưa ghép danh mục. */
  async function newShop(): Promise<string> {
    const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    return res.body.shop.id as string;
  }
  const pushTo = (id: string) => auth(app().post(`/api/v1/channel/shops/${id}/listings/push`)).send({ variantIds: [ok.id], imageUrls: IMAGES });
  async function expectNothingWritten(id: string) {
    expect((await testPool().query('select 1 from channel.listings where shop_id = $1', [id])).rows).toEqual([]);
    const jobs = await testPool().query("select 1 from pgboss.job where name = 'channel.listing_push' and data->>'shopId' = $1", [id]);
    expect(jobs.rows).toEqual([]);
  }

  it.each(['connecting', 'needs_reauth'] as const)('gian hàng %s: 409 shop_not_active kèm current', async (status) => {
    const id = await newShop();
    if (status !== 'connecting') {
      await activateShop(id);
      await testPool().query('update channel.shops set status = $2 where id = $1', [id, status]);
    }
    const res = await pushTo(id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_not_active', current: status });
    await expectNothingWritten(id);
  });

  it('gian hàng active mà hết token: 409 shop_not_connected', async () => {
    const id = await newShop();
    await activateShop(id);
    await testPool().query('update channel.shops set access_token_enc = null where id = $1', [id]);
    const res = await pushTo(id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_connected');
    await expectNothingWritten(id);
  });

  it('chưa active và lượt đơn mở chưa xong cùng lúc: shop_not_active đứng trước', async () => {
    const id = await newShop();
    await testPool().query(
      "update channel.shops set status = 'needs_reauth', order_cutoff_at = now(), open_orders_pulled_at = null where id = $1",
      [id],
    );
    const res = await pushTo(id);
    expect(res.body).toMatchObject({ code: 'shop_not_active', current: 'needs_reauth' });
    await expectNothingWritten(id);
  });

  it.each([
    ['open_orders', 'open_orders_pulled_at = null, allocation_stocktake_id = null'],
    ['allocation', 'open_orders_pulled_at = now(), allocation_stocktake_id = gen_random_uuid()'],
  ] as const)('chờ phân hàng (%s) và hết token cùng lúc: shop_awaiting_allocation đứng trước shop_not_connected', async (waitingFor, set) => {
    const id = await newShop();
    await activateShop(id);
    await testPool().query(`update channel.shops set access_token_enc = null, ${set} where id = $1`, [id]);
    const res = await pushTo(id);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_awaiting_allocation', waitingFor });
    await expectNothingWritten(id);
  });
});
