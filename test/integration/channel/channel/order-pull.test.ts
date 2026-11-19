import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPullResult } from '#src/modules/channel/channel/api/schemas.ts';
import {
  MarketplaceError,
  type RemoteOrder,
  type RemoteOrderRef,
  type RemotePackageEvent,
} from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { notImplemented } from '#src/shared/errors/app-error.ts';
import { logger } from '#src/shared/logger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany, addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { setModuleEnabled } from '../../helpers/state.ts';
import { fakeAdapter } from './helpers.ts';
import { noLineInfo, noOrderInfo, noShipping } from '../../order/sales/helpers.ts';

const cutoff = new Date('2026-10-20T00:00:00Z');
const at = (iso: string) => new Date(iso);

function remoteOrder(id: string, sku: string, status: RemoteOrder['lines'][number]['status'], updatedAt: Date): RemoteOrder {
  return {
    externalOrderId: id,
    rawStatus: status ?? 'x',
    paid: true,
    isCod: true,
    placedAt: at('2026-10-25T00:00:00Z'),
    updatedAt,
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

// Sàn giả: danh sách đơn và chi tiết đổi được theo từng test.
let refs: RemoteOrderRef[] = [];
let details = new Map<string, RemoteOrder>();
let failOn: string | null = null;
// Con trỏ của sàn giả: vị trí trang tiếp; `pages` (nếu đặt) là các trang cố định, có thể có trang rỗng giữa chừng,
// `safeAt[i]` là `safeUntil` của trang i; `stuckCursor` thì luôn trả lại con trỏ cũ.
let pages: RemoteOrderRef[][] | null = null;
let safeAt: (Date | null)[] = [];
let stuckCursor = false;
const listOrders = vi.fn(async (_t: string, _after: Date, cursor: string | null) => {
  const i = Number(cursor ?? 0);
  const safeUntil = safeAt[i] ?? null;
  if (stuckCursor) return { orders: refs.slice(0, 1), nextCursor: '0', safeUntil };
  if (pages) return { orders: pages[i]!, nextCursor: i + 1 < pages.length ? String(i + 1) : null, safeUntil };
  return { orders: refs.slice(i, i + 2), nextCursor: i + 2 < refs.length ? String(i + 2) : null, safeUntil };
});
const getOrder = vi.fn(async (_t: string, id: string) => {
  if (id === failOn) throw new MarketplaceError('unavailable', '901');
  return details.get(id)!;
});
// Hành trình kiện của sàn giả (spec 199c §5.7): theo mã đơn, mặc định rỗng.
let traces = new Map<string, RemotePackageEvent[]>();
const getPackageEvents = vi.fn(async (_t: string, id: string) => traces.get(id) ?? []);

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    listOrders,
    getOrder,
    getPackageEvents,
  }),
);
// Sàn chỉ có năng lực lấy đơn theo lô (#267): bên kéo đơn không gọi `getOrder`.
const getOrders = vi.fn(async (_t: string, batch: readonly RemoteOrderRef[]) => batch.map((r) => details.get(r.externalOrderId)!));
registerAdapter(
  'tiktok',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử theo lô', region: 'VN' };
    },
    listOrders,
    getOrders,
  }),
);
afterAll(() => resetAdapters());

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
let sku: string;
let variantId: string;
const auth = (r: request.Test, token = company.ceo.token) => r.set('Authorization', `Bearer ${token}`);
const pull = (token?: string) => auth(app().post(`/api/v1/channel/shops/${shopId}/orders/pull`), token);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  const res = await auth(app().post('/api/v1/channel/shops/lazada/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
  shopId = res.body.shop.id;
  // Thiết lập lần đầu đã có test riêng (setup.test.ts): ở đây chỉ đặt mốc kéo đơn và ghép một SKU.
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = $2 where id = $1`, [shopId, cutoff]);
  ({ sku, variantId } = await createVariant(company.companyId));
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id) values ($1, $2, $3, $4, 'live', $5)`,
    [company.companyId, shopId, variantId, sku, `sku-${randomUUID().slice(0, 8)}`],
  );
});

beforeEach(() => {
  refs = [];
  pages = null;
  safeAt = [];
  stuckCursor = false;
  details = new Map();
  failOn = null;
  traces = new Map();
  getPackageEvents.mockClear();
  listOrders.mockClear();
  getOrder.mockClear();
  getOrders.mockClear();
});

