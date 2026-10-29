import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrderPullResult } from '#src/modules/channel/channel/api/schemas.ts';
import { MarketplaceError, type RemoteOrder, type RemoteOrderRef } from '#src/modules/channel/channel/service/marketplaces/common.ts';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany, addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { setModuleEnabled } from '../../helpers/state.ts';
import { fakeAdapter } from './helpers.ts';

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
      },
    ],
  };
}

// Sàn giả: danh sách đơn và chi tiết đổi được theo từng test.
let refs: RemoteOrderRef[] = [];
let details = new Map<string, RemoteOrder>();
let failOn: string | null = null;
const listOrders = vi.fn(async (_t: string, _after: Date, offset: number) => ({
  orders: refs.slice(offset, offset + 2),
  hasMore: offset + 2 < refs.length,
}));
const getOrder = vi.fn(async (_t: string, id: string) => {
  if (id === failOn) throw new MarketplaceError('unavailable', '901');
  return details.get(id)!;
});

registerAdapter(
  'lazada',
  fakeAdapter({
    async getSeller(accessToken) {
      return { externalShopId: accessToken.slice(4), shopName: 'Shop thử', region: 'VN' };
    },
    listOrders,
    getOrder,
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
  details = new Map();
  failOn = null;
  listOrders.mockClear();
  getOrder.mockClear();
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
      [at('2026-10-19T23:58:00Z'), 0],
      [at('2026-10-19T23:58:00Z'), 2],
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
