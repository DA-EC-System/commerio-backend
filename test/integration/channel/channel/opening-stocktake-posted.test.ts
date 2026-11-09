// #198 phần 2: phiếu kiểm kê đầu kỳ ghi sổ (`inventory.stocktake_posted`, Documents/21 §11.2) thì gian hàng thoát chế độ
// chờ kiểm kê, mốc kéo đơn = thời điểm đếm, lượt kéo đơn còn mở chạy lại rồi mới đẩy tồn (§18.6.2, 25 §6.1 bước 3–4).
// Sự kiện tự phát theo payload của Documents, chưa cần #245.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventPayload } from '#src/modules/core/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { runOpenOrderPull } from '#src/modules/channel/channel/service/background.ts';
import {
  handleAllocationDone,
  handleStocktakePosted,
  onAllocationDone,
  onOpeningStocktakePosted,
} from '#src/modules/channel/channel/service/opening-stocktake.ts';
import { HandlerFailure, type IncomingMessage, processMessage, type ProcessDeps } from '#src/modules/core/platform/service/outbox/consumer.ts';
import type { NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import type { RemoteOrder, RemoteOrderRef, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { noLineInfo, noOrderInfo, noShipping } from '../../order/sales/helpers.ts';
import { fakeAdapter } from './helpers.ts';
import type * as ShopJobs from '#src/modules/channel/channel/service/shop-jobs.ts';

// Ca rollback: cho `sendOpenOrderPull` ném một lần, các ca khác chạy bản thật.
const jobs = vi.hoisted(() => ({ failNext: false }));
vi.mock('#src/modules/channel/channel/service/shop-jobs.ts', async (importOriginal) => {
  const real = await importOriginal<typeof ShopJobs>();
  return {
    ...real,
    sendOpenOrderPull: async (companyId: string, shopId: string) => {
      if (jobs.failNext) {
        jobs.failNext = false;
        throw new Error('pg-boss lỗi giả');
      }
      return real.sendOpenOrderPull(companyId, shopId);
    },
  };
});

const variant: ListingVariant = {
  id: randomUUID(),
  productId: randomUUID(),
  productName: 'Áo thun',
  sku: 'CMR-OS-1',
  categoryId: randomUUID(),
  attributesLabel: 'Trắng',
  archived: false,
  description: null,
  weightG: 200,
  lengthMm: 100,
  widthMm: 100,
  heightMm: 10,
};
/** Biến thể thứ hai trên sàn (ca độ phủ một phần) và biến thể chưa có trên sàn (ca đẩy listing mới). */
const variant2: ListingVariant = { ...variant, id: randomUUID(), sku: 'CMR-OS-2', attributesLabel: 'Đen' };
const fresh: ListingVariant = { ...variant, id: randomUUID(), sku: 'CMR-OS-MOI', attributesLabel: 'Xanh' };
const remote: RemoteSku[] = [
  { externalProductId: 'item-os', externalSkuId: 'sku-os', sellerSku: 'CMR-OS-1', title: 'Áo thun trắng', state: 'live', rejectReason: null, quantity: 4 },
  { externalProductId: 'item-os2', externalSkuId: 'sku-os2', sellerSku: 'CMR-OS-2', title: 'Áo thun đen', state: 'live', rejectReason: null, quantity: 4 },
];
const created: NewProduct[] = [];
const updatePriceQuantity = vi.fn(async (_t: string, items: readonly { externalSkuId: string }[]) =>
  items.map((i) => ({ externalSkuId: i.externalSkuId, ok: true as const })),
);

/** Đơn còn mở trên sàn; SKU không ghép để không đụng tồn (chỉ cần thấy đơn về). */
let open: RemoteOrder[] = [];
function remoteOrder(id: string, placedAt: Date): RemoteOrder {
  return {
    externalOrderId: id,
    rawStatus: 'pending',
    paid: true,
    isCod: false,
    placedAt,
    updatedAt: placedAt,
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: [
      {
        externalLineId: `${id}-1`,
        sellerSku: 'KHONG-GHEP',
        productName: 'Áo',
        unitPrice: '50000',
        sellerDiscount: '0',
        platformDiscount: '0',
        packageCode: `FP-${id}`,
        trackingCode: null,
        rawStatus: 'pending',
        status: 'pending',
        info: noLineInfo,
        shipping: noShipping,
      },
    ],
  };
}

beforeAll(() => {
  setProductPort({
    variants: async (ids) => [variant, variant2, fresh].filter((v) => !ids || ids.includes(v.id)),
    standardPrices: async (ids) => new Map(ids.map((id) => [id, new Decimal(50000)])),
    availableOf: async (ids) => new Map(ids.map((id) => [id, 7])),
  });
  const getOrder = async (_t: string, id: string) => open.find((o) => o.externalOrderId === id)!;
  registerAdapter(
    'lazada',
    fakeAdapter({
      async getSeller(accessToken) {
        return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
      },
      getSkus: async (_t, sellerSkus) => remote.filter((r) => sellerSkus.includes(r.sellerSku)),
      updatePriceQuantity,
      listOpenOrders: async () => ({
        orders: open.map((o): RemoteOrderRef => ({ externalOrderId: o.externalOrderId, placedAt: o.placedAt, updatedAt: o.updatedAt })),
        nextCursor: null,
        safeUntil: null,
      }),
      getOrder,
      categoryAttributes: async () => [],
      uploadImage: async (_t, url) => `https://slatic.test/${encodeURIComponent(url)}`,
      async createProduct(_t, product) {
        created.push(product);
        return { externalProductId: `item-${product.sellerSku}`, externalSkuId: `sku-${product.sellerSku}`, live: false };
      },
    }),
  );
  setStocktakePort({
    createOpeningStocktake: async () => ({ documentId: randomUUID(), number: `KK-${randomUUID().slice(0, 6)}`, created: true }),
    openingStocktakeStatusOf: async (ids) => new Map(ids.map((id) => [id, 'pending'])),
  });
});
afterAll(() => {
  resetAdapters();
  setProductPort(null);
  setStocktakePort();
});
afterEach(() => {
  updatePriceQuantity.mockClear();
  created.length = 0;
  open = [];
  jobs.failNext = false;
});

const app = () => request(testApp());
type Company = Awaited<ReturnType<typeof createCompany>>;
const auth = (c: Company) => ({ Authorization: `Bearer ${c.ceo.token}` });

/**
 * Gian hàng đầu tiên của công ty thiết lập `stocktake`: active, chờ phiếu đầu kỳ. Lượt kéo đơn còn mở lúc thiết lập coi
 * như đã xong và việc của nó đã chạy (xoá khỏi hàng), để ca sau đếm đúng việc do handler xếp.
 */
async function waitingShop(c: Company, externalSkuIds = ['sku-os']): Promise<{ shopId: string; documentId: string; number: string }> {
  const token = await app()
    .post('/api/v1/channel/shops/lazada/token')
    .set(auth(c))
    .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  expect(token.status).toBe(201);
  const shopId = token.body.shop.id as string;
  const res = await app().post(`/api/v1/channel/shops/${shopId}/setup`).set(auth(c)).send({ externalSkuIds, openingStock: 'stocktake' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [shopId]);
  await testPool().query("delete from pgboss.job where name = 'channel.open_order_pull' and data->>'shopId' = $1", [shopId]);
  const { documentId, number } = res.body.shop.openingStocktake;
  return { shopId, documentId, number };
}

/** Payload theo Documents/21 §11.2; mặc định đếm và ghi sổ ngay lúc gọi (sau lúc thiết lập). */
function posted(shopId: string, documentId: string, over: Partial<EventPayload<'inventory.stocktake_posted'>> = {}) {
  const now = new Date().toISOString();
  return {
    documentId,
    number: 'KK-000001',
    source: { type: 'shop_setup' as const, shopId },
    postedAt: now,
    countedAt: now,
    lines: [{ variantId: variant.id, countedQty: 5, delta: 1 }],
    ...over,
  };
}

/** Phát `stocktake_posted` như consumer: `occurredAt` của vỏ sự kiện mặc định là lúc gọi. */
const stocktakePosted = (c: Company, event: EventPayload<'inventory.stocktake_posted'>, occurredAt = new Date()) =>
  withCompany(c.companyId, () => onOpeningStocktakePosted(event, occurredAt));

/** Chạy một sự kiện qua `processMessage` thật, handler đăng ký như `channel/index.ts`, trong `withCompany` như `runShared`. */
async function viaConsumer(c: Company, type: 'inventory.stocktake_posted' | 'fulfillment.allocation_done', payload: unknown, occurredAt: Date) {
  const envelope = { eventId: randomUUID(), type, companyId: c.companyId, aggregateId: randomUUID(), occurredAt: occurredAt.toISOString(), payload };
  const message: IncomingMessage = {
    topic: `commerio.${type.split('.')[0]}`,
    partition: 0,
    offset: '1',
    key: null,
    headers: { type },
    value: Buffer.from(JSON.stringify(envelope)),
  };
  const handler = type === 'inventory.stocktake_posted' ? handleStocktakePosted : handleAllocationDone;
  const deps: ProcessDeps = {
    spec: { consumer: 'test', scope: 'shared', handlers: new Map([[type, handler as never]]) },
    retryDelaysMs: [],
    runHandler: async (e, h) => {
      try {
        await withCompany(c.companyId, () => h(e));
      } catch (err) {
        throw new HandlerFailure(err);
      }
    },
    sendToDlq: async (_m, reason) => {
      throw new Error(`DLQ: ${reason}`);
    },
  };
  expect(await processMessage(message, 0, deps)).toEqual({ kind: 'done' });
}

async function shopRow(id: string) {
  const { rows } = await testPool().query(
    'select status, order_cutoff_at, opening_stocktake_id, opening_stocktake_number, open_orders_pulled_at, allocation_pending_since, version from channel.shops where id = $1',
    [id],
  );
  return rows[0];
}
async function openPullJobs(shopId: string): Promise<number> {
  const { rows } = await testPool().query(
    "select count(*)::int as n from pgboss.job where name = 'channel.open_order_pull' and data->>'shopId' = $1 and state = 'created'",
    [shopId],
  );
  return rows[0].n;
}
async function listingSyncJobs(shopId: string): Promise<number> {
  const { rows } = await testPool().query(
    "select count(*)::int as n from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1 and state = 'created'",
    [shopId],
  );
  return rows[0].n;
}
const clearListingSyncJobs = (shopId: string) =>
  testPool().query("delete from pgboss.job where name = 'channel.listing_sync' and data->>'shopId' = $1", [shopId]);
const quantityPushes = () => updatePriceQuantity.mock.calls.flatMap((call) => call[1]).filter((i) => 'quantity' in i).length;
const allocated = (c: Company, variantIds: readonly string[], at: Date) => withCompany(c.companyId, () => onAllocationDone(variantIds, at));

async function auditCount(shopId: string): Promise<number> {
  const { rows } = await testPool().query("select count(*)::int as n from core.audit_logs where entity_type = 'channel.shops' and entity_id = $1", [shopId]);
  return rows[0].n;
}

describe('phiếu đầu kỳ ghi sổ thì thoát chờ kiểm kê (#198 AC-11, AC-S4)', () => {
  it('AC-11a, AC-11b, AC-S4: openingStocktake null, mốc = countedAt, nhật ký hệ thống, xếp đúng một lượt đơn còn mở', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId, number } = await waitingShop(c);
    const before = await shopRow(shopId);
    expect(await openPullJobs(shopId)).toBe(0);
    const event = posted(shopId, documentId, { number });
    const occurredAt = new Date(Date.now() - 2_000);

    await stocktakePosted(c, event, occurredAt);

    const after = await shopRow(shopId);
    expect(after).toMatchObject({
      status: 'active',
      opening_stocktake_id: null,
      opening_stocktake_number: null,
      open_orders_pulled_at: null,
      version: before.version + 1,
    });
    expect(after.order_cutoff_at.toISOString()).toBe(event.countedAt);
    // Có listing ghép mà chưa có lần phân hàng nào từ lúc ghi sổ: chờ phân hàng, mốc = occurredAt của sự kiện (I2).
    expect(after.allocation_pending_since.getTime()).toBe(occurredAt.getTime());
    const one = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(one.body).toMatchObject({ openingStocktake: null, orderCutoffAt: event.countedAt });

    const { rows: audit } = await testPool().query(
      "select actor_id, action, before, after from core.audit_logs where company_id = $1 and entity_type = 'channel.shops' and entity_id = $2",
      [c.companyId, shopId],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_id: null,
      action: 'update',
      before: { openingStocktakeId: documentId, openingStocktakeNumber: number },
      after: { orderCutoffAt: event.countedAt, openingStocktakeId: null, stocktakeNumber: number },
    });
    expect(new Date(audit[0].before.orderCutoffAt).getTime()).toBe(before.order_cutoff_at.getTime());
    // Việc duy nhất của hàng đơn mở là việc handler vừa xếp (hàng đã trống trước khi phát).
    expect(await openPullJobs(shopId)).toBe(1);

    // Lượt đơn mở chưa chạy lại thì vẫn giữ tồn: đồng bộ chỉ đẩy giá.
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(updatePriceQuantity.mock.calls.flatMap((call) => call[1]).some((i) => 'quantity' in i)).toBe(false);
  });

  it('I1: đơn đặt giữa lúc thiết lập và countedAt, chưa có trong DB, vẫn về qua lượt đơn còn mở chạy lại; xong mới đẩy tồn', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const placedAt = new Date();
    await new Promise((r) => setTimeout(r, 5));
    const countedAt = new Date().toISOString();
    open = [remoteOrder(`GIUA-${randomUUID().slice(0, 8)}`, placedAt)];

    await stocktakePosted(c, posted(shopId, documentId, { countedAt, postedAt: countedAt }));
    expect(placedAt.getTime()).toBeLessThan((await shopRow(shopId)).order_cutoff_at.getTime());

    await runOpenOrderPull({ companyId: c.companyId, shopId });
    const { rows } = await testPool().query('select external_order_id from channel.raw_orders where shop_id = $1', [shopId]);
    expect(rows.map((r) => r.external_order_id)).toEqual([open[0]!.externalOrderId]);
    expect((await shopRow(shopId)).open_orders_pulled_at).not.toBeNull();

  });

  it('I2 (B): đơn mở xong mà chưa có allocation_done thì không đẩy tồn; có thì xếp đồng bộ và đẩy đúng một lần; phát lại không đổi gì', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const since = new Date(Date.now() - 1000);
    await stocktakePosted(c, posted(shopId, documentId), since);
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect((await shopRow(shopId)).open_orders_pulled_at).not.toBeNull();

    // Lượt đồng bộ sau lượt đơn mở: còn chờ phân hàng nên chỉ đẩy giá.
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(quantityPushes()).toBe(0);
    const pending = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(pending.body.setup.steps.slice(-2)).toEqual([
      { key: 'allocate', status: 'running', blockedBy: null },
      { key: 'push_stock', status: 'blocked', blockedBy: 'allocate' },
    ]);

    // Phân hàng trước lúc ghi sổ, hoặc của biến thể khác, không tính.
    await allocated(c, [variant.id], new Date(since.getTime() - 1));
    await allocated(c, [randomUUID()], new Date());
    expect((await shopRow(shopId)).allocation_pending_since).not.toBeNull();

    await clearListingSyncJobs(shopId);
    await allocated(c, [variant.id], new Date());
    expect((await shopRow(shopId)).allocation_pending_since).toBeNull();
    expect(await listingSyncJobs(shopId)).toBe(1);
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ externalSkuId: 'sku-os', quantity: 7 })]);
    expect(quantityPushes()).toBe(1);

    // Phát lại: không xếp thêm việc, lượt đồng bộ sau không đẩy tồn lần nữa (đã synced).
    await clearListingSyncJobs(shopId);
    await allocated(c, [variant.id], new Date());
    expect(await listingSyncJobs(shopId)).toBe(0);
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(quantityPushes()).toBe(1);
  });

  it('I2 (B): allocation_done tới trước sự kiện ghi sổ (topic khác) vẫn được tính; công ty khác không tính', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const other = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const since = new Date(Date.now() - 1000);
    await allocated(other, [variant.id], new Date());
    await stocktakePosted(c, posted(shopId, documentId), since);
    expect((await shopRow(shopId)).allocation_pending_since).not.toBeNull();

    const c2 = await createCompany({ optionalModules: ['channel'] });
    const w2 = await waitingShop(c2);
    await allocated(c2, [variant.id], new Date());
    await stocktakePosted(c2, posted(w2.shopId, w2.documentId), since);
    expect((await shopRow(w2.shopId)).allocation_pending_since).toBeNull();
  });

  it('gian hàng không active (mất uỷ quyền): vẫn thoát chờ và đổi mốc, không xếp việc (nối lại sẽ xếp)', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shopId]);
    const event = posted(shopId, documentId);

    await stocktakePosted(c, event);

    const after = await shopRow(shopId);
    expect(after).toMatchObject({ status: 'needs_reauth', opening_stocktake_id: null, open_orders_pulled_at: null });
    expect(after.order_cutoff_at.toISOString()).toBe(event.countedAt);
    expect(await openPullJobs(shopId)).toBe(0);
  });

  it('xếp việc lỗi thì cả giao dịch rollback: gian hàng vẫn chờ, không có nhật ký', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);
    jobs.failNext = true;

    await expect(stocktakePosted(c, posted(shopId, documentId))).rejects.toThrow('pg-boss lỗi giả');

    expect(await shopRow(shopId)).toEqual(before);
    expect(await auditCount(shopId)).toBe(0);
    expect(await openPullJobs(shopId)).toBe(0);
  });

  it('AC-11d: thoát chờ thì công ty không còn bị chặn, gian hàng thứ hai thiết lập push được', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const second = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set(auth(c))
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const secondId = second.body.shop.id as string;
    const blocked = await app().post(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c)).send({ externalSkuIds: [], openingStock: 'push' });
    expect(blocked.status).toBe(422);

    await stocktakePosted(c, posted(shopId, documentId));

    const preview = await app().get(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c));
    expect(preview.body.firstShopOfCompany).toBe(false);
    const ok = await app().post(`/api/v1/channel/shops/${secondId}/setup`).set(auth(c)).send({ externalSkuIds: [], openingStock: 'push' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('AC-11c: phiếu khác, nguồn null, gian hàng công ty khác, phát lại lần hai: không đổi gì', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const other = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);

    await stocktakePosted(c, posted(shopId, randomUUID()));
    await stocktakePosted(c, posted(shopId, documentId, { source: null }));
    // RLS: công ty khác không thấy gian hàng này
    await stocktakePosted(other, posted(shopId, documentId));
    expect(await shopRow(shopId)).toEqual(before);

    await stocktakePosted(c, posted(shopId, documentId));
    const once = await shopRow(shopId);
    await stocktakePosted(c, posted(shopId, documentId));
    expect(await shopRow(shopId)).toEqual(once);
    expect(await auditCount(shopId)).toBe(1);
  });

  it('S1: countedAt sau postedAt hoặc ở tương lai thì ném (consumer thử lại rồi DLQ), không đổi gì', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();

    await expect(
      stocktakePosted(c, posted(shopId, documentId, { countedAt: iso(now), postedAt: iso(now - 60_000) })),
    ).rejects.toThrow(/sau postedAt/);
    const future = iso(now + 3_600_000);
    await expect(
      stocktakePosted(c, posted(shopId, documentId, { countedAt: future, postedAt: future })),
    ).rejects.toThrow(/tương lai/);
    expect(await shopRow(shopId)).toEqual(before);
  });

  it('S1: countedAt trước lúc thiết lập thì vẫn đặt mốc (chỉ ghi log cảnh báo)', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const early = new Date((await shopRow(shopId)).order_cutoff_at.getTime() - 3_600_000).toISOString();

    await stocktakePosted(c, posted(shopId, documentId, { countedAt: early }));

    expect((await shopRow(shopId)).order_cutoff_at.toISOString()).toBe(early);
  });
});