const ordersOfShop = async () =>
  (
    await testPool().query(
      `select o.external_order_id, o.status, l.variant_id from "order".orders o join "order".order_lines l on l.order_id = o.id
        where o.shop_id = $1 order by o.external_order_id`,
      [shopId],
    )
  ).rows;
const cursor = async () => (await testPool().query(`select last_order_sync_at from channel.shops where id = $1`, [shopId])).rows[0].last_order_sync_at;

function seed(...orders: RemoteOrder[]) {
  for (const o of orders) {
    refs.push({ externalOrderId: o.externalOrderId, placedAt: o.placedAt, updatedAt: o.updatedAt });
    details.set(o.externalOrderId, o);
  }
}

describe('kéo đơn theo gian hàng (#105)', () => {
  it('kéo từ mốc thiết lập trừ 2 phút, lật trang, ghép SKU theo listing, lưu dữ liệu gốc, đẩy mốc', async () => {
    seed(
      remoteOrder('P1', sku, 'pending', at('2026-10-25T01:00:00Z')),
      remoteOrder('P2', 'SKU-NHOM-KHAC', 'pending', at('2026-10-25T02:00:00Z')),
      remoteOrder('P3', sku, 'packed', at('2026-10-25T03:00:00Z')),
    );
    const res = await pull();
    expect(res.status).toBe(200);
    expect(OrderPullResult.parse(res.body)).toEqual({ pulled: 3, created: 3, updated: 0 });
    expect(listOrders.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [at('2026-10-19T23:58:00Z'), null],
      [at('2026-10-19T23:58:00Z'), '2'],
    ]);
    expect(await ordersOfShop()).toEqual([
      { external_order_id: 'P1', status: 'processing', variant_id: variantId },
      { external_order_id: 'P2', status: 'processing', variant_id: null },
      { external_order_id: 'P3', status: 'processing', variant_id: variantId },
    ]);
    const raw = await testPool().query(`select external_status, order_id is not null as linked from channel.raw_orders where shop_id = $1 order by external_order_id`, [shopId]);
    expect(raw.rows).toEqual([
      { external_status: 'pending', linked: true },
      { external_status: 'pending', linked: true },
      { external_status: 'packed', linked: true },
    ]);
    // AC 17 (#236 PR 2): sàn `days` không báo mốc hết quyền trả, cột giữ null.
    const ends = await testPool().query(`select return_window_ends_at from "order".orders where shop_id = $1`, [shopId]);
    expect(ends.rows).toEqual([{ return_window_ends_at: null }, { return_window_ends_at: null }, { return_window_ends_at: null }]);
    expect(await cursor()).toEqual(at('2026-10-25T03:00:00Z'));
  });

  it('lần sau kéo từ mốc mới; đơn không đổi `updated_at` thì không gọi chi tiết', async () => {
    const p1 = remoteOrder('P1', sku, 'pending', at('2026-10-25T01:00:00Z'));
    const p3 = remoteOrder('P3', sku, 'awaiting_pickup', at('2026-10-26T00:00:00Z'));
    seed(p1, p3);
    const res = await pull();
    expect(res.body).toEqual({ pulled: 1, created: 0, updated: 1 });
    expect(listOrders.mock.calls[0]![1]).toEqual(at('2026-10-25T02:58:00Z'));
    expect(getOrder.mock.calls.map((c) => c[1])).toEqual(['P3']);
  });

  it('đơn đặt trước mốc thiết lập thì bỏ qua', async () => {
    const old = remoteOrder('OLD', sku, 'pending', at('2026-10-27T00:00:00Z'));
    old.placedAt = at('2026-10-01T00:00:00Z');
    seed(old);
    expect((await pull()).body).toEqual({ pulled: 0, created: 0, updated: 0 });
    expect(getOrder).not.toHaveBeenCalled();
  });

  it('sàn lỗi giữa chừng: đơn trước đó đã lưu, mốc dừng ở đơn cuối thành công, trả 503', async () => {
    seed(remoteOrder('P4', sku, 'pending', at('2026-10-28T01:00:00Z')), remoteOrder('P5', sku, 'pending', at('2026-10-28T02:00:00Z')));
    failOn = 'P5';
    const res = await pull();
    expect(res.status).toBe(503);
    expect(res.body.type).toMatch(/marketplace_unavailable$/);
    expect((await ordersOfShop()).map((o) => o.external_order_id)).toContain('P4');
    expect(await cursor()).toEqual(at('2026-10-28T01:00:00Z'));
  });

  it('lật theo con trỏ của adapter, kể cả trang rỗng giữa chừng; mốc tới đơn cuối đã ghi (#218)', async () => {
    const p6 = remoteOrder('P6', sku, 'pending', at('2026-10-29T01:00:00Z'));
    const p7 = remoteOrder('P7', sku, 'pending', at('2026-10-29T02:00:00Z'));
    seed(p6, p7);
    pages = [[refs[0]!], [], [refs[1]!]];
    expect((await pull()).body).toEqual({ pulled: 2, created: 2, updated: 0 });
    expect(listOrders.mock.calls.map((c) => c[2])).toEqual([null, '1', '2']);
    expect(await cursor()).toEqual(at('2026-10-29T02:00:00Z'));
  });

  it('adapter báo safeUntil: mốc không tiến qua mốc đó dù đã xử lý đơn mới hơn (#218)', async () => {
    seed(remoteOrder('P8', sku, 'pending', at('2026-10-30T01:00:00Z')), remoteOrder('P9', sku, 'pending', at('2026-10-30T09:00:00Z')));
    pages = [[refs[0]!], [refs[1]!]];
    safeAt = [null, at('2026-10-30T00:30:00Z')];
    expect((await pull()).body).toEqual({ pulled: 2, created: 2, updated: 0 });
    expect(await cursor()).toEqual(at('2026-10-30T00:30:00Z'));
  });

  it('adapter trả lại con trỏ cũ: dừng với 409, không lặp vô hạn; mốc tới đơn đã xử lý', async () => {
    seed(remoteOrder('P10', sku, 'pending', at('2026-10-31T01:00:00Z')));
    stuckCursor = true;
    const res = await pull();
    expect(res.status).toBe(409);
    expect(res.body.type).toMatch(/marketplace_rejected$/);
    expect(listOrders).toHaveBeenCalledTimes(2);
    expect(await cursor()).toEqual(at('2026-10-31T01:00:00Z'));
  });

  it('quyền: Sale không có channel.shop.sync 403; tắt Kênh bán 403 module_disabled', async () => {
    const sale = await addMember(company.companyId, 'sale');
    expect((await pull(sale.token)).status).toBe(403);
    await setModuleEnabled(company.companyId, 'channel', false);
    try {
      const res = await pull();
      expect(res.status).toBe(403);
      expect(res.body.type).toMatch(/module_disabled$/);
    } finally {
      await setModuleEnabled(company.companyId, 'channel', true);
    }
  });
});

