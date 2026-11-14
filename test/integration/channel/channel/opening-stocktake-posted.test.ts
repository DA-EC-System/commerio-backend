// #198 phần 2: phiếu kiểm kê đầu kỳ ghi sổ (`inventory.stocktake_posted`, Documents/21 §11.2) thì gian hàng thoát chế độ
// chờ kiểm kê, mốc kéo đơn = thời điểm đếm, lượt kéo đơn còn mở chạy lại, rồi chờ phân hàng tới khi nhận
// `fulfillment.allocation_done` có `cause.documentId` trùng phiếu (§18.6.2, §18.6.11). Trong giao dịch thoát chờ, channel gọi
// `settleOpeningStocktake` của fulfillment (§11.3, Documents#97); test giả lập cổng này (ghi tham số, đọc dòng gian hàng
// trong giao dịch, cho ném). Lập lại phiếu bị từ chối, huỷ (`POST /shops/:id/opening-stocktake`). Sự kiện tự phát theo
// payload của Documents, chưa cần #278, #199 phần b.
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventPayload } from '#src/modules/core/index.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { runOpenOrderPull } from '#src/modules/channel/channel/service/background.ts';
import { runListingPush } from '#src/modules/channel/channel/service/listing-push.ts';
import { stopJobs } from '#src/modules/core/platform/service/jobs/boss.ts';
import {
  handleAllocationDone,
  handleStocktakePosted,
  onAllocationDone,
  onOpeningStocktakePosted,
} from '#src/modules/channel/channel/service/opening-stocktake.ts';
import { HandlerFailure, type IncomingMessage, processMessage, type ProcessDeps } from '#src/modules/core/platform/service/outbox/consumer.ts';
import type { NewProduct } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { type OpeningStocktakeStatus, setStocktakePort } from '#src/modules/channel/channel/service/stocktake-port.ts';
import type { RemoteOrder, RemoteOrderRef, RemoteSku } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { type ListingVariant, setProductPort } from '#src/modules/channel/channel/service/product-port.ts';
import { syncListings } from '#src/modules/channel/channel/service/listing-sync.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { noLineInfo, noOrderInfo, noShipping } from '../../order/sales/helpers.ts';
import { fakeAdapter } from './helpers.ts';
import type * as ShopJobs from '#src/modules/channel/channel/service/shop-jobs.ts';
import type * as Order from '#src/modules/order/index.ts';

// Ca rollback: cho `sendOpenOrderPull` ném một lần, các ca khác chạy bản thật.
const jobs = vi.hoisted(() => ({ failNext: false }));
// Cổng `settleOpeningStocktake` của fulfillment (§11.3): ghi tham số và `opening_stocktake_id` đọc trong chính giao dịch
// của bên gọi (null nghĩa là gọi sau khi đặt `openingStocktake = null`, cùng giao dịch, vì giao dịch chưa commit); `failNext`
// cho ném một lần. Không ném thì chạy hàm thật của `order`.
const settle = vi.hoisted(() => ({
  failNext: false,
  calls: [] as { shopId: string; documentId: string; countedAt: Date; openingStocktakeIdInTx: string | null }[],
}));
vi.mock('#src/modules/order/index.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Order>();
  return {
    ...real,
    settleOpeningStocktake: async (p: { shopId: string; documentId: string; countedAt: Date }) => {
      const { rows } = await getDb().execute<{ opening_stocktake_id: string | null }>(
        sql`select opening_stocktake_id from channel.shops where id = ${p.shopId}`,
      );
      settle.calls.push({ ...p, openingStocktakeIdInTx: rows[0]!.opening_stocktake_id });
      if (settle.failNext) {
        settle.failNext = false;
        throw new Error('settleOpeningStocktake lỗi giả');
      }
      return real.settleOpeningStocktake(p);
    },
  };
});
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
  businessStatus: 'selling',
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
const docStatus = new Map<string, OpeningStocktakeStatus>();
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

