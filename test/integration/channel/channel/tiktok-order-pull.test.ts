// Kéo đơn (#105, #218) và lượt đơn còn mở (#198) chạy với adapter TikTok thật (#221) trên sàn giả theo đường dẫn API
// TikTok: `order-pull.ts` không rẽ nhánh theo sàn, đơn và kiện TikTok vào DB như đơn Lazada. Dạng phản hồi theo docv2
// get-order-list-202309, get-order-detail-202507 (tra 07/11/2026) và đơn gọi thật 587022741397144586 trên shop thử.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAdapter, resetAdapters } from '#src/modules/channel/channel/service/marketplaces/index.ts';
import { createTiktokAdapter } from '#src/modules/channel/channel/service/marketplaces/tiktok.ts';
import { pullOpenOrders } from '#src/modules/channel/channel/service/order-pull.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

const cutoff = new Date('2026-11-06T00:00:00Z');
const sec = (iso: string) => Date.parse(iso) / 1000;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const ok = (data: unknown) => json({ code: 0, message: 'Success', request_id: 'r', data });

type Order = Record<string, unknown> & { id: string; status: string; update_time: number };
let orders: Order[] = [];
let shopExternalId = '';

/** Đơn 2 SKU: 2 món SKU đã ghép (cùng kiện `pkgA`), 1 món SKU chưa ghép (kiện `pkgB`). */
function order(id: string, status: string, updateIso: string, sku: string, pkgA: string | null, pkgB: string | null): Order {
  const line = (n: number, seller_sku: string, pkg: string | null, price: string) => ({
    id: `${id}-${n}`,
    display_status: status === 'ON_HOLD' ? 'UNKNOWN' : status,
    package_status: pkg ? 'TO_FULFILL' : undefined,
    package_id: pkg ?? undefined,
    seller_sku,
    product_name: 'Hàng thử',
    original_price: price,
    sale_price: price,
    seller_discount: '0',
    platform_discount: '0',
  });
  return {
    id,
    status,
    create_time: sec('2026-11-06T10:00:00Z'),
    update_time: sec(updateIso),
    rts_sla_time: sec('2026-11-07T12:00:00Z'),
    payment: { shipping_fee: '300', original_shipping_fee: '300' },
    recipient_address: { name: 'N***n', phone_number: '(+84)90******12', address_detail: '1******', district_info: [{ address_level: 'L1', address_name: 'Ha Noi' }] },
    line_items: [line(1, sku, pkgA, '61000'), line(2, sku, pkgA, '61000'), line(3, 'SKU-CHUA-GHEP', pkgB, '250000')],
  };
}

const fakeTiktok = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const u = new URL(String(url));
  switch (u.pathname) {
    case '/authorization/202309/shops':
      return ok({ shops: [{ id: shopExternalId, name: 'Shop thử TikTok', region: 'VN', cipher: 'ROW_c' }] });
    case '/order/202309/orders/search': {
      const f = JSON.parse(String(init?.body ?? '{}')) as { update_time_ge?: number; order_status?: string };
      const hit = orders
        .filter((o) => o.update_time >= (f.update_time_ge ?? 0) && (!f.order_status || o.status === f.order_status))
        .sort((a, b) => a.update_time - b.update_time);
      return ok({ total_count: hit.length, next_page_token: '', orders: hit.map(({ line_items: _l, ...o }) => o) });
    }
    case '/order/202507/orders': {
      const ids = new Set((u.searchParams.get('ids') ?? '').split(','));
      return ok({ orders: orders.filter((o) => ids.has(o.id)) });
    }
    default:
      return json({ code: 36009009, message: 'Invalid path' });
  }
};

registerAdapter('tiktok', createTiktokAdapter({ appKey: 'k', appSecret: 's', serviceId: undefined, apiUrl: 'https://open.test', authUrl: 'https://auth.test' }, fakeTiktok));
afterAll(() => resetAdapters());