// Migration chạy một lần (review #261 điểm 1): tìm theo đuôi tên để không vỡ khi đổi số lúc rebase hay sinh lại.
async function runRepullMigration(suffix = '_keo-lai-don-truoc-0017.sql') {
  const dir = join(process.cwd(), 'db', 'migrations');
  const file = readdirSync(dir).find((f) => f.endsWith(suffix))!;
  for (const stmt of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) {
    if (stmt.replace(/--.*$/gm, '').trim()) await testPool().query(stmt);
  }
}

describe('kéo lại đơn lưu trước #260 (migration chạy một lần)', () => {
  it('đơn thô thiếu `info` hay địa chỉ lặp phường: xoá mốc đơn và mốc gian hàng, lượt sau gọi lại chi tiết và ghi thông tin mới', async () => {
    const address = (text: string) => ({ name: 'N***n', phone: '84****11', address: text, ward: 'Phường Bến Nghé', postCode: null, raw: { city: 'Phường Bến Nghé' } });
    const m1 = remoteOrder('M1', sku, 'pending', at('2026-11-01T01:00:00Z'));
    const m2 = { ...remoteOrder('M2', sku, 'pending', at('2026-11-01T02:00:00Z')), shippingAddress: address('P**a, Phường Bến Nghé') };
    const m3 = { ...remoteOrder('M3', sku, 'pending', at('2026-11-01T03:00:00Z')), shippingAddress: address('P**a') };
    seed(m1, m2, m3);
    expect((await pull()).body).toEqual({ pulled: 3, created: 3, updated: 0 });
    // M1 giả lập đơn lưu bởi adapter trước #260: dữ liệu gốc không có `info`.
    await testPool().query(`update channel.raw_orders set payload = payload - 'info' where shop_id = $1 and external_order_id = 'M1'`, [shopId]);

    await runRepullMigration();

    expect(await cursor()).toBeNull();
    const times = await testPool().query(
      `select external_order_id as id, external_update_time is null as cleared from channel.raw_orders where shop_id = $1 and external_order_id like 'M%' order by 1`,
      [shopId],
    );
    expect(times.rows).toEqual([
      { id: 'M1', cleared: true },
      { id: 'M2', cleared: true },
      { id: 'M3', cleared: false },
    ]);

    getOrder.mockClear();
    listOrders.mockClear();
    details.set('M1', { ...m1, info: { ...noOrderInfo, buyerNote: 'Gọi trước' } });
    details.set('M2', { ...m2, shippingAddress: address('P**a') });
    expect((await pull()).body).toEqual({ pulled: 2, created: 0, updated: 0 });
    expect(listOrders.mock.calls[0]![1]).toEqual(at('2026-10-19T23:58:00Z'));
    expect(getOrder.mock.calls.map((c) => c[1])).toEqual(['M1', 'M2']);
    const saved = await testPool().query(
      `select o.external_order_id as id, o.buyer_note, o.shipping_address->>'address' as address, r.payload ? 'info' as has_info
         from "order".orders o join channel.raw_orders r on r.order_id = o.id where o.shop_id = $1 and o.external_order_id in ('M1', 'M2') order by 1`,
      [shopId],
    );
    expect(saved.rows).toEqual([
      { id: 'M1', buyer_note: 'Gọi trước', address: null, has_info: true },
      { id: 'M2', buyer_note: null, address: 'P**a', has_info: true },
    ]);
    expect(await cursor()).toEqual(at('2026-11-01T03:00:00Z'));
    // Chạy lại (bước sau rollout): đơn đã kéo lại bằng adapter mới không bị chọn, mốc giữ nguyên.
    await runRepullMigration();
    expect(await cursor()).toEqual(at('2026-11-01T03:00:00Z'));
  });
});