const port = {
  variants: async (ids?: readonly string[]) => [variant, variant2, fresh].filter((v) => !ids || ids.includes(v.id)),
  standardPrices: async (ids: readonly string[]) => new Map(ids.map((id) => [id, new Decimal(50000)])),
  productImageUrls: async (ids: readonly string[]) => new Map(ids.map((id) => [id, ['https://img.test/a.png']])),
  availableOf: async (ids: readonly string[]) => new Map(ids.map((id) => [id, 7])),
};

beforeAll(() => {
  setProductPort(port);
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
  // Phiếu mới ở `draft`; ca lập lại phiếu đổi trạng thái qua `docStatus`, xoá id là phiếu "không còn".
  setStocktakePort({
    async createOpeningStocktake() {
      const documentId = randomUUID();
      docStatus.set(documentId, 'draft');
      return { documentId, number: `KK-${randomUUID().slice(0, 6)}`, created: true };
    },
    openingStocktakeStatusOf: async (ids) => new Map(ids.flatMap((id) => (docStatus.has(id) ? [[id, docStatus.get(id)!] as const] : []))),
  });
});
afterAll(async () => {
  resetAdapters();
  setProductPort(null);
  setStocktakePort();
  await stopJobs();
});
afterEach(() => {
  updatePriceQuantity.mockClear();
  created.length = 0;
  open = [];
  jobs.failNext = false;
  settle.failNext = false;
  settle.calls.length = 0;
  docStatus.clear();
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

/** Phát `stocktake_posted` như consumer, trong `withCompany` của sự kiện. */
const stocktakePosted = (c: Company, event: EventPayload<'inventory.stocktake_posted'>) =>
  withCompany(c.companyId, () => onOpeningStocktakePosted(event));

/** Chạy một sự kiện qua `processMessage` thật, handler đăng ký như `channel/index.ts`, trong `withCompany` như `runShared`. */
async function viaConsumer(
  c: Company,
  type: 'inventory.stocktake_posted' | 'fulfillment.allocation_done',
  payload: unknown,
  opts: { attempt?: number; retryDelaysMs?: number[]; dlq?: string[] } = {},
) {
  const envelope = { eventId: randomUUID(), type, companyId: c.companyId, aggregateId: randomUUID(), occurredAt: new Date().toISOString(), payload };
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
    retryDelaysMs: opts.retryDelaysMs ?? [],
    runHandler: async (e, h) => {
      try {
        await withCompany(c.companyId, () => h(e));
      } catch (err) {
        throw new HandlerFailure(err);
      }
    },
    sendToDlq: async (_m, reason) => {
      if (!opts.dlq) throw new Error(`DLQ: ${reason}`);
      opts.dlq.push(reason);
    },
  };
  return processMessage(message, opts.attempt ?? 0, deps);
}

async function shopRow(id: string) {
  const { rows } = await testPool().query(
    'select status, order_cutoff_at, opening_stocktake_id, opening_stocktake_number, open_orders_pulled_at, allocation_stocktake_id, version from channel.shops where id = $1',
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
/** `allocation_done` như fulfillment phát; `documentId` có thì kèm `cause` của phiếu đầu kỳ (§11.2). */
const allocated = (c: Company, documentId?: string, variantIds: string[] = [variant.id]) =>
  withCompany(c.companyId, () => onAllocationDone({ variantIds, ...(documentId && { cause: { type: 'stocktake' as const, documentId } }) }));

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

    await stocktakePosted(c, event);

    const after = await shopRow(shopId);
    expect(after).toMatchObject({
      status: 'active',
      opening_stocktake_id: null,
      opening_stocktake_number: null,
      open_orders_pulled_at: null,
      version: before.version + 1,
    });
    expect(after.order_cutoff_at.toISOString()).toBe(event.countedAt);
    // Chờ phân hàng theo đúng phiếu vừa ghi sổ (§18.6.11).
    expect(after.allocation_stocktake_id).toBe(documentId);
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
    await syncListings(port, c.companyId, shopId);
    expect(updatePriceQuantity.mock.calls.flatMap((call) => call[1]).some((i) => 'quantity' in i)).toBe(false);
  });

  it('gọi settleOpeningStocktake đúng một lần, trong giao dịch thoát chờ, sau khi đặt openingStocktake = null, đúng tham số', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const event = posted(shopId, documentId);

    await stocktakePosted(c, event);

    expect(settle.calls).toEqual([{ shopId, documentId, countedAt: new Date(event.countedAt), openingStocktakeIdInTx: null }]);
    // Phát lại, phiếu khác, nguồn khác: không gọi thêm.
    await stocktakePosted(c, event);
    await stocktakePosted(c, posted(shopId, randomUUID()));
    await stocktakePosted(c, posted(shopId, documentId, { source: null }));
    expect(settle.calls).toHaveLength(1);
  });

  it('settleOpeningStocktake lỗi: cả giao dịch rollback (vẫn chờ kiểm kê, không nhật ký, không xếp việc); consumer thử lại thì thoát chờ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);
    const event = posted(shopId, documentId);
    settle.failNext = true;

    expect(await viaConsumer(c, 'inventory.stocktake_posted', event, { retryDelaysMs: [1_000] })).toEqual({ kind: 'retry', delayMs: 1_000 });

    expect(await shopRow(shopId)).toEqual(before);
    expect(await auditCount(shopId)).toBe(0);
    expect(await openPullJobs(shopId)).toBe(0);
    const view = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(view.body.openingStocktake).toMatchObject({ documentId });

    expect(await viaConsumer(c, 'inventory.stocktake_posted', event, { attempt: 1, retryDelaysMs: [1_000] })).toEqual({ kind: 'done' });
    expect(await shopRow(shopId)).toMatchObject({ opening_stocktake_id: null, allocation_stocktake_id: documentId });
    expect(await openPullJobs(shopId)).toBe(1);
    expect(settle.calls.map((call) => call.openingStocktakeIdInTx)).toEqual([null, null]);
  });

  it('settleOpeningStocktake lỗi tới hết số lần thử: vào DLQ, gian hàng vẫn chờ, phiếu posted; lập lại phiếu trả 409 shop_not_awaiting_stocktake', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);
    settle.failNext = true;
    const dlq: string[] = [];

    expect(await viaConsumer(c, 'inventory.stocktake_posted', posted(shopId, documentId), { dlq })).toEqual({ kind: 'done' });

    expect(dlq).toEqual([expect.stringMatching(/settleOpeningStocktake lỗi giả/)]);
    expect(await shopRow(shopId)).toEqual(before);
    docStatus.set(documentId, 'posted');
    const view = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(view.body.openingStocktake).toEqual({ documentId, number: expect.any(String), status: 'posted' });
    const res = await app().post(`/api/v1/channel/shops/${shopId}/opening-stocktake`).set(auth(c));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_awaiting_stocktake');
  });

  it('channel.shops không có cột allocated_stocktake_id (bỏ khỏi thiết kế, Documents/19 `shops`)', async () => {
    const { rows } = await testPool().query(
      "select column_name from information_schema.columns where table_schema = 'channel' and table_name = 'shops' and column_name like 'allocat%'",
    );
    expect(rows.map((r) => r.column_name)).toEqual(['allocation_stocktake_id']);
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

describe('chờ phân hàng: thoát khi nhận allocation_done có cause.documentId trùng phiếu (§11.2, §18.6.11)', () => {
  it('không có cause, cause phiếu khác: vẫn chờ, không đẩy tồn; cause trùng: thoát, xếp đồng bộ, đẩy tồn đúng một lần; phát lại không đổi gì', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect((await shopRow(shopId)).open_orders_pulled_at).not.toBeNull();

    // Lượt đồng bộ sau lượt đơn mở: còn chờ phân hàng nên chỉ đẩy giá.
    await syncListings(port, c.companyId, shopId);
    expect(quantityPushes()).toBe(0);
    const pending = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(pending.body.setup.steps.slice(-2)).toEqual([
      { key: 'allocate', status: 'running', blockedBy: null },
      { key: 'push_stock', status: 'blocked', blockedBy: 'allocate' },
    ]);

    await clearListingSyncJobs(shopId);
    await allocated(c);
    await allocated(c, randomUUID());
    expect((await shopRow(shopId)).allocation_stocktake_id).toBe(documentId);
    expect(await listingSyncJobs(shopId)).toBe(0);

    await allocated(c, documentId);
    expect((await shopRow(shopId)).allocation_stocktake_id).toBeNull();
    expect(await listingSyncJobs(shopId)).toBe(1);
    const done = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(done.body.setup.steps.find((s: { key: string }) => s.key === 'allocate')).toEqual({ key: 'allocate', status: 'done', blockedBy: null });
    await syncListings(port, c.companyId, shopId);
    expect(updatePriceQuantity).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ externalSkuId: 'sku-os', quantity: 7 })]);
    expect(quantityPushes()).toBe(1);

    // Phát lại: không xếp thêm việc, lượt đồng bộ sau không đẩy tồn lần nữa (đã synced).
    await clearListingSyncJobs(shopId);
    await allocated(c, documentId);
    expect(await listingSyncJobs(shopId)).toBe(0);
    await syncListings(port, c.companyId, shopId);
    expect(quantityPushes()).toBe(1);
  });

  it('qua consumer thật: allocation_done có cause, variantIds rỗng (đếm khớp sổ) vẫn thoát chờ; không có cause thì không', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    expect(await viaConsumer(c, 'inventory.stocktake_posted', posted(shopId, documentId))).toEqual({ kind: 'done' });
    expect((await shopRow(shopId)).allocation_stocktake_id).toBe(documentId);

    expect(await viaConsumer(c, 'fulfillment.allocation_done', { variantIds: [variant.id] })).toEqual({ kind: 'done' });
    expect((await shopRow(shopId)).allocation_stocktake_id).toBe(documentId);
    const cause = { variantIds: [], cause: { type: 'stocktake', documentId } };
    expect(await viaConsumer(c, 'fulfillment.allocation_done', cause)).toEqual({ kind: 'done' });
    expect((await shopRow(shopId)).allocation_stocktake_id).toBeNull();
    // Nhận trùng: `allocation_stocktake_id` đã null nên tự bị bỏ qua (Documents/19 `shops`).
    expect(await viaConsumer(c, 'fulfillment.allocation_done', cause)).toEqual({ kind: 'done' });
    expect((await shopRow(shopId)).allocation_stocktake_id).toBeNull();
  });

  it('allocation_done có cause khi gian hàng còn chờ kiểm kê: không đổi gì (sự kiện thật chỉ phát trong giao dịch thoát chờ)', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    const before = await shopRow(shopId);

    await allocated(c, documentId, []);

    expect(await shopRow(shopId)).toEqual(before);
  });

  it('công ty khác (RLS) gửi cause trùng phiếu: không thoát chờ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const other = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));

    await allocated(other, documentId);

    expect((await shopRow(shopId)).allocation_stocktake_id).toBe(documentId);
  });

  it('allocation_done tới trước khi lượt đơn mở xong: thoát chờ nhưng chưa xếp đồng bộ; lượt đơn mở xong mới xếp và đẩy tồn', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await clearListingSyncJobs(shopId);

    await allocated(c, documentId);
    expect(await shopRow(shopId)).toMatchObject({ allocation_stocktake_id: null, open_orders_pulled_at: null });
    expect(await listingSyncJobs(shopId)).toBe(0);
    await syncListings(port, c.companyId, shopId);
    expect(quantityPushes()).toBe(0);

    await runOpenOrderPull({ companyId: c.companyId, shopId });
    expect(await listingSyncJobs(shopId)).toBe(1);
    await syncListings(port, c.companyId, shopId);
    expect(quantityPushes()).toBe(1);
  });

  it('gian hàng không active nhận allocation_done: thoát chờ, không xếp đồng bộ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await testPool().query("update channel.shops set status = 'needs_reauth', open_orders_pulled_at = now() where id = $1", [shopId]);
    await clearListingSyncJobs(shopId);

    await allocated(c, documentId);

    expect((await shopRow(shopId)).allocation_stocktake_id).toBeNull();
    expect(await listingSyncJobs(shopId)).toBe(0);
  });
});

