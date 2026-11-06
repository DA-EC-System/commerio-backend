// Lượt kéo đơn còn mở một lần sau thiết lập (#198; Documents/21 §18.2, §18.6.2): đơn đặt trước mốc vẫn về, kiện chưa rời
// kho giữ hàng, kiện đã rời kho chỉ lưu; xong thì mới đẩy tồn (A10). Mỗi ca một công ty riêng.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { runOpenOrderPull } from '#src/modules/channel/channel/service/background.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import type { RemoteOrder, RemoteOrderRef, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ProductPort, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { listingSyncQueue, openOrderPullQueue, reconcileShopJobs } from '#src/modules/channel/channel/service/shop-jobs.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { jobBoss } from '#src/modules/core/platform/service/jobs/boss.ts';
import { env } from '#src/shared/config/env.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { noLineInfo, noOrderInfo, noShipping } from '../../order/sales/helpers.ts';
import { fakeAdapter } from './helpers.ts';
import { setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import { AppError } from '#src/shared/errors/app-error.ts';

const at = (iso: string) => new Date(iso);
function remoteOrder(id: string, sku: string, status: RemoteOrder['lines'][number]['status'], placedAt: Date): RemoteOrder {
  return {
    externalOrderId: id,
    rawStatus: status ?? 'x',
    paid: true,
    isCod: false,
    placedAt,
    updatedAt: at('2026-11-05T00:00:00Z'),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [
      {
        externalLineId: `${id}-1`,
        sellerSku: sku,
        productName: 'Áo',
        unitPrice: '50000',
        sellerDiscount: '0',
        platformDiscount: '0',
        packageCode: `FP-${id}`,
        trackingCode: null,
        rawStatus: status ?? 'x',
        status,
        info: noLineInfo,
        shipping: noShipping,
      },
    ],
  };
}

let open: RemoteOrder[] = [];
let safeUntil: Date | null = null;
let pageSize = 1;
const listOpenOrders = vi.fn(async (_t: string, cursor: string | null) => {
  // Mặc định mỗi trang một đơn để thấy lật trang; `safeUntil` báo ở trang cuối.
  const i = Number(cursor ?? 0);
  const refs: RemoteOrderRef[] = open.map((o) => ({ externalOrderId: o.externalOrderId, placedAt: o.placedAt, updatedAt: o.updatedAt }));
  const page = refs.slice(i, i + pageSize);
  const next = i + pageSize < refs.length ? String(i + pageSize) : null;
  return { orders: page, nextCursor: next, safeUntil: next ? null : safeUntil };
});
const getOrder = vi.fn(async (_t: string, id: string) => open.find((o) => o.externalOrderId === id)!);
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
);
const base = {
  async getSeller(accessToken: string) {
    return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
  },
  getOrder,
  getSkus: async (): Promise<RemoteSku[]> => [],
  updatePriceQuantity,
};
// Lazada có cả lấy đơn theo lô (#267); bản giả gọi lại `getOrder` từng đơn để các ca cũ vẫn đếm được.
const getOrders = vi.fn(async (t: string, batch: readonly RemoteOrderRef[]) => Promise.all(batch.map((r) => getOrder(t, r.externalOrderId))));
registerAdapter('lazada', fakeAdapter({ ...base, listOpenOrders, getOrders }));
// Sàn chưa có `listOpenOrders` (TikTok tới #221).
registerAdapter('tiktok', fakeAdapter(base));

const available = vi.fn(async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])));
const port: ProductPort = {
  variants: async () => [],
  standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  availableOf: available,
};
setProductPort(port);
afterAll(() => {
  resetAdapters();
  setProductPort(null);
});
afterEach(() => {
  setStockPort();
  open = [];
  safeUntil = null;
  pageSize = 1;
  env.OPEN_ORDER_PULL_MAX = undefined;
  vi.clearAllMocks();
});

const cutoff = at('2026-11-04T00:00:00Z');
type Company = Awaited<ReturnType<typeof createCompany>>;