describe('kéo lại đơn có món trạng thái app chưa biết (#358, migration chạy một lần)', () => {
  const MIGRATION = '_keo-lai-don-trang-thai-moi.sql';
  const rawTimes = async (ids: string[]) =>
    (
      await testPool().query(
        `select external_order_id as id, external_update_time = 'epoch' as epoch from channel.raw_orders
          where shop_id = $1 and external_order_id = any($2) order by 1`,
        [shopId, ids],
      )
    ).rows;
  const packagesOf = async (externalOrderId: string) =>
    (
      await testPool().query(
        `select p.status from "order".packages p join "order".orders o on o.id = p.order_id where o.shop_id = $1 and o.external_order_id = $2`,
        [shopId, externalOrderId],
      )
    ).rows.map((r) => r.status);
  /** Đơn kéo bằng adapter cũ: món `confirmed` chưa có ánh xạ nên `status` null. */
  const unmapped = (id: string, updatedAt: Date) => {
    const o = remoteOrder(id, sku, null, updatedAt);
    o.rawStatus = 'confirmed';
    o.lines[0]!.rawStatus = 'confirmed';
    return o;
  };

  it('AC-6: mọi đơn có món status null (kể cả đơn đã hoàn tất) đặt epoch, xoá mốc gian hàng; lượt sau gọi lại đúng các đơn đó', async () => {
    const q1 = unmapped('Q1', at('2026-11-04T01:00:00Z'));
    const q2 = remoteOrder('Q2', sku, 'delivered', at('2026-11-04T02:00:00Z'));
    const q3 = unmapped('Q3', at('2026-11-04T03:00:00Z'));
    seed(q1, q2, q3);
    expect((await pull()).body).toEqual({ pulled: 3, created: 3, updated: 0 });
    expect(await packagesOf('Q1')).toEqual([]);
    // Q3 đã hoàn tất: migration không lọc trạng thái đơn (câu chốt 5 của #358).
    await testPool().query(`update "order".orders set status = 'completed', outcome = 'none' where shop_id = $1 and external_order_id = 'Q3'`, [shopId]);

    await runRepullMigration(MIGRATION);

    expect(await cursor()).toBeNull();
    expect(await rawTimes(['Q1', 'Q2', 'Q3'])).toEqual([
      { id: 'Q1', epoch: true },
      { id: 'Q2', epoch: false },
      { id: 'Q3', epoch: true },
    ]);

    // Adapter mới: `confirmed` → `delivered`; sàn không đổi `updated_at`.
    getOrder.mockClear();
    const known = (o: RemoteOrder): RemoteOrder => ({ ...o, lines: o.lines.map((l) => ({ ...l, status: 'delivered' })) });
    details.set('Q1', known(q1));
    details.set('Q3', known(q3));
    expect((await pull()).status).toBe(200);
    expect(getOrder.mock.calls.map((c) => c[1])).toEqual(['Q1', 'Q3']);
    expect(await packagesOf('Q1')).toEqual(['delivered']);
    const q3Order = await testPool().query(
      `select status, needs_attention, attention_note from "order".orders where shop_id = $1 and external_order_id = 'Q3'`,
      [shopId],
    );
    // Đơn đã hoàn tất vẫn được kéo lại để gỡ cờ "chưa biết": lý do migration không lọc trạng thái đơn.
    expect(q3Order.rows[0]).toEqual({ status: 'completed', needs_attention: false, attention_note: null });
    const synced = await cursor();
    expect(synced).toEqual(at('2026-11-04T03:00:00Z'));

    // Chạy lại (bước bắt buộc sau rollout): mọi món null đã có ánh xạ thì không chọn đơn nào, mốc giữ nguyên.
    await runRepullMigration(MIGRATION);
    expect(await cursor()).toEqual(synced);
    expect(await rawTimes(['Q1', 'Q3'])).toEqual([
      { id: 'Q1', epoch: false },
      { id: 'Q3', epoch: false },
    ]);
  });

  it('AC-6: món mã lạ thật còn null thì chạy lại chọn lại đơn đó và xoá mốc gian hàng (vô hại, ghi ở PR)', async () => {
    const odd = remoteOrder('Q4', sku, null, at('2026-11-04T04:00:00Z'));
    odd.lines[0]!.rawStatus = 'something_new';
    seed(odd);
    expect((await pull()).status).toBe(200);
    expect(await cursor()).not.toBeNull();

    await runRepullMigration(MIGRATION);

    expect(await cursor()).toBeNull();
    expect(await rawTimes(['Q4'])).toEqual([{ id: 'Q4', epoch: true }]);
  });
});