describe('đẩy listing khi đang giữ tồn: 409 (§18.6.11)', () => {
  async function mapCategory(c: Company, shopId: string) {
    const map = await app()
      .put(`/api/v1/channel/shops/${shopId}/category-maps/${fresh.categoryId}`)
      .set(auth(c))
      .send({ externalCategoryId: '14275', attributes: { brand: 'No Brand' }, version: null });
    expect(map.status).toBe(200);
  }
  const push = (c: Company, shopId: string) =>
    app()
      .post(`/api/v1/channel/shops/${shopId}/listings/push`)
      .set(auth(c))
      .send({ variantIds: [fresh.id], imageUrls: { [fresh.productId]: ['https://img.test/a.png'] } });
  async function listingRows(shopId: string) {
    const { rows } = await testPool().query('select stock_sync from channel.listings where shop_id = $1 and variant_id = $2', [shopId, fresh.id]);
    return rows;
  }

  it('chờ kiểm kê → shop_awaiting_stocktake; lượt đơn mở chưa xong → open_orders (dù đang chờ phân hàng); chờ phân hàng → allocation; thoát chờ → đẩy được', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await mapCategory(c, shopId);

    expect((await push(c, shopId)).body.code).toBe('shop_awaiting_stocktake');

    await stocktakePosted(c, posted(shopId, documentId));
    const openOrders = await push(c, shopId);
    expect(openOrders.status).toBe(409);
    expect(openOrders.body).toMatchObject({ code: 'shop_awaiting_allocation', waitingFor: 'open_orders' });

    await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [shopId]);
    const allocation = await push(c, shopId);
    expect(allocation.status).toBe(409);
    expect(allocation.body).toMatchObject({ code: 'shop_awaiting_allocation', waitingFor: 'allocation' });
    // Không đẩy sản phẩm với tồn 0, không có listing.
    expect(created).toEqual([]);
    expect(await listingRows(shopId)).toEqual([]);

    await allocated(c, documentId);
    const ok = await push(c, shopId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    // Đẩy chạy nền (#219): request xếp việc, chạy việc như worker rồi mới thấy sản phẩm tạo trên sàn.
    expect(ok.body.results).toEqual([expect.objectContaining({ status: 'pushing', code: null })]);
    expect(created).toEqual([]);
    await runListingPush(port, { companyId: c.companyId, shopId, listingId: ok.body.results[0].listingId, imageUrls: ['https://img.test/a.png'] });
    expect(created).toEqual([expect.objectContaining({ sellerSku: fresh.sku, quantity: 7 })]);
    expect(await listingRows(shopId)).toEqual([{ stock_sync: 'synced' }]);
  });

  it('thứ tự kiểm: gian hàng không active thì shop_not_active trước shop_awaiting_stocktake', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId } = await waitingShop(c);
    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shopId]);

    const res = await push(c, shopId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_not_active', current: 'needs_reauth' });
  });

  it('gian hàng chế độ push, lượt đơn mở chưa xong: 409 shop_awaiting_allocation, waitingFor open_orders', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    await stocktakePosted(c, posted(shopId, documentId));
    await allocated(c, documentId);
    await testPool().query('update channel.shops set open_orders_pulled_at = now() where id = $1', [shopId]);
    const token = await app()
      .post('/api/v1/channel/shops/lazada/token')
      .set(auth(c))
      .send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const second = token.body.shop.id as string;
    const setup = await app().post(`/api/v1/channel/shops/${second}/setup`).set(auth(c)).send({ externalSkuIds: [], openingStock: 'push' });
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    await mapCategory(c, second);

    const res = await push(c, second);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'shop_awaiting_allocation', waitingFor: 'open_orders' });
  });
});