/** Gian hàng `active` vừa thiết lập (mốc đặt, chưa kéo đơn mở), một listing đã ghép. */
async function setUpShop(platform = 'lazada'): Promise<{ c: Company; shopId: string; sku: string; variantId: string }> {
  const c = await createCompany({ optionalModules: ['channel'] });
  const res = await request(testApp())
    .post(`/api/v1/channel/shops/${platform}/token`)
    .set('Authorization', `Bearer ${c.ceo.token}`)
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  const shopId = res.body.shop.id as string;
  await testPool().query(
    `update channel.shops set status = 'active', order_cutoff_at = $2, opening_stock_mode = 'push', unmatched_sku_count = 0 where id = $1`,
    [shopId, cutoff],
  );
  const { sku, variantId } = await createVariant(c.companyId);
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id, external_product_id)
     values ($1, $2, $3, $4, 'live', $5, 'item-1')`,
    [c.companyId, shopId, variantId, sku, `sku-${sku}`],
  );
  return { c, shopId, sku, variantId };
}

const shopCols = async (id: string) =>
  (await testPool().query('select open_orders_pulled_at, last_order_sync_at, last_error from channel.shops where id = $1', [id])).rows[0];
const packagesOf = async (shopId: string) =>
  (
    await testPool().query(
      `select o.external_order_id, p.status, l.stock_deducted, l.unit_cost from "order".packages p
         join "order".orders o on o.id = p.order_id join "order".package_lines l on l.package_id = p.id
        where o.shop_id = $1 order by o.external_order_id`,
      [shopId],
    )
  ).rows;

describe('lượt kéo đơn còn mở (AC-12, AC-13, AC-16, AC-17, AC-19)', () => {
  it('AC-12: thiết lập xếp đúng một việc kéo đơn còn mở cho gian hàng; thiết lập lỗi thì không có việc', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const shop = async () =>
      (
        await request(testApp())
          .post('/api/v1/channel/shops/lazada/token')
          .set('Authorization', `Bearer ${c.ceo.token}`)
          .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` })
      ).body.shop.id as string;
    const [ok, failed] = [await shop(), await shop()];
    await testPool().query(
      "insert into channel.shops (company_id, platform, external_shop_id, shop_name, status, order_cutoff_at) values ($1, 'lazada', $2, 'Cũ', 'active', now())",
      [c.companyId, randomUUID()],
    );
    const setup = (id: string, body: object) =>
      request(testApp()).post(`/api/v1/channel/shops/${id}/setup`).set('Authorization', `Bearer ${c.ceo.token}`).send(body);
    expect((await setup(ok, { openingStock: 'push' })).status).toBe(200);
    // Thiết lập lỗi: cổng kiểm kê ném lỗi thì rollback, không xếp việc
    setStocktakePort({
      createOpeningStocktake: () => Promise.reject(new AppError(503, 'service_unavailable', 'Kho đang bận')),
      openingStocktakeStatusOf: async () => new Map(),
    });
    try {
      expect((await setup(failed, { openingStock: 'stocktake' })).status).toBe(503);
    } finally {
      setStocktakePort();
    }
    const boss = await jobBoss();
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId: ok } })).toHaveLength(1);
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId: failed } })).toHaveLength(0);
  });

  it('AC-13, AC-16: đơn mở đặt trước mốc về app; kiện chưa rời kho giữ hàng, kiện đã rời kho chỉ lưu; mốc 5 phút không tiến; xong thì đẩy tồn', async () => {
    const { shopId, sku, c } = await setUpShop();
    const reserve = vi.fn(async () => ({ reserved: true }));
    setStockPort({ reserve, release: async () => {} });
    open = [remoteOrder('M1', sku, 'pending', at('2026-10-01T00:00:00Z')), remoteOrder('M2', sku, 'in_transit', at('2026-10-02T00:00:00Z'))];
    await runOpenOrderPull({ companyId: c.companyId, shopId });

    expect(await packagesOf(shopId)).toEqual([
      { external_order_id: 'M1', status: 'reserved', stock_deducted: false, unit_cost: null },
      { external_order_id: 'M2', status: 'in_transit', stock_deducted: false, unit_cost: null },
    ]);
    expect(reserve).toHaveBeenCalledTimes(1);
    const cols = await shopCols(shopId);
    expect(cols.open_orders_pulled_at).not.toBeNull();
    expect(cols.last_order_sync_at).toBeNull();
    const boss = await jobBoss();
    expect(await boss.findJobs(listingSyncQueue.name, { data: { shopId } })).not.toHaveLength(0);

    // Lượt đồng bộ sau lượt đơn mở mới gửi tồn, số đọc sau khi giữ hàng.
    await syncListings(port, c.companyId, shopId);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ externalSkuId: `sku-${sku}`, quantity: 7 }),
    ]);
    expect(reserve.mock.invocationCallOrder[0]!).toBeLessThan(available.mock.invocationCallOrder.at(-1)!);
    // Chạy lại việc (pg-boss giao hai lần) thì không gọi sàn nữa.
    listOpenOrders.mockClear();
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect(listOpenOrders).not.toHaveBeenCalled();
  });

  it('AC-19: adapter báo safeUntil thì lượt ném để chạy lại, chưa đặt cột, ghi last_error; lần sau không báo thì đặt', async () => {
    const { shopId, sku, c } = await setUpShop();
    open = [remoteOrder('S1', sku, 'pending', at('2026-10-01T00:00:00Z')), remoteOrder('S2', sku, 'pending', at('2026-10-02T00:00:00Z'))];
    safeUntil = at('2026-11-05T00:00:00Z');
    await expect(runOpenOrderPull({ companyId: c.companyId, shopId })).rejects.toThrow();
    // Không đặt trần thì nhận theo từng trang: trang trước trang lỗi đã lưu (review việc 1).
    expect((await packagesOf(shopId)).map((p) => p.external_order_id)).toEqual(['S1']);
    expect(await shopCols(shopId)).toMatchObject({ open_orders_pulled_at: null, last_error: expect.stringContaining('đơn còn mở') });
    safeUntil = null;
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect((await shopCols(shopId)).open_orders_pulled_at).not.toBeNull();
    expect((await packagesOf(shopId)).map((p) => p.external_order_id)).toEqual(['S1', 'S2']);
  });

  it('AC-17: sàn chưa có listOpenOrders thì việc đặt cột ngay, không lỗi', async () => {
    const { shopId, c } = await setUpShop('tiktok');
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect((await shopCols(shopId)).open_orders_pulled_at).not.toBeNull();
  });

  it('AC-17: nối lại gian hàng mất token khi lượt đơn mở chưa xong thì xếp lại đúng một việc', async () => {
    const { c, shopId } = await setUpShop();
    const { rows } = await testPool().query<{ external_shop_id: string }>(
      `update channel.shops set status = 'needs_reauth' where id = $1 returning external_shop_id`,
      [shopId],
    );
    const res = await request(testApp())
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${c.ceo.token}`)
      .send({ accessToken: `tok-${rows[0]!.external_shop_id}` });
    expect(res.body).toMatchObject({ shop: { id: shopId, status: 'active' } });
    const boss = await jobBoss();
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId } })).toHaveLength(1);
  });

  it('AC-24: `Shop.setup` qua API đi theo tiến độ: chưa thiết lập → ghép; đơn mở chạy → đẩy tồn chờ; xong lượt → đẩy; đẩy xong', async () => {
    const { c, shopId } = await setUpShop();
    const steps = async () => {
      const res = await request(testApp()).get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${c.ceo.token}`);
      return res.body.setup as { steps: { key: string; status: string; blockedBy: string | null }[]; unmatchedCount: number };
    };
    expect(await steps()).toEqual({
      steps: [
        { key: 'match', status: 'done', blockedBy: null },
        { key: 'open_orders', status: 'running', blockedBy: null },
        { key: 'push_stock', status: 'blocked', blockedBy: 'open_orders' },
      ],
      unmatchedCount: 0,
      openOrdersSkipped: 0,
    });
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect((await steps()).steps.slice(1).map((s) => s.status)).toEqual(['done', 'running']);
    await syncListings(port, c.companyId, shopId);
    expect((await steps()).steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);

    const fresh = await request(testApp())
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${c.ceo.token}`)
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    expect(fresh.body.shop.setup).toEqual({
      steps: [{ key: 'match', status: 'pending', blockedBy: null }],
      unmatchedCount: 0,
      openOrdersSkipped: 0,
    });
  });

  it('nối lại khi lượt đơn mở đang nằm ở hàng giữ: vẫn chỉ một việc (#198 diff-review N3)', async () => {
    const { c, shopId } = await setUpShop();
    const boss = await jobBoss();
    await boss.createQueue('platform.held');
    await boss.send('platform.held', { companyId: c.companyId, shopId, queue: openOrderPullQueue.name });
    const { rows } = await testPool().query<{ external_shop_id: string }>(
      `update channel.shops set status = 'needs_reauth' where id = $1 returning external_shop_id`,
      [shopId],
    );
    const res = await request(testApp())
      .post('/api/v1/channel/shops/lazada/token')
      .set('Authorization', `Bearer ${c.ceo.token}`)
      .send({ accessToken: `tok-${rows[0]!.external_shop_id}` });
    expect(res.body).toMatchObject({ reconnect: { jobsRun: 1 } });
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId } })).toHaveLength(1);
  });

  it('lỗi hệ thống trong lượt đơn mở không lộ ra `last_error`, chỉ câu chung (#198 diff-review N6)', async () => {
    const { shopId, sku, c } = await setUpShop();
    open = [remoteOrder('X1', sku, 'pending', at('2026-10-01T00:00:00Z'))];
    getOrder.mockRejectedValueOnce(new Error('chi tiết nội bộ: password=abc'));
    await expect(runOpenOrderPull({ companyId: c.companyId, shopId })).rejects.toThrow();
    const { last_error } = await shopCols(shopId);
    expect(last_error).toContain('đơn còn mở');
    expect(last_error).not.toContain('password');
  });

  it('AC-17: worker khởi động xếp lại việc cho gian hàng active chưa kéo đơn mở, không xếp cho gian hàng đã kéo', async () => {
    const pending = await setUpShop();
    const done = await setUpShop();
    await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [done.shopId]);
    await reconcileShopJobs();
    const boss = await jobBoss();
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId: pending.shopId } })).toHaveLength(1);
    expect(await boss.findJobs(openOrderPullQueue.name, { data: { shopId: done.shopId } })).toHaveLength(0);
  });

  // 250 đơn mở, ngày đặt khác nhau, sàn trả lẫn thứ tự (theo trạng thái rồi `updated_at`, không theo ngày đặt).
  const manyOpen = (sku: string) =>
    Array.from({ length: 250 }, (_, i) => {
      const k = (i * 97) % 250;
      return remoteOrder(`N${String(k).padStart(3, '0')}`, sku, 'pending', new Date(Date.UTC(2026, 6, 1) + k * 3600_000));
    });
  const pulledIds = async (shopId: string) => (await packagesOf(shopId)).map((p) => p.external_order_id as string).sort();
  const setupOfShop = async (c: Company, shopId: string) =>
    (await request(testApp()).get(`/api/v1/channel/shops/${shopId}`).set('Authorization', `Bearer ${c.ceo.token}`)).body.setup;

  it('OPEN_ORDER_PULL_MAX=200 với 250 đơn mở: kéo đúng 200 đơn đặt mới nhất, `setup.openOrdersSkipped` = 50', async () => {
    const { shopId, sku, c } = await setUpShop();
    open = [...manyOpen(sku), remoteOrder('SAU-MOC', sku, 'pending', at('2026-11-04T05:00:00Z'))];
    pageSize = 50;
    env.OPEN_ORDER_PULL_MAX = 200;
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    const newest = Array.from({ length: 200 }, (_, j) => `N${String(249 - j).padStart(3, '0')}`).sort();
    // Đơn đặt sau mốc vẫn về, không tính vào trần (review việc 1).
    expect(await pulledIds(shopId)).toEqual([...newest, 'SAU-MOC']);
    expect(getOrder).toHaveBeenCalledTimes(201);
    // Lấy chi tiết theo lô 100 đơn (#267): một lô đơn sau mốc ở trang của nó, rồi hai lô cho 200 đơn trước mốc.
    expect(getOrders.mock.calls.map((c) => c[1].length)).toEqual([1, 100, 100]);
    expect((await shopCols(shopId)).open_orders_pulled_at).not.toBeNull();
    expect(await setupOfShop(c, shopId)).toMatchObject({ openOrdersSkipped: 50 });
  });

  it('không đặt OPEN_ORDER_PULL_MAX: kéo đủ 250 đơn mở, không bỏ đơn nào', async () => {
    const { shopId, sku, c } = await setUpShop();
    open = manyOpen(sku);
    pageSize = 50;
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect(await pulledIds(shopId)).toHaveLength(250);
    expect(await setupOfShop(c, shopId)).toMatchObject({ openOrdersSkipped: 0 });
  });
});
