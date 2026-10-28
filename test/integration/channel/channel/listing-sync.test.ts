import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ListingSyncResult } from '#src/modules/channel/channel/api/schemas.ts';
import { markStockPending } from '#src/modules/channel/channel/service/listing-sync.ts';
import type { PerSkuResult, RemoteSku, RemoteState } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { fakeAdapter } from './helpers.ts';

const categoryId = randomUUID();
const variant = (sku: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Áo',
  sku,
  categoryId,
  attributesLabel: '',
  archived: false,
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

setProductPort({
  variants: async (ids) => [a, b, c].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(99000)])),
  availableOf: async (ids) => new Map(ids.map((id) => [id, available.get(id) ?? 0])),
});

/** Trạng thái trên sàn theo SellerSku; test đổi giữa các lần đồng bộ. */
const remote = new Map<string, { state: RemoteState; rejectReason?: string }>();
const skuErrors = new Map<string, { code: string; message: string }>();
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i): PerSkuResult => {
    const e = skuErrors.get(i.externalSkuId);
    return e ? { externalSkuId: i.externalSkuId, ok: false, ...e } : { externalSkuId: i.externalSkuId, ok: true };
  }),
);
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    categoryAttributes: async () => [],
    uploadImage: async (_t, url) => url,
    async createProduct(_t, p) {
      return { externalProductId: `item-${p.sellerSku}`, externalSkuId: `sku-${p.sellerSku}` };
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
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
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const sync = () => auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
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
  expect(pushed.body.results.map((r: { status: string }) => r.status)).toEqual(['under_review', 'under_review', 'under_review']);
});

describe('đồng bộ trạng thái từ sàn', () => {
  it('sàn duyệt → live, từ chối → rejected kèm lý do, còn chờ thì giữ nguyên; lịch sử ghi nguồn sàn', async () => {
    remote.set('CMR-A', { state: 'live' });
    remote.set('CMR-B', { state: 'rejected', rejectReason: 'Wrong Image' });
    remote.set('CMR-C', { state: 'review' });
    const res = await sync();
    expect(res.status).toBe(200);
    expect(ListingSyncResult.parse(res.body)).toMatchObject({ checked: 3, changed: 2 });
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
    await withCompany(company.companyId, () => markStockPending(a.id));
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'pending' });
    updatePriceQuantity.mockClear();
    const res = await sync();
    expect(res.body.pushed).toBe(1);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      { externalProductId: 'item-CMR-A', externalSkuId: 'sku-CMR-A', price: '99000', quantity: 12 },
    ]);
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', price_sync: 'synced', platform_stock: 12 });
  });

  it('lỗi riêng một SKU: ghi stockSyncError, priceSyncError của SKU đó, không đánh lỗi SKU khác', async () => {
    remote.set('CMR-B', { state: 'rejected', rejectReason: 'Wrong Image' });
    await withCompany(company.companyId, async () => {
      await markStockPending(a.id);
      await markStockPending(b.id);
    });
    skuErrors.set('sku-CMR-A', { code: 'E0501', message: 'Update product failed' });
    const res = await sync();
    expect(res.body).toMatchObject({ pushed: 2, errors: 1 });
    const rowA = await listing(a.id);
    expect(rowA).toMatchObject({ stock_sync: 'error', price_sync: 'error' });
    expect(rowA.stock_sync_error).toMatchObject({ code: 'E0501', message: 'Update product failed' });
    expect(await listing(b.id)).toMatchObject({ stock_sync: 'synced', stock_sync_error: null });
    skuErrors.clear();
  });

  it('lần sau đẩy lại SKU đang lỗi', async () => {
    await sync();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', stock_sync_error: null });
  });
});