describe('POST /channel/shops/:id/opening-stocktake: lập lại phiếu kiểm kê đầu kỳ (§18.6.11)', () => {
  const recreate = (c: Company, shopId: string, token = c.ceo.token) =>
    app().post(`/api/v1/channel/shops/${shopId}/opening-stocktake`).set({ Authorization: `Bearer ${token}` });

  it.each(['draft', 'pending'] as const)('phiếu hiện tại %s: 409 opening_stocktake_open kèm number, status', async (status) => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId, number } = await waitingShop(c);
    docStatus.set(documentId, status);

    const res = await recreate(c, shopId);

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'opening_stocktake_open', number, status });
  });

  it('phiếu bị từ chối: lập phiếu mới draft, giữ mốc tạm, ghi nhật ký; gọi lại thì 409 opening_stocktake_open; phiếu mới ghi sổ thì thoát chờ', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId, number } = await waitingShop(c);
    docStatus.set(documentId, 'rejected');
    const before = await shopRow(shopId);
    const view = await app().get(`/api/v1/channel/shops/${shopId}`).set(auth(c));
    expect(view.body.openingStocktake).toEqual({ documentId, number, status: 'rejected' });

    const res = await recreate(c, shopId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const next = res.body.shop.openingStocktake;
    expect(next).toEqual({ documentId: expect.any(String), number: res.body.stocktakeNumber, status: 'draft' });
    expect(next.documentId).not.toBe(documentId);
    const after = await shopRow(shopId);
    expect(after).toMatchObject({ opening_stocktake_id: next.documentId, version: before.version + 1 });
    expect(after.order_cutoff_at.getTime()).toBe(before.order_cutoff_at.getTime());
    const { rows: audit } = await testPool().query(
      "select actor_id, before, after from core.audit_logs where entity_type = 'channel.shops' and entity_id = $1",
      [shopId],
    );
    expect(audit).toEqual([
      {
        actor_id: expect.any(String),
        before: { openingStocktakeId: documentId, openingStocktakeNumber: number, openingStocktakeStatus: 'rejected' },
        after: { openingStocktakeId: next.documentId, openingStocktakeNumber: next.number },
      },
    ]);

    const again = await recreate(c, shopId);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'opening_stocktake_open', number: next.number, status: 'draft' });

    // Phiếu cũ không còn làm thoát chờ; phiếu mới thì có.
    await stocktakePosted(c, posted(shopId, documentId));
    expect((await shopRow(shopId)).opening_stocktake_id).toBe(next.documentId);
    await stocktakePosted(c, posted(shopId, next.documentId));
    expect(await shopRow(shopId)).toMatchObject({ opening_stocktake_id: null, allocation_stocktake_id: next.documentId });
  });

  it.each([
    ['cancelled', 'cancelled' as const],
    ['không còn', null],
  ])('phiếu %s: lập được phiếu mới', async (_name, status) => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    if (status) docStatus.set(documentId, status);
    else docStatus.delete(documentId);

    const res = await recreate(c, shopId);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.shop.openingStocktake.status).toBe('draft');
  });

  it('phiếu đã ghi sổ (sự kiện chưa xử lý) hoặc openingStocktake null: 409 shop_not_awaiting_stocktake', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    docStatus.set(documentId, 'posted');
    expect((await recreate(c, shopId)).body.code).toBe('shop_not_awaiting_stocktake');

    await stocktakePosted(c, posted(shopId, documentId));
    const res = await recreate(c, shopId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_awaiting_stocktake');
  });

  it('gian hàng không active: 409 shop_not_active; thiếu quyền channel.shop.connect: 403; gian hàng công ty khác: 404', async () => {
    const c = await createCompany({ optionalModules: ['channel'] });
    const { shopId, documentId } = await waitingShop(c);
    docStatus.set(documentId, 'rejected');

    const viewer = await addMember(c.companyId, await createCustomRole(c.companyId, ['channel.shop.view']));
    expect((await recreate(c, shopId, viewer.token)).status).toBe(403);
    const other = await createCompany({ optionalModules: ['channel'] });
    expect((await recreate(other, shopId)).status).toBe(404);

    await testPool().query("update channel.shops set status = 'needs_reauth' where id = $1", [shopId]);
    const res = await recreate(c, shopId);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('shop_not_active');
  });
});