describe('đơn trước mốc đã có, giữ hàng và việc chưa làm trên kiện (#198)', () => {
  afterAll(() => setStockPort());
  const pkgOf = async (externalOrderId: string) =>
    (
      await testPool().query(
        `select p.status, p.notices from "order".packages p join "order".orders o on o.id = p.order_id
          where o.shop_id = $1 and o.external_order_id = $2`,
        [shopId, externalOrderId],
      )
    ).rows;

  it('AC-15: đơn đặt trước mốc mà đã có trong raw_orders thì vẫn nhận cập nhật', async () => {
    // Lần đầu đơn về qua lượt khác (vd lượt kéo đơn còn mở) — dựng bằng ref có ngày đặt sau mốc.
    const first = remoteOrder('B1', sku, 'pending', at('2026-11-01T01:00:00Z'));
    seed(first);
    expect((await pull()).body).toMatchObject({ created: 1 });
    refs = [];
    const later = remoteOrder('B1', sku, 'packed', at('2026-11-01T02:00:00Z'));
    later.placedAt = at('2026-10-01T00:00:00Z');
    seed(later);
    expect((await pull()).body).toEqual({ pulled: 1, created: 0, updated: 1 });
    expect(await pkgOf('B1')).toMatchObject([{ status: 'packed' }]);
  });

  it('D22: đơn đặt trước mốc mà migration huỷ dòng đặt lại mốc đơn vẫn được kéo lại (spec 205 §5.10)', async () => {
    // Đơn về qua lượt kéo đơn còn mở (dựng bằng ngày đặt sau mốc), sàn không đổi gì sau đó.
    const first = remoteOrder('H1', sku, 'pending', at('2026-11-03T01:00:00Z'));
    seed(first);
    expect((await pull()).body).toMatchObject({ created: 1 });
    refs = [];
    // Áp đúng giá trị migration `*_huy-dong-du-lieu` ghi vào `external_update_time`, riêng cho đơn này.
    const dir = join(process.cwd(), 'db', 'migrations');
    const file = readdirSync(dir).find((f) => f.endsWith('_huy-dong-du-lieu.sql'))!;
    const reset = /UPDATE channel\.raw_orders r SET external_update_time = ([^\n]+)\n/.exec(readFileSync(join(dir, file), 'utf8'))![1]!;
    await testPool().query(`update channel.raw_orders set external_update_time = ${reset} where shop_id = $1 and external_order_id = 'H1'`, [shopId]);

    seed({ ...first, placedAt: at('2026-10-01T00:00:00Z') });

    expect((await pull()).body).toEqual({ pulled: 1, created: 0, updated: 0 });
  });

  it('cổng tồn mặc định là reserve thật (#206): SKU chưa có tồn thì kiện backordered, notices rỗng', async () => {
    setStockPort();
    seed(remoteOrder('N0', sku, 'pending', at('2026-11-02T00:30:00Z')));
    expect((await pull()).status).toBe(200);
    expect(await pkgOf('N0')).toEqual([{ status: 'backordered', notices: [] }]);
  });

  it('AC-21: cổng tồn ném 501 not_implemented: đơn, kiện vẫn lưu; kiện backordered mang notices; đọc lại qua API', async () => {
    setStockPort({
      reserve: () => Promise.reject(notImplemented('reserve', 'commerio-backend#000', 'Người làm')),
      release: async () => {},
    });
    seed(remoteOrder('N1', sku, 'pending', at('2026-11-02T01:00:00Z')));
    expect((await pull()).status).toBe(200);
    const notice = { code: 'not_implemented', issue: 'commerio-backend#000', owner: 'Người làm', message: 'Chưa giữ hàng được cho kiện này' };
    expect(await pkgOf('N1')).toEqual([{ status: 'backordered', notices: [notice] }]);
    const { rows } = await testPool().query(`select id from "order".orders where shop_id = $1 and external_order_id = 'N1'`, [shopId]);
    const order = await auth(app().get(`/api/v1/sales/orders/${rows[0].id}`));
    expect(order.status).toBe(200);
    expect(order.body.packages[0].notices).toEqual([notice]);
  });

  it('AC-10: gian hàng không chờ kiểm kê gọi reserve; chờ kiểm kê thì không gọi, kiện backordered, notices rỗng', async () => {
    const reserve = vi.fn(async () => ({ reserved: true }));
    setStockPort({ reserve, release: async () => {} });
    seed(remoteOrder('R1', sku, 'pending', at('2026-11-03T01:00:00Z')));
    await pull();
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(await pkgOf('R1')).toEqual([{ status: 'reserved', notices: [] }]);

    await testPool().query(
      `update channel.shops set opening_stocktake_id = $2, opening_stocktake_number = 'KK-000009' where id = $1`,
      [shopId, randomUUID()],
    );
    try {
      reserve.mockClear();
      refs = [];
      seed(remoteOrder('R2', sku, 'pending', at('2026-11-03T02:00:00Z')));
      await pull();
      expect(reserve).not.toHaveBeenCalled();
      expect(await pkgOf('R2')).toEqual([{ status: 'backordered', notices: [] }]);
    } finally {
      await testPool().query(`update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null where id = $1`, [shopId]);
    }
  });
});

