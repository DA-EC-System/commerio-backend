// Khép đơn mọi kiện đã huỷ (#236 PR 3, spec 5.4, D3; plan P3): một hàm cho mọi nguồn đơn. Đơn sàn đi `platform_cancel`
// (sàn huỷ hết món), đơn khác đi `auto_cancel`. Việc nền của file khác có thể khép đơn trước lần gọi của ca: chỉ kiểm
// trạng thái cuối mà mọi lần khép đều ghi như nhau.
import { beforeAll, describe, expect, it } from 'vitest';
import { settleCancelledOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { outboxOf, seedPackage } from '../fulfillment/helpers.ts';

let companyId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
});

const orderOf = async (id: string) =>
  (
    await testPool().query<{ status: string; outcome: string | null; cancel_reason: string | null }>(
      'select status, outcome, cancel_reason from "order".orders where id = $1',
      [id],
    )
  ).rows[0]!;

const orderTransitions = async (id: string) =>
  (
    await testPool().query<{ action: string; from_state: string | null; to_state: string; source: string; actor_id: string | null }>(
      `select action, from_state, to_state, source, actor_id from core.state_transitions
       where entity_type = 'orders' and entity_id = $1 order by id`,
      [id],
    )
  ).rows;

/** Đơn `processing` có một kiện đã huỷ, dòng đã huỷ đủ (`seedPackage` ghi `cancelled_qty`). */
async function allCancelledOrder(manual: boolean) {
  const { variantId } = await createVariant(companyId);
  return seedPackage(companyId, { status: 'cancelled', orderStatus: 'processing', manual, lines: [{ variantId, quantity: 1 }] });
}

const settle = (orderId: string) => withCompany(companyId, () => settleCancelledOrder(orderId));

describe('khép đơn mọi kiện đã huỷ (#236 PR 3)', () => {
  let manualOrder: { orderId: string; orderCode: string };

  beforeAll(async () => {
    manualOrder = await allCancelledOrder(true);
    await settle(manualOrder.orderId);
  });

  it('AC18, Review Focus 5: đơn tạo tay mọi kiện, mọi dòng đã huỷ → cancelled bằng auto_cancel', async () => {
    const { orderId, orderCode } = manualOrder;
    expect(await orderOf(orderId)).toMatchObject({ status: 'cancelled', outcome: null, cancel_reason: 'Mọi kiện đã huỷ' });
    expect((await orderTransitions(orderId)).at(-1)).toMatchObject({
      action: 'auto_cancel',
      from_state: 'processing',
      to_state: 'cancelled',
      source: 'system',
      actor_id: null,
    });
    expect(await outboxOf(orderId, 'sales.order_cancelled')).toEqual([{ orderId, code: orderCode, source: 'manual', by: 'seller' }]);
    expect(await outboxOf(orderId, 'sales.order_status_changed')).toContainEqual(
      expect.objectContaining({ orderId, from: 'processing', to: 'cancelled' }),
    );
  });

  it('Review Focus 2: khép lại đơn đã khép → false, không ghi lịch sử, không phát thêm', async () => {
    const { orderId } = manualOrder;
    const transitions = (await orderTransitions(orderId)).length;
    expect(await settle(orderId)).toBe(false);
    expect(await orderTransitions(orderId)).toHaveLength(transitions);
    expect(await outboxOf(orderId, 'sales.order_cancelled')).toHaveLength(1);
  });

  it('D3: đơn sàn mọi kiện, mọi dòng đã huỷ → platform_cancel, Sàn huỷ đơn, by platform', async () => {
    const { orderId, orderCode } = await allCancelledOrder(false);
    await settle(orderId);
    expect(await orderOf(orderId)).toMatchObject({ status: 'cancelled', cancel_reason: 'Sàn huỷ đơn' });
    expect((await orderTransitions(orderId)).at(-1)).toMatchObject({ action: 'platform_cancel', source: 'marketplace' });
    expect(await outboxOf(orderId, 'sales.order_cancelled')).toEqual([{ orderId, code: orderCode, source: 'marketplace', by: 'platform' }]);
  });
});
