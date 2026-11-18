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
const now = new Date('2026-11-20T00:00:00Z');

beforeAll(async () => {
  ({ companyId } = await createCompany());
});

async function delivered(
  statuses: PlatformOrder['lines'][number]['status'][],
  deliveredDaysAgo: number,
  shop: string = shopId,
  company = () => companyId,
) {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  const o: PlatformOrder = {
    shopId: shop,
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
  const { orderId } = await withCompany(company(), () => ingestMarketplaceOrder(o));
  await testPool().query(`update "order".packages set delivered_at = $2 where order_id = $1 and delivered_at is not null`, [
    orderId,
    new Date(now.getTime() - deliveredDaysAgo * DAY),
  ]);
  return orderId;
}

const orderOf = async (id: string) =>
  (await testPool().query(`select status, outcome, completed_at, return_window_ends_at from "order".orders where id = $1`, [id])).rows[0];

describe('tự hoàn tất đơn (#105 PR 2)', () => {
  it('mọi kiện dừng, qua 7 ngày từ kiện giao cuối, không yêu cầu trả mở → completed, kết quả theo kiện', async () => {
    const full = await delivered(['delivered'], 8);
    const partial = await delivered(['delivered', 'returned'], 8);
    const tooSoon = await delivered(['delivered'], 2);
    const stillMoving = await delivered(['delivered', 'in_transit'], 8);
    const withReturn = await delivered(['delivered'], 8);
    const refundOnly = await delivered(['delivered'], 8);
    await testPool().query(
      `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, status, reason)
       values ($1, $2, $3, 'marketplace', $4, $5, 'refund_only', 'Khách giữ hàng')`,
      [companyId, `TR-${randomUUID().slice(0, 8)}`, refundOnly, shopId, randomUUID()],
    );
    await testPool().query(
      `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, reason)
       values ($1, $2, $3, 'marketplace', $4, $5, 'Khách đổi ý')`,
      [companyId, `TR-${randomUUID().slice(0, 8)}`, withReturn, shopId, randomUUID()],
    );

    await completeDueOrdersOnce(now);

    expect(await orderOf(full)).toMatchObject({ status: 'completed', outcome: 'full', completed_at: now });
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
    await completeDueOrdersOnce(now);
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

describe('hạn trả theo gian hàng (#236)', () => {
  const ctx = createModuleContext();
  let lazada15: string, lazadaNull: string, tiktok: string;

  beforeAll(async () => {
    lazada15 = await newShop(companyId, 'lazada', 15);
    lazadaNull = await newShop(companyId, 'lazada', null);
    tiktok = await newShop(companyId, 'tiktok', null);
  });

  it('AC1: gian hàng 15 ngày, giao 8 ngày trước → chưa hoàn tất', async () => {
    const id = await delivered(['delivered'], 8, lazada15);

    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('processing');
  });

  it('AC2 (D1-03): gian hàng 15 ngày, giao 16 ngày trước → completed, hạn = mốc giao + 15 ngày', async () => {
    const id = await delivered(['delivered'], 16, lazada15);

    await completeDueOrdersOnce(now, ctx);

    expect(await orderOf(id)).toMatchObject({ status: 'completed', outcome: 'full' });
    expect((await orderOf(id)).return_window_ends_at).toEqual(new Date(now.getTime() - 16 * DAY + 15 * DAY));
  });

  it('AC3: gian hàng chưa nhập số ngày, giao 8 ngày trước → completed (7 ngày)', async () => {
    const id = await delivered(['delivered'], 8, lazadaNull);

    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC4: đơn của gian hàng không tìm thấy → 7 ngày', async () => {
    const id = await delivered(['delivered'], 8, randomUUID());

    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC5: Admin giảm số ngày 15 → 5 thì lượt sau hoàn tất', async () => {
    const shop = await newShop(companyId, 'lazada', 15);
    const id = await delivered(['delivered'], 8, shop);
    await completeDueOrdersOnce(now, ctx);
    expect((await orderOf(id)).status).toBe('processing');

    await testPool().query('update channel.shops set return_window_days = 5 where id = $1', [shop]);
    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC6 (US-DH-16 1b): mọi kiện không huỷ đã hoàn về → completed ngay, kết quả none, không hạn trả', async () => {
    const id = await delivered(['returned'], 0, lazada15);

    await completeDueOrdersOnce(now, ctx);

    expect(await orderOf(id)).toMatchObject({ status: 'completed', outcome: 'none', return_window_ends_at: null });
  });

  it('AC8: kiện tự giao thu COD chưa xác nhận chặn; xác nhận (người khác người giao) thì lượt sau hoàn tất', async () => {
    const id = await delivered(['delivered'], 8, lazadaNull);
    await testPool().query(
      `update "order".packages set self_delivery = true, cod_expected = 100000, delivered_by = $2 where order_id = $1`,
      [id, randomUUID()],
    );
    await completeDueOrdersOnce(now, ctx);
    expect((await orderOf(id)).status).toBe('processing');

    await testPool().query(`update "order".packages set cod_confirmed_by = $2, cod_confirmed_at = now() where order_id = $1`, [
      id,
      randomUUID(),
    ]);
    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC9: kiện tự giao không thu COD (0) → không chặn', async () => {
    const id = await delivered(['delivered'], 8, lazadaNull);
    await testPool().query(`update "order".packages set self_delivery = true, cod_expected = 0 where order_id = $1`, [id]);

    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC11a: gian hàng TikTok, giao 8 ngày trước → completed (PR 1 tạm 7 ngày, D13)', async () => {
    const id = await delivered(['delivered'], 8, tiktok);

    await completeDueOrdersOnce(now, ctx);

    expect((await orderOf(id)).status).toBe('completed');
  });

  it('AC11b: đơn không cờ Đang huỷ, mọi kiện huỷ → giữ hành vi hiện tại (completed, none; D16, PR 3 đổi)', async () => {
    const id = await delivered(['delivered'], 8, lazadaNull);
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query(`update "order".packages set status = 'cancelled', delivered_at = null where order_id = $1`, [id]);
      await client.query(`update "order".order_lines set cancelled_qty = quantity where order_id = $1`, [id]);
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }

    await completeDueOrdersOnce(now, ctx);

    expect(await orderOf(id)).toMatchObject({ status: 'completed', outcome: 'none' });
  });

  it('AC11: ba đơn ở hai gian hàng cùng công ty → đọc chính sách một lần cho công ty', async () => {
    await delivered(['delivered'], 8, lazada15);
    await delivered(['delivered'], 8, lazada15);
    await delivered(['delivered'], 8, lazadaNull);
    const spy = { returnPoliciesOf: vi.fn((ids: readonly string[]) => ctx.returnPoliciesOf(ids)) };

    await completeDueOrdersOnce(now, spy);

    const ours = spy.returnPoliciesOf.mock.calls.filter(([ids]) => ids.includes(lazada15) || ids.includes(lazadaNull));
    expect(ours).toHaveLength(1);
    expect(ours[0]![0]).toEqual(expect.arrayContaining([lazada15, lazadaNull]));
  });

  it('lật trang: trang cỡ 1 vẫn hoàn tất mọi đơn tới hạn trong một lượt', async () => {
    const ids = [
      await delivered(['delivered'], 8, lazadaNull),
      await delivered(['delivered'], 8, lazadaNull),
      await delivered(['delivered'], 8, lazadaNull),
    ];

    await completeDueOrdersOnce(now, ctx, 1);

    for (const id of ids) expect((await orderOf(id)).status).toBe('completed');
  });

  it('đọc hạn trả của một công ty lỗi → đơn công ty đó không hoàn tất, công ty khác vẫn chạy', async () => {
    const other = await createCompany();
    const mine = await delivered(['delivered'], 16, lazada15);
    const theirs = await delivered(['delivered'], 8, randomUUID(), () => other.companyId);
    const failing = {
      returnPoliciesOf: vi.fn(async (ids: readonly string[]) => {
        if (ids.includes(lazada15)) throw new Error('DB lỗi giữa chừng');
        return ctx.returnPoliciesOf(ids);
      }),
    };

    await completeDueOrdersOnce(now, failing);

    expect((await orderOf(mine)).status).toBe('processing');
    expect((await orderOf(theirs)).status).toBe('completed');
  });

  it('đơn không có gian hàng (đơn tay) → 7 ngày, không gọi channel với null', async () => {
    const { variantId } = await createVariant(companyId);
    const { orderId } = await seedPackage(companyId, {
      status: 'delivered',
      deliveredAt: new Date(now.getTime() - 8 * DAY),
      manual: true,
      orderStatus: 'processing',
      lines: [{ variantId, quantity: 1 }],
    });
    const spy = { returnPoliciesOf: vi.fn((ids: readonly string[]) => ctx.returnPoliciesOf(ids)) };

    await completeDueOrdersOnce(now, spy);

    expect((await orderOf(orderId)).status).toBe('completed');
    for (const [ids] of spy.returnPoliciesOf.mock.calls) expect(ids).not.toContain(null);
  });
});
