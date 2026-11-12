// Đẩy tồn theo `fulfillment.allocation_done` và đối chiếu tồn 15 phút (#223; 25 §6.5, E28, E32, E35; 21 §18.5, §18.6.6;
// US-GH-08 dòng 2–5). Sàn giả: adapter thay bằng `registerAdapter`, không gọi sàn thật.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import { runStockPush } from '#src/modules/channel/channel/service/background.ts';
import { onAvailableChanged } from '#src/modules/channel/channel/service/listing-sync.ts';
import { MarketplaceError, type PerSkuResult, type PriceQuantity, type RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { activateShop, fakeAdapter } from './helpers.ts';

const variant = (sku: string): ListingVariant => ({
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Cốc',
  sku,
  categoryId: randomUUID(),
  attributesLabel: '',
  archived: false,
  businessStatus: 'selling',
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
});
const a = variant('REC-A');
const b = variant('REC-B');
const available = new Map<string, number>();
const port = {
  variants: async (ids?: readonly string[]) => [a, b].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(99000)])),
  availableOf: async (ids: readonly string[]) =>
    new Map(ids.flatMap((id): [string, number][] => (available.has(id) ? [[id, available.get(id)!]] : []))),
};
setProductPort(port);

/** Sàn giả: tồn và khoá khuyến mãi theo SellerSku; ghi thứ tự gọi để kiểm "lấy đơn trước". */
const remote = new Map<string, Pick<RemoteSku, 'quantity' | 'stockLocked' | 'priceLocked'>>();
const calls: string[] = [];
let ordersFail: MarketplaceError | null = null;
/** Sàn không trả số bán được (như Lazada hiện nay): không đối chiếu. */
let noSellable = false;
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly PriceQuantity[]) => {
  calls.push('updatePriceQuantity');
  return items.map((i): PerSkuResult => ({ externalSkuId: i.externalSkuId, ok: true }));
});
registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop đối chiếu', region: 'VN' };
    },
    async listOrders() {
      calls.push('listOrders');
      if (ordersFail) throw ordersFail;
      return { orders: [], nextCursor: null, safeUntil: null };
    },
    getOrder: async () => {
      throw new Error('không có đơn');
    },
    async getSkus(_t, sellerSkus): Promise<RemoteSku[]> {
      calls.push('getSkus');
      return sellerSkus.flatMap((s) => {
        const r = remote.get(s);
        return r ? [{ externalProductId: `item-${s}`, externalSkuId: `sku-${s}`, sellerSku: s, title: s, state: 'live' as const, rejectReason: null, ...r, ...(!noSellable && { sellableQuantity: r.quantity }) }] : [];
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
let token: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const sync = () => auth(app().post(`/api/v1/channel/shops/${shopId}/listings/sync`));
const sentFor = (sku: string) => updatePriceQuantity.mock.calls.flatMap(([, items]) => items).find((i) => i.externalSkuId === `sku-${sku}`);
async function listing(variantId: string) {
  const { rows } = await testPool().query('select * from channel.listings where shop_id = $1 and variant_id = $2', [shopId, variantId]);
  return rows[0];
}
/** Listing `live` đã đồng bộ, sàn đang có `platformStock`. */
async function resetListing(v: ListingVariant, platformStock: number) {
  await testPool().query(
    `update channel.listings set stock_sync = 'synced', price_sync = 'synced', platform_stock = $3, listed_price = 99000,
       stock_sync_error = null, price_sync_error = null where shop_id = $1 and variant_id = $2`,
    [shopId, v.id, platformStock],
  );
}

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  token = `tok-${randomUUID().slice(0, 12)}`;
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token });
  shopId = res.body.shop.id;
  await activateShop(shopId);
  for (const v of [a, b]) {
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, external_product_id, external_sku_id, seller_sku, status)
       values ($1, $2, $3, $4, $5, $6, 'live')`,
      [company.companyId, shopId, v.id, `item-${v.sku}`, `sku-${v.sku}`, v.sku],
    );
  }
});

beforeEach(async () => {
  // Lượt lấy đơn gần nhất vừa xong trọn: số app tin được (#223).
  await testPool().query("update channel.shops set status = 'active', orders_pulled_ok_at = now() where id = $1", [shopId]);
  for (const v of [a, b]) {
    available.set(v.id, 5);
    remote.set(v.sku, { quantity: 5 });
    await resetListing(v, 5);
  }
  ordersFail = null;
  noSellable = false;
  calls.length = 0;
  updatePriceQuantity.mockClear();
});

describe('đối chiếu tồn 15 phút (25 §6.5)', () => {
  it('lấy đơn trước khi đọc tồn sàn; khớp thì không đẩy gì', async () => {
    const res = await sync();
    expect(res.status).toBe(200);
    expect(calls).toEqual(['listOrders', 'getSkus']);
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 5 });
  });

  it('US-GH-08 dòng 3: sàn cao hơn số có thể bán → đẩy giảm ngay trong lượt', async () => {
    remote.set(a.sku, { quantity: 9 });
    await sync();
    expect(sentFor(a.sku)).toEqual({ externalProductId: `item-${a.sku}`, externalSkuId: `sku-${a.sku}`, price: '99000', quantity: 5 });
    expect(sentFor(b.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 5 });
  });

  it('US-GH-08 dòng 4: sàn thấp hơn → lượt 1 chờ; lượt 2 vẫn lệch → đẩy tăng, Lệch tồn; lượt sau khớp → hết cờ', async () => {
    remote.set(a.sku, { quantity: 3 });
    await sync();
    expect(sentFor(a.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 3 });

    await sync();
    expect(sentFor(a.sku)).toMatchObject({ quantity: 5 });
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'error', platform_stock: 5, stock_sync_error: null });

    remote.set(a.sku, { quantity: 5 });
    updatePriceQuantity.mockClear();
    await sync();
    expect(sentFor(a.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 5 });
  });

  it('sàn thấp hơn rồi đơn về làm số có thể bán khớp sàn → không đẩy tăng (E35)', async () => {
    remote.set(a.sku, { quantity: 3 });
    await sync();
    available.set(a.id, 3);
    await sync();
    expect(sentFor(a.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 3 });
  });

  it('listing chỉ chờ đẩy giá mà sàn thấp hơn lần đầu → lượt này không gửi tồn (vẫn chờ một lượt)', async () => {
    remote.set(a.sku, { quantity: 3 });
    await testPool().query(`update channel.listings set price_sync = 'error' where shop_id = $1 and variant_id = $2`, [shopId, a.id]);
    await sync();
    expect(sentFor(a.sku)).toEqual({ externalProductId: `item-${a.sku}`, externalSkuId: `sku-${a.sku}`, price: '99000' });
    const row = await listing(a.id);
    expect(row).toMatchObject({ stock_sync: 'synced', platform_stock: 3, price_sync: 'synced', stock_sync_error: null });
  });

  it('listing đang Lệch tồn mà sàn lại thấp hơn → lượt đầu chờ, giữ cờ; lượt sau mới đẩy tăng', async () => {
    await testPool().query(`update channel.listings set stock_sync = 'error' where shop_id = $1 and variant_id = $2`, [shopId, a.id]);
    remote.set(a.sku, { quantity: 3 });
    await sync();
    expect(sentFor(a.sku)).not.toHaveProperty('quantity');
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'error', platform_stock: 3 });
    // Lượt 1 đã gửi giá (dòng `error` luôn nằm trong lượt đẩy); chỉ xét lời gọi của lượt 2.
    updatePriceQuantity.mockClear();
    await sync();
    expect(sentFor(a.sku)).toMatchObject({ quantity: 5 });
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'error', platform_stock: 5 });
  });

  it('sàn không trả số bán được (Lazada chưa bật) → không đối chiếu, không bật cờ', async () => {
    noSellable = true;
    remote.set(a.sku, { quantity: 3 });
    await sync();
    await sync();
    expect(sentFor(a.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 5 });
  });

  it('lấy đơn lỗi → không đối chiếu lượt này (không đẩy theo số sàn)', async () => {
    ordersFail = new MarketplaceError('unavailable', '901', 'Sàn bận');
    remote.set(a.sku, { quantity: 9 });
    const res = await sync();
    expect(res.status).toBe(200);
    expect(sentFor(a.sku)).toBeUndefined();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 5 });
  });

  it('bước 3: sàn khoá tồn do khuyến mãi → không ghi đè tồn, báo promotion_locked; giá vẫn đẩy', async () => {
    remote.set(a.sku, { quantity: 9, stockLocked: true });
    await testPool().query(`update channel.listings set stock_sync = 'pending', price_sync = 'pending' where shop_id = $1 and variant_id = $2`, [shopId, a.id]);
    await sync();
    expect(sentFor(a.sku)).toEqual({ externalProductId: `item-${a.sku}`, externalSkuId: `sku-${a.sku}`, price: '99000' });
    const row = await listing(a.id);
    expect(row).toMatchObject({ stock_sync: 'pending', platform_stock: 5, price_sync: 'synced' });
    expect(row.stock_sync_error).toMatchObject({ code: 'promotion_locked' });
  });

  it('bước 3: sàn khoá giá do khuyến mãi → không gửi giá, giữ giá cũ, báo priceSyncError', async () => {
    remote.set(a.sku, { quantity: 5, priceLocked: true });
    await testPool().query(`update channel.listings set price_sync = 'pending' where shop_id = $1 and variant_id = $2`, [shopId, a.id]);
    await sync();
    // Tồn đã đồng bộ, giá bị khoá: không gửi gì.
    expect(sentFor(a.sku)).toBeUndefined();
    const row = await listing(a.id);
    expect(row).toMatchObject({ price_sync: 'error', listed_price: '99000.00' });
    expect(row.price_sync_error).toMatchObject({ code: 'promotion_locked' });
  });
});

describe('đẩy tồn khi chia hàng xong (fulfillment.allocation_done)', () => {
  it('đánh dấu pending, xếp channel.stock_push; việc đẩy số mới nhất lúc chạy, không đọc sàn', async () => {
    await testPool().query("delete from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    available.set(a.id, 4);
    await withCompany(company.companyId, () => onAvailableChanged({ variantIds: [a.id] }));
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'pending' });
    expect(await listing(b.id)).toMatchObject({ stock_sync: 'synced' });
    const jobs = await testPool().query("select 1 from pgboss.job where name = 'channel.stock_push' and data->>'shopId' = $1", [shopId]);
    expect(jobs.rowCount).toBe(1);

    available.set(a.id, 2);
    await runStockPush(port, { companyId: company.companyId, shopId });
    expect(calls).toEqual(['updatePriceQuantity']);
    expect(sentFor(a.sku)).toEqual({ externalProductId: `item-${a.sku}`, externalSkuId: `sku-${a.sku}`, price: '99000', quantity: 2 });
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 2 });
  });

  it('listing đang Lệch tồn nhận số mới vẫn giữ cờ error', async () => {
    await testPool().query(`update channel.listings set stock_sync = 'error' where shop_id = $1 and variant_id = $2`, [shopId, a.id]);
    await withCompany(company.companyId, () => onAvailableChanged({ variantIds: [a.id] }));
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'error' });
    await runStockPush(port, { companyId: company.companyId, shopId });
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'error', platform_stock: 5 });
  });

  it('US-GH-08 dòng 5, E28: gian hàng cần kết nối lại → việc không đẩy, listing chờ; nối lại thì lấy đơn xong mới đẩy', async () => {
    await testPool().query(`update channel.shops set status = 'needs_reauth', orders_pulled_ok_at = null where id = $1`, [shopId]);
    available.set(a.id, 1);
    await withCompany(company.companyId, () => onAvailableChanged({ variantIds: [a.id] }));
    await runStockPush(port, { companyId: company.companyId, shopId });
    expect(updatePriceQuantity).not.toHaveBeenCalled();
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'pending' });

    await testPool().query("delete from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1", [shopId]);
    const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: token });
    expect(res.body.shop.status).toBe('active');
    const jobs = await testPool().query(
      "select 1 from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1 and state = 'created'",
      [shopId],
    );
    expect(jobs.rowCount).toBe(1);
    // Việc đẩy tồn chạy trước lượt lấy đơn (vd một `allocation_done` khác): chỉ đẩy giá, không gửi tồn (#223, E28).
    await runStockPush(port, { companyId: company.companyId, shopId });
    expect(sentFor(a.sku)).not.toHaveProperty('quantity');
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'pending' });
    updatePriceQuantity.mockClear();
    calls.length = 0;
    // Lượt đồng bộ mà việc đó chạy:
    await sync();
    expect(calls.indexOf('listOrders')).toBeLessThan(calls.indexOf('updatePriceQuantity'));
    expect(sentFor(a.sku)).toMatchObject({ quantity: 1 });
    expect(await listing(a.id)).toMatchObject({ stock_sync: 'synced', platform_stock: 1 });
  });
});
