import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShopDisconnectConflict } from '#src/modules/channel/channel/api/schemas.ts';
import type { RemoteOrder } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { fakeAdapter } from './helpers.ts';

// #207: ngắt gian hàng còn đơn chưa xong thì 409 `shop_has_open_orders` (Documents/21 §18.6.1), không đẩy tồn 0.

const cutoff = new Date('2026-10-20T00:00:00Z');
let remote: RemoteOrder | null = null;
/** Chạy trong lúc đẩy tồn 0: giả đơn về giữa lần kiểm trước khi đẩy và giao dịch ngắt. */
let duringPush: (() => Promise<unknown>) | null = null;
// SKU sàn `sku-loi` báo lỗi riêng SKU, các SKU khác nhận.
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) => {
  await duringPush?.();
  return items.map((i) =>
    i.externalSkuId === 'sku-loi'
      ? { externalSkuId: i.externalSkuId, ok: false as const, code: 'E', message: 'lỗi SKU' }
      : { externalSkuId: i.externalSkuId, ok: true as const },
  );
});

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    updatePriceQuantity,
    async listOrders() {
      return {
        orders: remote ? [{ externalOrderId: remote.externalOrderId, placedAt: remote.placedAt, updatedAt: remote.updatedAt }] : [],
        nextCursor: null,
        safeUntil: null,
      };
    },
    async getOrder() {
      return remote!;
    },
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);
const disconnect = (shopId: string, body: { version: number; zeroStock?: boolean }) =>
  auth(app().post(`/api/v1/channel/shops/${shopId}/disconnect`)).send(body);

