import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { completeDueOrdersOnce, hasOpenReturns, ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { seedPackage } from '../fulfillment/helpers.ts';
import { noLineInfo, noOrderInfo, noShipping } from './helpers.ts';

let companyId: string;
const shopId = randomUUID();
const DAY = 86_400_000;
// Việc hoàn tất quét mọi công ty, và file khác (`lost.test.ts`, `cancelling-handed-over.test.ts`, `orders-api.test.ts`)
// chạy nó theo giờ thật trên cùng DB, song song với file này. Mốc giao tính lùi từ giờ thật, nên:
// - đơn phải còn chờ cách hạn trả ít nhất vài ngày, hay có điều kiện chặn ghi trước khi lùi mốc giao (`prepare`): lượt
//   của file khác chen vào lúc nào cũng không chốt được;
// - đơn phải hoàn tất có thể do lượt của file khác (cùng luật, ctx thật) chốt trước: chỉ kiểm điều mọi lượt ghi như
//   nhau (trạng thái, kết quả, hạn trả); `completed_at` kiểm ở ca lật trang, nơi chỉ lượt của ca chốt được.
const now = new Date();

beforeAll(async () => {
  ({ companyId } = await createCompany());
});

/**
 * Đơn sàn mọi món ở `statuses`, kiện đã giao lùi về `deliveredDaysAgo` ngày trước `now`. `prepare` chạy trước khi lùi
 * mốc giao (lúc kiện vừa giao, chưa qua hạn trả): ghi điều kiện chặn ở đó thì lượt của file khác không chốt kịp đơn.
 */
async function delivered(
  statuses: PlatformOrder['lines'][number]['status'][],
  deliveredDaysAgo: number,
  opts: { shop?: string; company?: string; prepare?: (orderId: string) => Promise<unknown> } = {},
) {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  const o: PlatformOrder = {
    shopId: opts.shop ?? shopId,
    externalOrderId: id,
    rawStatus: 'delivered',
    paid: true,
    isCod: true,
    placedAt: new Date(now.getTime() - 20 * DAY),
    // Đơn đặt trước mốc kéo đơn: kiện lần đầu thấy sàn báo đã hoàn về vào thẳng `returned` (spec 199c D9); sau mốc thì
    // kiện ở `returning` chờ kho quét (D1), chưa dừng.
    orderCutoffAt: new Date(now.getTime() - 10 * DAY),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
    info: noOrderInfo,
    lines: statuses.map((status, i) => ({
      externalLineId: `${id}-${i}`,
      variantId: null,
      sellerSku: 'SKU',
      productName: 'Áo',
      unitPrice: '100000',
      sellerDiscount: '0',
      platformDiscount: '0',
      packageCode: `FP-${id}-${i}`,
      trackingCode: null,
      rawStatus: String(status),
      status,
      info: noLineInfo,
      shipping: noShipping,
    })),
  };
  const { orderId } = await withCompany(opts.company ?? companyId, () => ingestMarketplaceOrder(o));
  await opts.prepare?.(orderId);
  await testPool().query(`update "order".packages set delivered_at = $2 where order_id = $1 and delivered_at is not null`, [
    orderId,
    new Date(now.getTime() - deliveredDaysAgo * DAY),
  ]);
  return orderId;
}

const orderOf = async (id: string) =>
  (await testPool().query(`select status, outcome, completed_at, return_window_ends_at from "order".orders where id = $1`, [id])).rows[0];

/** Yêu cầu trả từ sàn của đơn (`requested` là còn mở, `refund_only` không chặn hoàn tất). */
const returnRequest = (orderId: string, shop: string, status: 'requested' | 'refund_only') =>
  testPool().query(
    `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, status, reason)
     values ($1, $2, $3, 'marketplace', $4, $5, $6, 'Khách đổi ý')`,
    [companyId, `TR-${randomUUID().slice(0, 8)}`, orderId, shop, randomUUID(), status],
  );

describe('tự hoàn tất đơn (#105 PR 2)', () => {
  it('mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không yêu cầu trả mở → completed, kết quả theo kiện', async () => {
    const full = await delivered(['delivered'], 8);
    const partial = await delivered(['delivered', 'returned'], 8);
    const tooSoon = await delivered(['delivered'], 2);
    const stillMoving = await delivered(['delivered', 'in_transit'], 8);
    const withReturn = await delivered(['delivered'], 8, { prepare: (id) => returnRequest(id, shopId, 'requested') });
    const refundOnly = await delivered(['delivered'], 8, { prepare: (id) => returnRequest(id, shopId, 'refund_only') });

    await completeDueOrdersOnce(now, createModuleContext());

    expect(await orderOf(full)).toMatchObject({ status: 'completed', outcome: 'full' });
    expect((await orderOf(full)).completed_at).toBeInstanceOf(Date);
    expect((await orderOf(full)).return_window_ends_at).toEqual(new Date(now.getTime() - DAY));
    expect(await orderOf(partial)).toMatchObject({ status: 'completed', outcome: 'partial' });
    // Đơn có `refund_only` vẫn hoàn tất được (DoD #202).
    expect(await orderOf(refundOnly)).toMatchObject({ status: 'completed', outcome: 'full' });
    const open = (id: string) => withCompany(companyId, () => hasOpenReturns(id));
    expect([await open(withReturn), await open(refundOnly)]).toEqual([true, false]);
    for (const id of [tooSoon, stillMoving, withReturn]) expect((await orderOf(id)).status).toBe('processing');

    const history = await testPool().query(
      `select from_state, to_state, action, source, actor_id from core.state_transitions where entity_id = $1 order by id desc limit 1`,
      [full],
    );
    expect(history.rows[0]).toEqual({ from_state: 'processing', to_state: 'completed', action: 'complete', source: 'system', actor_id: null });
    const event = await testPool().query(
      `select payload from core.outbox_messages where type = 'sales.order_status_changed' and payload->>'orderId' = $1 order by id desc limit 1`,
      [full],
    );
    expect(event.rows[0].payload).toMatchObject({ from: 'processing', to: 'completed' });

    // Chạy lại không làm gì thêm.
    await completeDueOrdersOnce(now, createModuleContext());
    const count = await testPool().query(`select count(*)::int as n from core.state_transitions where entity_id = $1 and action = 'complete'`, [full]);
    expect(count.rows[0].n).toBe(1);
  });
});

async function newShop(company: string, platform: string, days: number | null): Promise<string> {
  const r = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name, return_window_days)
     values ($1, $2, $3, 'Shop thử', $4) returning id`,
    [company, platform, randomUUID(), days],
  );
  return r.rows[0]!.id;
}

// Dựng mọi đơn trước rồi chạy ít lượt, mỗi `it` chỉ kiểm kết quả, để không tải DB của file khác (việc hoàn tất quét mọi
// công ty).
describe('hạn trả theo gian hàng (#236)', () => {
  const ctx = createModuleContext();
  const spy = { returnPoliciesOf: vi.fn((ids: readonly string[]) => ctx.returnPoliciesOf(ids)) };
  let lazada15: string, lazadaNull: string, tiktok: string, shopLowered: string;
  const id: Record<string, string> = {};
  const before: Record<string, string> = {};
  let manualOrder: string;
  let tiktokEndedAt: Date;
  const calls: string[][] = [];

  beforeAll(async () => {
    lazada15 = await newShop(companyId, 'lazada', 15);
    lazadaNull = await newShop(companyId, 'lazada', null);
    tiktok = await newShop(companyId, 'tiktok', null);
    shopLowered = await newShop(companyId, 'lazada', 15);
    id.ac1 = await delivered(['delivered'], 8, { shop: lazada15 });
    id.ac2 = await delivered(['delivered'], 16, { shop: lazada15 });
    id.ac3 = await delivered(['delivered'], 8, { shop: lazadaNull });
    id.ac4 = await delivered(['delivered'], 8, { shop: randomUUID() });
    id.ac5 = await delivered(['delivered'], 8, { shop: shopLowered });
    id.ac6 = await delivered(['returned'], 0, { shop: lazada15 });
    id.ac8 = await delivered(['delivered'], 8, {
      shop: lazadaNull,
      prepare: (orderId) =>
        testPool().query(`update "order".packages set self_delivery = true, cod_expected = 100000, delivered_by = $2 where order_id = $1`, [
          orderId,
          randomUUID(),
        ]),
    });
    id.ac9 = await delivered(['delivered'], 8, { shop: lazadaNull });
    await testPool().query(`update "order".packages set self_delivery = true, cod_expected = 0 where order_id = $1`, [id.ac9]);
    id.ac12a = await delivered(['delivered'], 8, { shop: tiktok });
    // AC11 cần đơn TikTok trong lô của lượt đầu: đơn này còn chờ dù luật TikTok có đổi.
    id.tiktokWaiting = await delivered(['delivered'], 2, { shop: tiktok });
    id.ac16 = await delivered(['returned'], 0, { shop: tiktok });
    // Sàn đã báo hết quyền trả hôm qua: ghi mốc trước khi lùi mốc giao (đơn chưa lúc nào tới hạn mà chưa có mốc).
    tiktokEndedAt = new Date(now.getTime() - DAY);
    id.ac14 = await delivered(['delivered'], 30, {
      shop: tiktok,
      prepare: (orderId) =>
        testPool().query('update "order".orders set return_window_ends_at = $2 where id = $1', [orderId, tiktokEndedAt]),
    });
    // Huỷ kiện và dòng đơn trước khi lùi mốc giao (đơn chưa lúc nào tới hạn với kiện còn giao). Trigger kiểm bằng dòng
    // kiện chạy lúc commit (db/CLAUDE.md): huỷ kiện và dòng đơn trong một giao dịch.
    id.ac11b = await delivered(['delivered'], 8, {
      shop: lazadaNull,
      prepare: async (orderId) => {
        const client = await testPool().connect();
        try {
          await client.query('begin');
          await client.query(`update "order".packages set status = 'cancelled', delivered_at = null where order_id = $1`, [orderId]);
          await client.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [orderId]);
          await client.query('commit');
        } catch (err) {
          await client.query('rollback');
          throw err;
        } finally {
          client.release();
        }
      },
    });
    const { variantId } = await createVariant(companyId);
    ({ orderId: manualOrder } = await seedPackage(companyId, {
      status: 'delivered',
      deliveredAt: new Date(now.getTime() - 8 * DAY),
      manual: true,
      orderStatus: 'processing',
      lines: [{ variantId, quantity: 1 }],
    }));

    // Một trang cho cả DB test (AC11): trang mặc định 500 thì DB đông có thể tách đơn công ty này ra hai trang.
    await completeDueOrdersOnce(now, spy, 1_000_000);
    // Chép lời gọi của lượt đầu ngay sau lượt (trạng thái mock không giữ qua hook sang test).
    calls.push(...spy.returnPoliciesOf.mock.calls.map(([ids]) => [...ids]));
    for (const k of ['ac5', 'ac8']) before[k] = (await orderOf(id[k]!)).status;

    // Lượt sau: Admin giảm số ngày 15 → 5; kế toán (người khác người giao) xác nhận COD.
    await testPool().query('update channel.shops set return_window_days = 5 where id = $1', [shopLowered]);
    await testPool().query(`update "order".packages set cod_confirmed_by = $2, cod_confirmed_at = now() where order_id = $1`, [
      id.ac8,
      randomUUID(),
    ]);
    await completeDueOrdersOnce(now, ctx);
  });

  it('AC1: gian hàng 15 ngày, giao 8 ngày trước → chưa hoàn tất', async () => {
    expect((await orderOf(id.ac1!)).status).toBe('processing');
  });

  it('AC2 (D1-03): gian hàng 15 ngày, giao 16 ngày trước → completed, hạn = mốc giao + 15 ngày', async () => {
    expect(await orderOf(id.ac2!)).toMatchObject({ status: 'completed', outcome: 'full' });
    expect((await orderOf(id.ac2!)).return_window_ends_at).toEqual(new Date(now.getTime() - 16 * DAY + 15 * DAY));
  });

  it('AC3: gian hàng chưa nhập số ngày, giao 8 ngày trước → completed (7 ngày)', async () => {
    expect((await orderOf(id.ac3!)).status).toBe('completed');
  });

  it('AC4: đơn của gian hàng không tìm thấy → 7 ngày', async () => {
    expect((await orderOf(id.ac4!)).status).toBe('completed');
  });

  it('AC5: Admin giảm số ngày 15 → 5 thì lượt sau hoàn tất', async () => {
    expect(before.ac5).toBe('processing');
    expect((await orderOf(id.ac5!)).status).toBe('completed');
  });

  it('D1-R (US-DH-16 1b, AC6): mọi kiện không huỷ đã hoàn về → completed ngay, kết quả none, không hạn trả', async () => {
    expect(await orderOf(id.ac6!)).toMatchObject({ status: 'completed', outcome: 'none', return_window_ends_at: null });
  });

  it('AC8: kiện tự giao thu COD chưa xác nhận chặn; xác nhận (người khác người giao) thì lượt sau hoàn tất', async () => {
    expect(before.ac8).toBe('processing');
    expect((await orderOf(id.ac8!)).status).toBe('completed');
  });

  it('AC9: kiện tự giao không thu COD (0) → không chặn', async () => {
    expect((await orderOf(id.ac9!)).status).toBe('completed');
  });

  it('AC12a: gian hàng TikTok, giao 8 ngày trước, sàn chưa báo COMPLETED → chưa hoàn tất (D8)', async () => {
    expect((await orderOf(id.ac12a!)).status).toBe('processing');
  });

  it('AC14 (luật job): gian hàng TikTok, sàn đã báo (cột có mốc) → completed, hạn = mốc sàn báo', async () => {
    expect(await orderOf(id.ac14!)).toMatchObject({ status: 'completed', outcome: 'full', return_window_ends_at: tiktokEndedAt });
  });

  it('AC16: gian hàng TikTok, mọi kiện không huỷ đã hoàn về → completed không chờ sàn', async () => {
    expect(await orderOf(id.ac16!)).toMatchObject({ status: 'completed', outcome: 'none' });
  });

  it('AC11b: đơn không cờ Đang huỷ, mọi dòng và mọi kiện đã huỷ → cancelled, không hoàn tất (25 §8.2 "Mọi kiện đã cancelled thì đơn → cancelled")', async () => {
    expect(await orderOf(id.ac11b!)).toMatchObject({ status: 'cancelled' });
  });

  it('AC11: đơn ở nhiều gian hàng cùng công ty → một lượt đọc chính sách một lần cho công ty', () => {
    const ours = calls.filter((ids) => ids.includes(lazada15) || ids.includes(lazadaNull));
    expect(ours).toHaveLength(1);
    expect(ours[0]).toEqual(expect.arrayContaining([lazada15, lazadaNull, tiktok, shopLowered]));
  });

  it('đơn không có gian hàng (đơn tay) → 7 ngày, không gọi channel với null', async () => {
    expect((await orderOf(manualOrder)).status).toBe('completed');
    expect(calls.length).toBeGreaterThan(0);
    for (const ids of calls) expect(ids).not.toContain(null);
  });

  it('lật trang: trang cỡ 1 vẫn hoàn tất mọi đơn tới hạn trong một lượt', async () => {
    // Gian hàng 60 ngày, giao 16 ngày trước: lượt ctx thật (file khác, ca khác) không chốt được; chỉ lượt của ca này đọc
    // gian hàng thành 7 ngày. Lật trang hỏng (dừng sau trang đầu, nhảy trang) thì không đủ ba đơn.
    const shop60 = await newShop(companyId, 'lazada', 60);
    const ids = [
      await delivered(['delivered'], 16, { shop: shop60 }),
      await delivered(['delivered'], 16, { shop: shop60 }),
      await delivered(['delivered'], 16, { shop: shop60 }),
    ];
    const sevenDays = {
      returnPoliciesOf: async (shopIds: readonly string[]) => {
        const map = await ctx.returnPoliciesOf(shopIds);
        const policy = map.get(shop60);
        if (policy) map.set(shop60, { ...policy, returnWindowDays: 7 });
        return map;
      },
    };
    const at = new Date();

    await completeDueOrdersOnce(at, sevenDays, 1);

    for (const o of ids) expect(await orderOf(o)).toMatchObject({ status: 'completed', completed_at: at });
  });

  it('đọc hạn trả của một công ty lỗi → đơn công ty đó không hoàn tất (không rơi về 7 ngày), công ty khác vẫn chạy', async () => {
    const other = await createCompany();
    // Gian hàng 60 ngày, giao 16 ngày trước: rơi về 7 ngày thì hoàn tất; lượt của file khác (ctx thật) thì không.
    const shop60 = await newShop(companyId, 'lazada', 60);
    const mine = await delivered(['delivered'], 16, { shop: shop60 });
    const theirs = await delivered(['delivered'], 8, { shop: randomUUID(), company: other.companyId });
    const failing = {
      returnPoliciesOf: vi.fn(async (ids: readonly string[]) => {
        if (ids.includes(shop60)) throw new Error('DB lỗi giữa chừng');
        return ctx.returnPoliciesOf(ids);
      }),
    };

    await completeDueOrdersOnce(now, failing);

    expect((await orderOf(mine)).status).toBe('processing');
    expect((await orderOf(theirs)).status).toBe('completed');
  });
});

describe('không có hàm đọc hạn trả (#236, review)', () => {
  it('lượt chạy không có returnPoliciesOf bị từ chối, không rơi về 7 ngày', async () => {
    // Gian hàng 60 ngày: chỉ lượt rơi về 7 ngày mới hoàn tất đơn giao 16 ngày trước.
    const id = await delivered(['delivered'], 16, { shop: await newShop(companyId, 'lazada', 60) });

    await expect(completeDueOrdersOnce(now, {} as never)).rejects.toThrow(/returnPoliciesOf/);

    expect((await orderOf(id)).status).toBe('processing');
  });
});