let company: Awaited<ReturnType<typeof createCompany>>;
let shopId: string;
let sku: string;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${company.ceo.token}`);

beforeAll(async () => {
  company = await createCompany({ optionalModules: ['channel'] });
  shopExternalId = `74950${Math.floor(Math.random() * 1e12)}`;
  const res = await auth(request(testApp()).post('/api/v1/channel/shops/tiktok/token')).send({ accessToken: `TTP_${randomUUID().slice(0, 12)}` });
  expect(res.status).toBe(201);
  shopId = res.body.shop.id;
  await testPool().query(`update channel.shops set status = 'active', order_cutoff_at = $2 where id = $1`, [shopId, cutoff]);
  let variantId: string;
  ({ sku, variantId } = await createVariant(company.companyId));
  await testPool().query(
    `insert into channel.listings (company_id, shop_id, variant_id, seller_sku, status, external_sku_id) values ($1, $2, $3, $4, 'live', $5)`,
    [company.companyId, shopId, variantId, sku, `sku-${randomUUID().slice(0, 8)}`],
  );
});

const packagesOf = async (externalOrderId: string) =>
  (
    await testPool().query(
      `select p.platform_package_code as code from "order".packages p join "order".orders o on o.id = p.order_id
        where o.shop_id = $1 and o.external_order_id = $2 order by p.platform_package_code nulls first`,
      [shopId, externalOrderId],
    )
  ).rows.map((r) => r.code as string | null);

describe('kéo đơn TikTok qua order-pull (#221)', () => {
  it('đơn ON_HOLD rồi AWAITING_SHIPMENT: về app, ghép SKU, kiện tạm nhận package_id của sàn, mốc tiến', async () => {
    orders = [order('T1', 'ON_HOLD', '2026-11-06T10:00:01Z', sku, null, null)];
    const first = await auth(request(testApp()).post(`/api/v1/channel/shops/${shopId}/orders/pull`));
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ pulled: 1, created: 1, updated: 0 });
    expect(await packagesOf('T1')).toEqual([null]);

    // Sang chờ giao: sàn tạo một kiện chung cho cả đơn (gọi thật 03/11, 07/11/2026).
    orders = [order('T1', 'AWAITING_SHIPMENT', '2026-11-06T10:05:00Z', sku, 'PK-1', 'PK-1')];
    const second = await auth(request(testApp()).post(`/api/v1/channel/shops/${shopId}/orders/pull`));
    expect(second.body).toMatchObject({ pulled: 1, created: 0 });

    const lines = await testPool().query(
      `select l.external_line_id, l.variant_id is not null as matched from "order".order_lines l join "order".orders o on o.id = l.order_id
        where o.shop_id = $1 order by l.external_line_id`,
      [shopId],
    );
    expect(lines.rows).toEqual([
      { external_line_id: 'T1-1', matched: true },
      { external_line_id: 'T1-2', matched: true },
      { external_line_id: 'T1-3', matched: false },
    ]);
    expect(await packagesOf('T1')).toEqual(['PK-1']);
    const raw = await testPool().query(`select external_status, payload->>'deliveredAt' as delivered from channel.raw_orders where shop_id = $1`, [shopId]);
    expect(raw.rows).toEqual([{ external_status: 'AWAITING_SHIPMENT', delivered: null }]);
    const shop = await testPool().query(`select last_order_sync_at from channel.shops where id = $1`, [shopId]);
    expect(shop.rows[0].last_order_sync_at).toEqual(new Date('2026-11-06T10:05:00Z'));
  });

  // Bỏ qua tới #238 (Khang, sàn chia lại kiện): hiện `syncPlatformPackages` gán mọi nhóm mã kiện mới về kiện cũ đang giữ
  // món (`owner`), không tạo kiện mới cũng không đánh dấu cần xử lý, nên kiện vẫn mang mã PK-1 đã mất trên sàn. Gọi thật
  // 07/11/2026 (đơn 587022741397144586): tách kiện làm `line_items[].package_id` đổi và `update_time` của đơn tăng.
  it.skip('sàn tách kiện theo SKU (package_id của món đổi): app theo kiện mới của sàn', async () => {
    orders = [order('T1', 'AWAITING_SHIPMENT', '2026-11-06T10:06:00Z', sku, 'PK-A', 'PK-B')];
    await auth(request(testApp()).post(`/api/v1/channel/shops/${shopId}/orders/pull`));
    expect(await packagesOf('T1')).toEqual(['PK-A', 'PK-B']);
  });

  it('lượt đơn còn mở nhận đơn đặt trước mốc đang chờ giao, bỏ đơn đã giao', async () => {
    await testPool().query(`update channel.shops set open_orders_pulled_at = null where id = $1`, [shopId]);
    const old = { ...order('T0', 'AWAITING_COLLECTION', '2026-11-05T09:00:00Z', sku, 'PK-0', 'PK-0'), create_time: sec('2026-11-05T08:00:00Z') };
    const done = { ...order('TD', 'DELIVERED', '2026-11-05T09:30:00Z', sku, 'PK-D', 'PK-D'), create_time: sec('2026-11-05T08:00:00Z') };
    orders = [old, done];
    const result = await pullOpenOrders(company.companyId, shopId);
    expect(result).toMatchObject({ pulled: 1, created: 1 });
    const got = await testPool().query(`select external_order_id from "order".orders where shop_id = $1 order by external_order_id`, [shopId]);
    expect(got.rows.map((r) => r.external_order_id)).toEqual(['T0', 'T1']);
    const shop = await testPool().query(`select open_orders_pulled_at is not null as pulled from channel.shops where id = $1`, [shopId]);
    expect(shop.rows[0].pulled).toBe(true);
  });
});