describe('chờ phân hàng sau khi thoát chờ kiểm kê (#198 review B: I1, I2, I3)', () => {
  it('I2: qua consumer thật, mốc chờ = occurredAt của stocktake_posted; allocation_done đúng bằng mốc (>=) thì hết chờ, sớm 1 ms thì không', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    // `postedAt` (giờ máy inventory) lệch hẳn khỏi `occurredAt` (giờ outbox): mốc phải theo `occurredAt`.
    const occurredAt = new Date(Date.now() - 5_000);
    const postedAt = new Date(occurredAt.getTime() + 2_000).toISOString();
    await viaConsumer(c, 'inventory.stocktake_posted', posted(shopId, documentId, { postedAt, countedAt: postedAt }), occurredAt);
    expect((await shopRow(shopId)).allocation_pending_since.getTime()).toBe(occurredAt.getTime());

    await viaConsumer(c, 'fulfillment.allocation_done', { variantIds: [variant.id] }, new Date(occurredAt.getTime() - 1));
    expect((await shopRow(shopId)).allocation_pending_since).not.toBeNull();
    // Trước khi sửa I2, lần phân hàng này (sau occurredAt nhưng trước postedAt) bị coi là cũ.
    await viaConsumer(c, 'fulfillment.allocation_done', { variantIds: [variant.id] }, occurredAt);
    expect((await shopRow(shopId)).allocation_pending_since).toBeNull();
  });

  it('allocation_done tới trước khi lượt đơn mở xong: hết chờ nhưng chưa xếp đồng bộ; lượt đơn mở xong mới xếp và đẩy tồn', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await clearListingSyncJobs(shopId);

    await allocated(c, [variant.id], new Date());
    expect(await shopRow(shopId)).toMatchObject({ allocation_pending_since: null, open_orders_pulled_at: null });
    expect(await listingSyncJobs(shopId)).toBe(0);
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(quantityPushes()).toBe(0);

    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect(await listingSyncJobs(shopId)).toBe(1);
    await app().post(`/api/v1/channel/shops/${shopId}/listings/sync`).set(auth(c));
    expect(quantityPushes()).toBe(1);
  });

  it('gian hàng không active nhận allocation_done: hết chờ, không xếp đồng bộ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await testPool().query("update channel.shops set status = 'needs_reauth', open_orders_pulled_at = now() where id = $1", [shopId]);
    await clearListingSyncJobs(shopId);

    await allocated(c, [variant.id], new Date());

    expect((await shopRow(shopId)).allocation_pending_since).toBeNull();
    expect(await listingSyncJobs(shopId)).toBe(0);
  });

  it('allocation_done chỉ phủ một phần biến thể đã ghép: vẫn chờ tới khi đủ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c, ['sku-os', 'sku-os2']);
    await stocktakePosted(c, posted(shopId, documentId));

    await allocated(c, [variant.id], new Date());
    expect((await shopRow(shopId)).allocation_pending_since).not.toBeNull();
    await allocated(c, [variant2.id], new Date());
    expect((await shopRow(shopId)).allocation_pending_since).toBeNull();
  });

  it('gian hàng không có listing nào: hết chờ phân hàng ngay khi thoát chờ kiểm kê', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c, []);

    await stocktakePosted(c, posted(shopId, documentId));

    expect(await shopRow(shopId)).toMatchObject({ opening_stocktake_id: null, allocation_pending_since: null });
  });

  it('I1: đẩy listing mới trong lúc chờ phân hàng thì tạo sản phẩm với tồn 0, tồn để chờ đồng bộ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [shopId]);
    const map = await app()
      .put(`/api/v1/channel/shops/${shopId}/category-maps/${fresh.categoryId}`)
      .set(auth(c))
      .send({ externalCategoryId: '14275', attributes: { brand: 'No Brand' }, version: null });
    expect(map.status).toBe(200);

    const res = await app()
      .post(`/api/v1/channel/shops/${shopId}/listings/push`)
      .set(auth(c))
      .send({ variantIds: [fresh.id], imageUrls: { [fresh.productId]: ['https://img.test/a.png'] } });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.results).toEqual([expect.objectContaining({ outcome: 'created' })]);
    expect(created).toEqual([expect.objectContaining({ sellerSku: fresh.sku, quantity: 0 })]);
    const { rows } = await testPool().query('select stock_sync, platform_stock from channel.listings where shop_id = $1 and variant_id = $2', [
      shopId,
      fresh.id,
    ]);
    expect(rows).toEqual([{ stock_sync: 'pending', platform_stock: 0 }]);
  });
});