/** Gian hàng `active` đã thiết lập, một listing `live` trên sàn đã đồng bộ tồn. */
async function activeShop(): Promise<{ id: string; version: number }> {
  company ??= await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const id = res.body.shop.id as string;
  const { rows } = await testPool().query<{ version: number }>(
    `update channel.shops set status = 'active', order_cutoff_at = $2, version = version + 1 where id = $1 returning version`,
    [id, cutoff],
  );
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, stock_sync, platform_stock)
     values ($1, $2, $3, $4, 'live', 'item-1', 'sku-1', 'synced', 7)`,
    [company.companyId, id, randomUUID(), `SKU-${randomUUID().slice(0, 8)}`],
  );
  return { id, version: rows[0]!.version };
}

const insertOrderSql = `insert into "order".orders (company_id, code, source, shop_id, external_order_id, status, outcome, subtotal, total)
  values ($1, $2, 'marketplace', $3, $4, $5, $6, 0, 0) returning id`;
const orderParams = (shopId: string, status: string) => [
  company.companyId,
  `DH-${randomUUID().slice(0, 8)}`,
  shopId,
  `SAN-${randomUUID().slice(0, 8)}`,
  status,
  status === 'completed' ? 'full' : null,
];
async function addOrder(shopId: string, status: 'unpaid' | 'processing' | 'completed' | 'cancelled'): Promise<string> {
  return (await testPool().query<{ id: string }>(insertOrderSql, orderParams(shopId, status))).rows[0]!.id;
}

const shopRow = async (id: string) =>
  (await testPool().query('select status, version, access_token_enc from channel.shops where id = $1', [id])).rows[0];

beforeEach(() => {
  updatePriceQuantity.mockClear();
  remote = null;
  duringPush = null;
});

describe('ngắt gian hàng còn đơn chưa xong (#207)', () => {
  it('còn đơn unpaid, processing: 409 kèm openOrders, không đẩy tồn 0, gian hàng giữ nguyên', async () => {
    const shop = await activeShop();
    await addOrder(shop.id, 'unpaid');
    await addOrder(shop.id, 'processing');
    await addOrder(shop.id, 'completed');
    await addOrder(shop.id, 'cancelled');

    const res = await disconnect(shop.id, { version: shop.version, zeroStock: true });
    expect(res.status).toBe(409);
    expect(ShopDisconnectConflict.parse(res.body)).toMatchObject({ code: 'shop_has_open_orders', openOrders: 2 });
    expect(updatePriceQuantity).not.toHaveBeenCalled();
    const row = await shopRow(shop.id);
    expect(row).toMatchObject({ status: 'active', version: shop.version });
    expect(row.access_token_enc).not.toBeNull();
  });

  it('thứ tự kiểm: version cũ báo version_conflict trước đơn mở; đã ngắt báo invalid_transition trước version', async () => {
    const shop = await activeShop();
    await addOrder(shop.id, 'processing');
    const stale = await disconnect(shop.id, { version: shop.version + 5 });
    expect(stale.status).toBe(409);
    expect(ShopDisconnectConflict.parse(stale.body)).toMatchObject({
      code: 'version_conflict',
      current: { id: shop.id, status: 'active', version: shop.version },
    });

    await testPool().query(`update "order".orders set status = 'cancelled' where shop_id = $1`, [shop.id]);
    const done = await disconnect(shop.id, { version: shop.version });
    expect(done.status).toBe(200);
    const twice = await disconnect(shop.id, { version: done.body.version + 5 });
    expect(twice.status).toBe(409);
    expect(ShopDisconnectConflict.parse(twice.body)).toMatchObject({ code: 'invalid_transition', current: 'disconnected' });
  });

  it('các đơn đã hoàn tất hoặc huỷ: ngắt được, đẩy tồn 0 trước', async () => {
    const shop = await activeShop();
    const orderId = await addOrder(shop.id, 'processing');
    expect((await disconnect(shop.id, { version: shop.version, zeroStock: true })).status).toBe(409);

    await testPool().query(`update "order".orders set status = 'completed', outcome = 'full' where id = $1`, [orderId]);
    const res = await disconnect(shop.id, { version: shop.version, zeroStock: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('disconnected');
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [{ externalProductId: 'item-1', externalSkuId: 'sku-1', quantity: 0 }]);
    expect((await shopRow(shop.id)).status).toBe('disconnected');
    // Ngắt thành công: listing gỡ, không bị đánh chờ đẩy lại tồn.
    const { rows } = await testPool().query('select status, stock_sync, platform_stock from channel.listings where shop_id = $1', [shop.id]);
    expect(rows).toEqual([{ status: 'delisted', stock_sync: 'synced', platform_stock: 7 }]);
  });

  it('đơn về sau khi đã đẩy tồn 0: ngắt 409, listing sàn nhận tồn 0 về chờ đẩy lại tồn thật', async () => {
    const shop = await activeShop();
    await testPool().query(
      `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_product_id, external_sku_id, stock_sync, platform_stock)
       values ($1, $2, $3, 'SKU-LOI', 'live', 'item-2', 'sku-loi', 'synced', 4)`,
      [company.companyId, shop.id, randomUUID()],
    );
    duringPush = () => addOrder(shop.id, 'processing');
    const res = await disconnect(shop.id, { version: shop.version, zeroStock: true });
    expect(res.status).toBe(409);
    expect(ShopDisconnectConflict.parse(res.body)).toMatchObject({ code: 'shop_has_open_orders', openOrders: 1 });
    expect(updatePriceQuantity).toHaveBeenCalledTimes(1);
    const { rows } = await testPool().query(
      'select external_sku_id, status, stock_sync, platform_stock from channel.listings where shop_id = $1 order by external_sku_id',
      [shop.id],
    );
    expect(rows).toEqual([
      { external_sku_id: 'sku-1', status: 'live', stock_sync: 'pending', platform_stock: 0 },
      { external_sku_id: 'sku-loi', status: 'live', stock_sync: 'synced', platform_stock: 4 },
    ]);
  });

  it('đơn đang về (giao dịch nhận đơn chưa commit) khi ngắt: ngắt chờ rồi 409 openOrders 1', async () => {
    const shop = await activeShop();
    const res = await raceBehindLock(
      async (holder) => {
        // Như giao dịch nhận đơn của `order-pull.ts`: khoá chia sẻ dòng gian hàng rồi chèn đơn.
        await holder.query('select 1 from channel.shops where id = $1 for share', [shop.id]);
        await holder.query(insertOrderSql, orderParams(shop.id, 'processing'));
      },
      1,
      () => disconnect(shop.id, { version: shop.version }),
    );
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_has_open_orders', openOrders: 1 });
    expect((await shopRow(shop.id)).status).toBe('active');
  });

  it('lượt kéo đơn gặp gian hàng đang ngắt: chờ khoá, thấy đã ngắt thì bỏ, không tạo đơn', async () => {
    const shop = await activeShop();
    const placed = new Date('2026-10-25T00:00:00Z');
    remote = {
      externalOrderId: `R-${randomUUID().slice(0, 8)}`,
      rawStatus: 'pending',
      paid: true,
      isCod: true,
      placedAt: placed,
      updatedAt: placed,
      shipBy: null,
      shippingAddress: null,
      shippingFee: '0',
      cancelRequested: false,
      lines: [
        {
          externalLineId: 'l-1',
          sellerSku: 'SKU-X',
          productName: 'Áo',
          unitPrice: '50000',
          sellerDiscount: '0',
          platformDiscount: '0',
          packageCode: `FP-${randomUUID().slice(0, 8)}`,
          trackingCode: null,
          rawStatus: 'pending',
          status: 'pending',
        },
      ],
    };
    const res = await raceBehindLock(
      async (holder) => {
        // Như giao dịch ngắt: khoá dòng gian hàng rồi chuyển `disconnected`.
        await holder.query('select 1 from channel.shops where id = $1 for update', [shop.id]);
        await holder.query(`update channel.shops set status = 'disconnected', disconnected_at = now() where id = $1`, [shop.id]);
      },
      1,
      () => auth(app().post(`/api/v1/channel/shops/${shop.id}/orders/pull`)),
    );
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_connected');
    const { rows } = await testPool().query('select id from "order".orders where shop_id = $1', [shop.id]);
    expect(rows).toEqual([]);
  });
});
