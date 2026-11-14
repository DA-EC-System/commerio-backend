import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { ListingSyncResult } from '#src/modules/channel/channel/api/schemas.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { markStockPending, syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import type { PerSkuResult, RemoteSku, RemoteState } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const variant = (sku: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Áo',
  sku,
  categoryId,
  attributesLabel: '',
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const a = variant('CMR-A');
const b = variant('CMR-B');
const c = variant('CMR-C');
const available = new Map([
  [a.id, 5],
  [b.id, 5],
  [c.id, 5],
]);

const port = {
  variants: async (ids?: readonly string[]) => [a, b, c].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(99000)])),
  // Như cổng thật: id không có trong `available` thì không có trong Map.
  productImageUrls: async () => new Map<string, string[]>(),
  availableOf: async (ids: readonly string[]) =>
    new Map(ids.flatMap((id): [string, number][] => (available.has(id) ? [[id, available.get(id)!]] : []))),
};
setProductPort(port);

/** Trạng thái trên sàn theo SellerSku; test đổi giữa các lần đồng bộ. */
const remote = new Map<string, { state: RemoteState; rejectReason?: string }>();
const skuErrors = new Map<string, { code: string; message: string }>();
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i): PerSkuResult => {
    const e = skuErrors.get(i.externalSkuId);
    return e ? { externalSkuId: i.externalSkuId, ok: false, ...e } : { externalSkuId: i.externalSkuId, ok: true };
  }),
);
let getSkusCalls = 0;
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    uploadImage: async (_t, url) => url,
    async createProduct(_t, p) {
      return { externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}`, live: false };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      getSkusCalls++;
      return sellerSkus.flatMap((s) => {
        const r = remote.get(s);
        return r
          ? [
              {
                externalProductId: `item-${s}`,
                externalSkuId: `sku-${s}`,
                sellerSku: s,
                title: s,
                state: r.state,
                rejectReason: r.rejectReason ?? null,
                quantity: 0,
              },
            ]
          : [];
      });
    },
    updatePriceQuantity,
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
const sync = () => syncListings(port, company.companyId, shopId);
async function listing(variantId: string) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [
    shopId,
    variantId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({
    accessToken: `tok-${randomUUID().slice(0, 12)}`,
  });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  await auth(app().put(`/api/v1/channel/shops/${shopId}/category-maps/${categoryId}`)).send({
    externalCategoryId: '1',
    attributes: {},
    version: null,
  });
  const imageUrls = Object.fromEntries([a, b, c].map((v) => [v.productId, ['https://img.test/x.png']]));
  const pushed = await auth(app().post(`/api/v1/channel/shops/${shopId}/listings/push`)).send({
    variantIds: [a.id, b.id, c.id],
    imageUrls,
  });
  // Đẩy chạy nền (#219): chạy việc như worker để có listing `under_review`.
  for (const r of pushed.body.results as { listingId: string }[]) {
    await runListingPush(port, { companyId: company.companyId, shopId, listingId: r.listingId, imageUrls: ['https://img.test/x.png'] });
  }
  const { rows } = await testPool().query<{ status: string }>('select status from channel.listings where shop_id = $1', [shopId]);
  expect(rows.map((r) => r.status)).toEqual(['under_review', 'under_review', 'under_review']);
});

describe('đồng bộ trạng thái từ sàn', () => {
  it('sàn duyệt → live, từ chối → rejected kèm lý do, còn chờ thì giữ nguyên; lịch sử ghi nguồn sàn', async () => {
    remote.set('CMR-A', { state: 'live' });
    remote.set('CMR-B', { state: 'rejected', rejectReason: 'Wrong Image' });
    remote.set('CMR-C', { state: 'review' });
    const res = await sync();
    expect(res).toMatchObject({ checked: 3, changed: 2 });
    expect(await listing(a.id)).toMatchObject({ status: 'live' });
    expect(await listing(b.id)).toMatchObject({ status: 'rejected', reject_reason: 'Wrong Image' });
    expect(await listing(c.id)).toMatchObject({ status: 'under_review' });
    const { rows } = await testPool().query(
      `select action, actor_id from core.state_transitions where entity_type = 'listings' and entity_id = $1 order by id desc limit 1`,
      [(await listing(a.id)).id],
    );
    expect(rows[0]).toEqual({ action: 'approve', actor_id: null });
  });

  it('sàn khoá rồi gỡ khoá: live → platform_hold → live', async () => {
    remote.set('CMR-A', { state: 'hold' });
    await sync();
    expect(await listing(a.id)).toMatchObject({ status: 'platform_hold' });
    remote.set('CMR-A', { state: 'live' });
    await sync();
    expect(await listing(a.id)).toMatchObject({ status: 'live' });
  });

  it('kẹt pushing quá 30 phút (server chết giữa chừng) → push_failed', async () => {
    const stuck = await listing(c.id);
    await testPool().query(
      `update channel.listings set status = 'pushing', push_started_at = now() - interval '31 minutes' where id = $1`,
      [stuck.id],
    );
    await sync();
    expect(await listing(c.id)).toMatchObject({ status: 'push_failed' });
  });
});

describe('đồng bộ tồn và giá', () => {
  it('tồn đổi: listing chuyển stockSync pending; lần đồng bộ sau đẩy số khả dụng và đọc lại synced', async () => {
    available.set(a.id, 12);
    await withCompany(company.companyId, () => markStockPending([a.id]));
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'pending' });
    updatePriceQuantity.mockClear();
    const res = await sync();
    expect(res.pushed).toBe(1);
    // Giá đã synced, bằng giá chuẩn: chỉ gửi tồn (#223 review 3).
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-CMR-A', externalSkuId: 'sku-CMR-A', quantity: 12 },
    ]);
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', price_sync: 'synced', platform_stock: 12 });
  });

  it('lỗi riêng một SKU: ghi stockSyncError, priceSyncError của SKU đó, không đánh lỗi SKU khác', async () => {
    remote.set('CMR-B', { state: 'rejected', rejectReason: 'Wrong Image' });
    await withCompany(company.companyId, async () => {
      await markStockPending([a.id]);
      await markStockPending([b.id]);
    });
    // Cả hai chờ đẩy giá để lời gọi mang cả giá và tồn; sàn giả trả một kết quả chung cho SKU.
    await testPool().query(`update channel.listings set price_sync = 'pending' where shop_id = $1 and variant_id = any($2)`, [shopId, [a.id, b.id]]);
    skuErrors.set('sku-CMR-A', { code: 'E0501', message: 'Update product failed' });
    const res = await sync();
    expect(res).toMatchObject({ pushed: 2, errors: 1 });
    const rowA = await listing(a.id);
    // Đẩy lỗi giữ pending kèm lỗi (Documents/21 mục 18.6.6); `error` dành cho Lệch tồn.
    expect(rowA).toMatchObject({ stock_sync: 'pending', price_sync: 'error' });
    expect(rowA.stock_sync_error).toMatchObject({ code: 'E0501', message: 'Update product failed' });
    expect(await listing(b.id)).toMatchObject({ stock_sync: 'synced', stock_sync_error: null });
    skuErrors.clear();
  });

  it('lần sau đẩy lại SKU đang lỗi', async () => {
    await sync();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', stock_sync_error: null });
  });

  it('có giá nhưng không có số có thể bán: chỉ đẩy giá, giữ stock_sync pending kèm variant_missing', async () => {
    available.delete(b.id);
    await withCompany(company.companyId, () => markStockPending([b.id]));
    await testPool().query(`update channel.listings set price_sync = 'pending' where shop_id = $1 and variant_id = $2`, [shopId, b.id]);
    updatePriceQuantity.mockClear();
    const res = await sync();
    expect(res).toMatchObject({ pushed: 1, errors: 0 });
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-CMR-B', externalSkuId: 'sku-CMR-B', price: '99000' },
    ]);
    const row = await listing(b.id);
    expect(row).toMatchObject({ stock_sync: 'pending', price_sync: 'synced', platform_stock: 5 });
    expect(row.stock_sync_error).toMatchObject({ code: 'variant_missing' });
  });

  it('có giá nhưng không có số có thể bán, sàn trả lỗi: chỉ ghi lỗi giá, không đụng stock_sync', async () => {
    await testPool().query(`update channel.listings set price_sync = 'pending' where shop_id = $1 and variant_id = $2`, [shopId, b.id]);
    skuErrors.set('sku-CMR-B', { code: 'E0501', message: 'Update product failed' });
    await sync();
    const row = await listing(b.id);
    expect(row).toMatchObject({ stock_sync: 'pending', price_sync: 'error' });
    expect(row.stock_sync_error).toMatchObject({ code: 'variant_missing' });
    expect(row.price_sync_error).toMatchObject({ code: 'E0501' });
    skuErrors.clear();
    available.set(b.id, 5);
    await sync();
    expect(await listing(b.id)).toMatchObject({ stock_sync: 'synced', stock_sync_error: null, price_sync: 'synced' });
  });
});

describe('sàn xoá sản phẩm (#219, 25 §6.4)', () => {
  it('AC-15, AC-16: live, rejected, push_failed còn mã sàn mà sàn báo deleted → delisted do hệ thống; bỏ mã sàn, giữ SellerSku', async () => {
    await testPool().query(
      `update channel.listings set status = 'push_failed', push_error = $2 where shop_id = $1 and variant_id = $3`,
      [shopId, JSON.stringify({ code: 'marketplace_rejected', message: 'Sai', at: new Date().toISOString() }), c.id],
    );
    expect((await listing(b.id)).status).toBe('rejected');
    for (const s of ['CMR-A', 'CMR-B', 'CMR-C']) remote.set(s, { state: 'deleted' });
    const res = await sync();
    expect(res).toMatchObject({ checked: 3, changed: 3 });
    for (const v of [a, b, c]) {
      expect(await listing(v.id)).toMatchObject({
        status: 'delisted',
        seller_sku: v.sku,
        external_product_id: null,
        external_sku_id: null,
        external_image_urls: null,
      });
    }
    const { rows } = await testPool().query(
      `select action, actor_id, reason from core.state_transitions where entity_type = 'listings' and entity_id = $1 order by id desc limit 1`,
      [(await listing(b.id)).id],
    );
    expect(rows[0]).toEqual({ action: 'delist', actor_id: null, reason: 'Sàn báo đã xoá sản phẩm' });
  });

  it('listing đã gỡ không đọc lại trạng thái sàn', async () => {
    const res = await sync();
    expect(res).toMatchObject({ checked: 0, changed: 0 });
  });
});

describe('nút Đồng bộ chỉ xếp việc (POST /listings/sync, 202, #223)', () => {
  const jobs = async () =>
    (
      await testPool().query(
        "select count(*)::int as n from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1 and state = 'created'",
        [shopId],
      )
    ).rows[0].n;
  const press = () => auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));

  it('bấm hai lần: 202 cả hai, lần sau queued=false, chỉ một việc chờ; không gọi sàn trong request', async () => {
    await testPool().query("delete from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1", [shopId]);
    getSkusCalls = 0;
    updatePriceQuantity.mockClear();
    const first = await press();
    const second = await press();
    expect(first.status).toBe(202);
    expect(ListingSyncResult.parse(first.body)).toEqual({ queued: true });
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ queued: false });
    expect(await jobs()).toBe(1);
    expect(getSkusCalls).toBe(0);
    expect(updatePriceQuantity).not.toHaveBeenCalled();
  });

  it('gian hàng cần kết nối lại → 409 shop_not_connected, không xếp việc', async () => {
    await testPool().query("delete from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1", [shopId]);
    await testPool().query(`update channel.shops set status = 'needs_reauth', orders_pulled_ok_at = null where id = $1`, [shopId]);
    try {
      const res = await press();
      expect(res.status).toBe(409);
      expect(res.body.type).toContain('shop_not_connected');
      expect(await jobs()).toBe(0);
    } finally {
      await testPool().query(`update channel.shops set status = 'active' where id = $1`, [shopId]);
    }
  });

  it('gian hàng của công ty khác → 404', async () => {
    const res = await auth(app().post(`/api/v1/channel/shops/${randomUUID()}/listings/sync`));
    expect(res.status).toBe(404);
  });
});
