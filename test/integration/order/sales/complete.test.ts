import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { completeDueOrdersOnce, ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

let companyId: string;
const shopId = randomUUID();
const DAY = 86_400_000;
const now = new Date('2026-11-20T00:00:00Z');

beforeAll(async () => {
  ({ companyId } = await createCompany());
});

async function delivered(statuses: PlatformOrder['lines'][number]['status'][], deliveredDaysAgo: number) {
  const id = `LZ-${randomUUID().slice(0, 8)}`;
  const o: PlatformOrder = {
    shopId,
    externalOrderId: id,
    rawStatus: 'delivered',
    paid: true,
    isCod: true,
    placedAt: new Date(now.getTime() - 20 * DAY),
    shipBy: null,
    shippingAddress: null,
    shippingFee: '0',
    cancelRequested: false,
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
    })),
  };
  const { orderId } = await withCompany(companyId, () => ingestMarketplaceOrder(o));
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
    await testPool().query(
      `insert into "order".return_requests (company_id, code, order_id, source, shop_id, external_return_id, reason)
       values ($1, $2, $3, 'marketplace', $4, $5, 'Khách đổi ý')`,
      [companyId, `TR-${randomUUID().slice(0, 8)}`, withReturn, shopId, randomUUID()],
    );

    await completeDueOrdersOnce(now);

    expect(await orderOf(full)).toMatchObject({ status: 'completed', outcome: 'full', completed_at: now });
    expect((await orderOf(full)).return_window_ends_at).toEqual(new Date(now.getTime() - DAY));
    expect(await orderOf(partial)).toMatchObject({ status: 'completed', outcome: 'partial' });
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