describe('kéo đơn theo lô khi sàn có getOrders (#267)', () => {
  it('mỗi trang gọi getOrders một lần với các đơn cần lấy, không gọi getOrder; đơn lưu như gọi từng đơn', async () => {
    const res = await auth(app().post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: `tok-${randomUUID().slice(0, 12)}` });
    const batchShop = res.body.shop.id as string;
    await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = $2 where id = $1`, [batchShop, cutoff]);
    const old = remoteOrder('B0', sku, 'pending', at('2026-11-01T00:30:00Z'));
    old.placedAt = at('2026-10-01T00:00:00Z');
    seed(
      remoteOrder('B1', sku, 'pending', at('2026-11-01T01:00:00Z')),
      old,
      remoteOrder('B2', sku, 'packed', at('2026-11-01T02:00:00Z')),
      remoteOrder('B3', sku, 'pending', at('2026-11-01T03:00:00Z')),
    );
    const pulled = await auth(app().post(`/api/v1/channel/shops/${batchShop}/orders/pull`));
    expect(pulled.body).toEqual({ pulled: 3, created: 3, updated: 0 });
    // Trang 2 đơn: [B1, B0] chỉ lấy B1 (B0 đặt trước mốc), [B2, B3] lấy cả hai.
    expect(getOrders.mock.calls.map((c) => c[1].map((r) => r.externalOrderId))).toEqual([['B1'], ['B2', 'B3']]);
    expect(getOrder).not.toHaveBeenCalled();
    const { rows } = await testPool().query(
      `select o.external_order_id, r.external_status from "order".orders o join channel.raw_orders r on r.order_id = o.id
        where o.shop_id = $1 order by 1`,
      [batchShop],
    );
    expect(rows).toEqual([
      { external_order_id: 'B1', external_status: 'pending' },
      { external_order_id: 'B2', external_status: 'packed' },
      { external_order_id: 'B3', external_status: 'pending' },
    ]);
  });
});

describe('hành trình kiện (#199 phần c)', () => {
  const id = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
  const packageOf = async (externalOrderId: string) =>
    (
      await testPool().query<{ status: string; delivered_at: Date | null }>(
        `select p.status, p.delivered_at from "order".packages p join "order".orders o on o.id = p.order_id
          where o.shop_id = $1 and o.external_order_id = $2`,
        [shopId, externalOrderId],
      )
    ).rows[0]!;

  it('AC16: chỉ gọi hành trình cho đơn có món sau bàn giao; đơn pending không gọi', async () => {
    const pending = remoteOrder(id('H1'), sku, 'pending', at('2026-11-02T01:00:00Z'));
    const moving = remoteOrder(id('H2'), sku, 'in_transit', at('2026-11-02T02:00:00Z'));
    const failedDelivery = remoteOrder(id('H3'), sku, 'cancelled', at('2026-11-02T03:00:00Z'));
    failedDelivery.lines[0]!.info = { ...noLineInfo, cancelKind: 'failed_delivery' };
    const cancelled = remoteOrder(id('H4'), sku, 'cancelled', at('2026-11-02T04:00:00Z'));
    cancelled.lines[0]!.info = { ...noLineInfo, cancelKind: 'cancellation' };
    seed(pending, moving, failedDelivery, cancelled);

    expect((await pull()).status).toBe(200);

    expect(getPackageEvents.mock.calls.map((c) => c[1]).sort()).toEqual([moving.externalOrderId, failedDelivery.externalOrderId].sort());
  });

  it('AC16: hành trình lỗi thì đơn vẫn ingest, kiện dùng giờ đồng bộ', async () => {
    const o = remoteOrder(id('H5'), sku, 'delivered', at('2026-11-02T05:00:00Z'));
    seed(o);
    getPackageEvents.mockRejectedValueOnce(new MarketplaceError('unavailable', '901'));
    const warn = vi.spyOn(logger, 'warn');
    try {
      const before = Date.now();
      const res = await pull();
      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      const pkg = await packageOf(o.externalOrderId);
      expect(pkg.status).toBe('delivered');
      expect(pkg.delivered_at!.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ shopId, externalOrderId: o.externalOrderId, err: expect.any(Error) }),
        'đọc hành trình kiện lỗi',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('AC16: mốc giao của kiện lấy từ hành trình', async () => {
    const o = remoteOrder(id('H6'), sku, 'delivered', at('2026-11-02T06:00:00Z'));
    seed(o);
    const T = at('2026-10-26T09:00:00Z');
    traces.set(o.externalOrderId, [
      { packageCode: `FP-${o.externalOrderId}`, trackingCode: null, status: 'in_transit', at: at('2026-10-26T01:00:00Z'), description: null },
      { packageCode: `FP-${o.externalOrderId}`, trackingCode: null, status: 'delivered', at: T, description: 'Giao thành công' },
    ]);

    expect((await pull()).status).toBe(200);

    expect(await packageOf(o.externalOrderId)).toMatchObject({ status: 'delivered', delivered_at: T });
  });
});

describe('ghép "không quản tồn" khi kéo đơn (spec 237)', () => {
  const id = (p: string) => `${p}-${randomUUID().slice(0, 8)}`;
  const linesOfOrder = async (externalOrderId: string) =>
    (
      await testPool().query(
        `select l.variant_id, l.stock_untracked from "order".order_lines l join "order".orders o on o.id = l.order_id
          where o.shop_id = $1 and o.external_order_id = $2`,
        [shopId, externalOrderId],
      )
    ).rows;
  const flagsOf = async (externalOrderId: string) =>
    (
      await testPool().query<{ flags: string[] }>(
        `select m.payload->'flags' as flags from core.outbox_messages m join "order".orders o on o.id::text = m.payload->>'orderId'
          where o.shop_id = $1 and o.external_order_id = $2 and m.type = 'sales.order_status_changed' order by m.id`,
        [shopId, externalOrderId],
      )
    ).rows.map((r) => r.flags);
  async function unmanagedListing(sellerSku: string, approved: boolean) {
    const ceo = (await testPool().query<{ id: string }>('select id from core.accounts where email = $1', [company.ceo.email])).rows[0]!.id;
    await testPool().query(
      approved
        ? `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id, mode, approved_by)
           values ($1, $2, null, $3, 'live', $4, 'unmanaged', $5)`
        : `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id, mode,
             pending_mode, pending_requested_by, pending_requested_at)
           values ($1, $2, null, $3, 'live', $4, 'unmanaged', 'unmanaged', $5, now())`,
      [company.companyId, shopId, sellerSku, `sku-${randomUUID().slice(0, 8)}`, ceo],
    );
  }

  it('D2-G07 AC12: SKU sàn chỉ có ghép chờ "không quản tồn" chưa duyệt → dòng chưa ghép, đơn mang cờ unmapped_sku', async () => {
    const sellerSku = id('CHO-DUYET');
    await unmanagedListing(sellerSku, false);
    const o = remoteOrder(id('U1'), sellerSku, 'pending', at('2026-11-03T01:00:00Z'));
    seed(o);

    expect((await pull()).status).toBe(200);

    expect(await linesOfOrder(o.externalOrderId)).toEqual([{ variant_id: null, stock_untracked: false }]);
    expect(await flagsOf(o.externalOrderId)).toEqual([['unmapped_sku']]);
  });

  it('D2-G07 AC11: listing "không quản tồn" đã duyệt → dòng stock_untracked, đơn không cờ unmapped_sku', async () => {
    const sellerSku = id('DA-DUYET');
    await unmanagedListing(sellerSku, true);
    const o = remoteOrder(id('U2'), sellerSku, 'pending', at('2026-11-03T02:00:00Z'));
    seed(o);

    expect((await pull()).status).toBe(200);

    expect(await linesOfOrder(o.externalOrderId)).toEqual([{ variant_id: null, stock_untracked: true }]);
    expect(await flagsOf(o.externalOrderId)).toEqual([[]]);
  });
});

describe('món mang trạng thái app chưa biết (#358 Việc 2)', () => {
  it('AC-4: log warn một lần mỗi đơn kèm gian hàng, mã đơn, mã thô; đơn bật Cần xử lý', async () => {
    const odd = remoteOrder('U1', sku, null, at('2026-11-05T01:00:00Z'));
    odd.rawStatus = 'something_new,delivered';
    odd.lines = [
      { ...odd.lines[0]!, rawStatus: 'something_new' },
      { ...odd.lines[0]!, externalLineId: 'U1-2', rawStatus: 'something_new' },
      { ...odd.lines[0]!, externalLineId: 'U1-3', rawStatus: 'delivered', status: 'delivered' },
    ];
    const known = remoteOrder('U2', sku, 'pending', at('2026-11-05T02:00:00Z'));
    seed(odd, known);
    const warn = vi.spyOn(logger, 'warn');
    try {
      expect((await pull()).status).toBe(200);
      const calls = warn.mock.calls.filter((c) => c[1] === 'sàn trả trạng thái món app chưa biết');
      expect(calls).toEqual([[{ shopId, externalOrderId: 'U1', rawStatuses: ['something_new'] }, 'sàn trả trạng thái món app chưa biết']]);
    } finally {
      warn.mockRestore();
    }
    const flag = await testPool().query(
      `select external_order_id as id, needs_attention from "order".orders where shop_id = $1 and external_order_id in ('U1', 'U2') order by 1`,
      [shopId],
    );
    expect(flag.rows).toEqual([
      { id: 'U1', needs_attention: true },
      { id: 'U2', needs_attention: false },
    ]);
  });
});

describe('đơn xuất từ kho sàn app không quản (#430)', () => {
  it('adapter bỏ hết món (mọi món ở kho khác): không tạo đơn, không lưu dữ liệu gốc; đơn khác cùng trang vẫn nhận', async () => {
    const other = remoteOrder('W1', sku, 'pending', at('2026-11-06T01:00:00Z'));
    other.lines = [];
    const own = remoteOrder('W2', sku, 'pending', at('2026-11-06T02:00:00Z'));
    seed(other, own);
    expect((await pull()).status).toBe(200);
    const { rows } = await testPool().query(
      `select external_order_id as id from "order".orders where shop_id = $1 and external_order_id in ('W1', 'W2')
        union all select 'raw:' || external_order_id from channel.raw_orders where shop_id = $1 and external_order_id in ('W1', 'W2')
        order by 1`,
      [shopId],
    );
    expect(rows.map((r) => r.id).sort()).toEqual(['W2', 'raw:W2'].sort());
  });
});
