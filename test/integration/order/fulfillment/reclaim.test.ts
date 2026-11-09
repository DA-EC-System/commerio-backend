import { describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { DISMANTLE_NOTE, runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive, setBuckets } from '../../product/inventory/helpers.ts';
import { outboxOf, packageRow, seedPackage, stockOfVariant, transitionsOf } from './helpers.ts';

const ctx = { stockHoldOf: awaitingStocktakeShops };
const at = (h: number) => new Date(Date.UTC(2026, 10, 9, h));
const run = (companyId: string, variantIds: string[]) => withCompany(companyId, () => runAllocation(ctx, { variantIds }));

describe('lượt phân hàng: lấy lại phần giữ (25 §7.4, spec 199b §5.3)', () => {
  it('D2-02 AC6: tồn thực xuống dưới đang giữ → kiện đơn unpaid bị lấy trước, dừng khi đủ', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 3, 100000);
    const unpaid = await seedPackage(companyId, { status: 'reserved', orderStatus: 'unpaid', reservedAt: at(10), lines: [{ variantId: A, quantity: 1, reserved: true }] });
    const processing = await seedPackage(companyId, { status: 'reserved', reservedAt: at(11), lines: [{ variantId: A, quantity: 1, reserved: true }] });
    const packed = await seedPackage(companyId, { status: 'packed', reservedAt: at(12), lines: [{ variantId: A, quantity: 1, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 2, invariantBroken: true });

    const r = await run(companyId, [A]);

    expect(r.reclaimed).toEqual([unpaid.packageId]);
    const row = await packageRow(unpaid.packageId);
    expect(row).toMatchObject({ status: 'backordered', reserved_at: null });
    expect(await transitionsOf(unpaid.packageId)).toContainEqual({ action: 'reclaim', from_state: 'reserved', to_state: 'backordered', source: 'system' });
    expect((await packageRow(processing.packageId)).status).toBe('reserved');
    expect((await packageRow(packed.packageId)).status).toBe('packed');
    expect((await stockOfVariant(companyId, A)).reserved).toBe(2);
  });

  it('AC6: SKU khác của kiện bị lấy lại được giữ cho kiện khác trong cùng lượt', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    const { variantId: B } = await createVariant(companyId);
    await receive(companyId, A, 1, 100000);
    await receive(companyId, B, 1, 100000);
    const both = await seedPackage(companyId, {
      status: 'reserved',
      lines: [{ variantId: A, quantity: 1, reserved: true }, { variantId: B, quantity: 1, reserved: true }],
    });
    const waitsB = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: B, quantity: 1 }] });
    await setBuckets(companyId, A, { onHand: 0, invariantBroken: true });

    const r = await run(companyId, [A]);

    expect(r.reclaimed).toEqual([both.packageId]);
    expect(r.held).toEqual([waitsB.packageId]);
    expect((await packageRow(waitsB.packageId)).status).toBe('reserved');
    expect(r.variantIds).toEqual([A, B].sort());
    expect((await outboxOf(companyId, 'fulfillment.allocation_done')).at(-1)).toEqual({ variantIds: [A, B].sort() });
  });

  it('Review Focus 2: kiện vừa bị lấy lại không được giữ lại trong cùng lượt, kể cả khi lấy dư còn đủ hàng', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 6, 100000);
    const p1 = await seedPackage(companyId, { status: 'reserved', orderStatus: 'unpaid', lines: [{ variantId: A, quantity: 1, reserved: true }] });
    const p2 = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A, quantity: 5, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 3, invariantBroken: true });
    const r = await run(companyId, [A]);
    expect(r).toMatchObject({ reclaimed: [p1.packageId, p2.packageId], held: [] });
    expect((await packageRow(p1.packageId)).status).toBe('backordered');
  });

  it('opening: kiện packed không giữ được thì bật Cần xử lý với DISMANTLE_NOTE; lượt thường thì không', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 1, 100000);
    const normal = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A, quantity: 2 }] });
    await run(companyId, [A]);
    expect((await packageRow(normal.packageId)).needs_attention).toBe(false);

    await withCompany(companyId, () => runAllocation({}, { all: true }, { opening: true, cause: { type: 'stocktake', documentId: normal.orderId } }));
    expect(await packageRow(normal.packageId)).toMatchObject({ status: 'packed', needs_attention: true, flag_note: DISMANTLE_NOTE });
  });

  it('minor 1: đọc lại thiếu hụt sau khi khoá kiện: hàng về trong lúc chờ khoá thì không lấy lại kiện nào', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 2, 100000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A, quantity: 2, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 1, invariantBroken: true });
    const holder = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query('select id from "order".packages where id = $1 for update', [p.packageId]);
      const pending = run(companyId, [A]);
      for (let i = 0; i < 200; i++) {
        const { rows } = await testPool().query<{ n: number }>(
          `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'tuple' or (wait_event_type = 'Lock' and wait_event = 'transactionid')`,
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await setBuckets(companyId, A, { onHand: 2, invariantBroken: false });
      await holder.query('commit');
      expect((await pending).reclaimed).toEqual([]);
      expect((await packageRow(p.packageId)).status).toBe('reserved');
    } finally {
      await holder.query('rollback').catch(() => {});
      holder.release();
    }
  });

  it('minor 2: kiện reserved mà dòng chưa giữ thì lấy lại không nhả phần giữ của kiện khác', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 2, 100000);
    const other = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A, quantity: 2, reserved: true }] });
    const unheld = await seedPackage(companyId, { status: 'reserved', orderStatus: 'unpaid', lines: [{ variantId: A, quantity: 2 }] });
    await setBuckets(companyId, A, { onHand: 1, invariantBroken: true });
    const r = await run(companyId, [A]);
    expect(r.reclaimed).toEqual([other.packageId]);
    expect((await packageRow(unheld.packageId)).status).toBe('reserved');
    expect((await stockOfVariant(companyId, A)).reserved).toBe(0);
  });

  it('minor 5: lấy lại phát package_status_changed reserved → backordered', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 1, 100000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A, quantity: 1, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 0, invariantBroken: true });
    await run(companyId, [A]);
    expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toContainEqual({
      packageId: p.packageId,
      orderId: p.orderId,
      from: 'reserved',
      to: 'backordered',
    });
  });

  it('minor 6: lượt sau giữ được kiện đã đóng thì gỡ cờ Dỡ kiện về kệ của phiếu đầu kỳ', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 1, 100000);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A, quantity: 2 }] });
    await withCompany(companyId, () => runAllocation({}, { all: true }, { opening: true }));
    expect((await packageRow(p.packageId)).flag_note).toBe(DISMANTLE_NOTE);
    await receive(companyId, A, 1, 100000);
    await run(companyId, [A]);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_attention: false, flag_note: null });
  });

  it('AC6: cùng nhóm đơn processing thì kiện giữ sau cùng bị lấy trước', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 2, 100000);
    const early = await seedPackage(companyId, { status: 'reserved', reservedAt: at(10), lines: [{ variantId: A, quantity: 1, reserved: true }] });
    const late = await seedPackage(companyId, { status: 'reserved', reservedAt: at(11), lines: [{ variantId: A, quantity: 1, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 1, invariantBroken: true });
    expect((await run(companyId, [A])).reclaimed).toEqual([late.packageId]);
    expect((await packageRow(early.packageId)).status).toBe('reserved');
  });
});
