import { describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, outboxOf, packageLineRows, packageRow, seedPackage, stockOfVariant, transitionsOf } from './helpers.ts';

const ctx = { stockHoldOf: awaitingStocktakeShops };
const day = (d: number) => new Date(Date.UTC(2026, 10, 10 + d, 9));

async function setup(stock: number) {
  const { companyId } = await createCompany();
  const { variantId: A } = await createVariant(companyId);
  if (stock > 0) await receive(companyId, A, stock, 100000);
  return { companyId, A };
}

const run = (companyId: string, variantIds: string[]) => withCompany(companyId, () => runAllocation(ctx, { variantIds }));
const status = async (packageId: string) => (await packageRow(packageId)).status;

describe('lượt phân hàng: giữ kiện theo thứ tự (25 §7.4, spec 199b §5.3)', () => {
  it('D2-01 AC1: hai kiện backordered cùng SKU, hàng đủ một kiện → kiện hạn sớm sang reserved, có reserved_at, lịch sử hold', async () => {
    const { companyId, A } = await setup(2);
    const x = await seedPackage(companyId, { status: 'backordered', shipBy: day(1), lines: [{ variantId: A, quantity: 2 }] });
    const y = await seedPackage(companyId, { status: 'backordered', shipBy: day(2), lines: [{ variantId: A, quantity: 2 }] });

    const r = await run(companyId, [A]);

    expect(r.held).toEqual([x.packageId]);
    const row = await packageRow(x.packageId);
    expect(row.status).toBe('reserved');
    expect(row.reserved_at).toBeInstanceOf(Date);
    expect((await packageLineRows(x.packageId))[0]!.reserved_qty).toBe(2);
    expect(await transitionsOf(x.packageId)).toContainEqual({ action: 'hold', from_state: 'backordered', to_state: 'reserved', source: 'system' });
    expect(await status(y.packageId)).toBe('backordered');
    expect((await stockOfVariant(companyId, A)).reserved).toBe(2);
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toEqual([{ variantIds: [A] }]);
  });

  it('AC2: kiện đầu thiếu thì bỏ qua, kiện sau đủ thì giữ', async () => {
    const { companyId, A } = await setup(3);
    const k1 = await seedPackage(companyId, { status: 'backordered', shipBy: day(1), lines: [{ variantId: A, quantity: 5 }] });
    const k2 = await seedPackage(companyId, { status: 'backordered', shipBy: day(2), lines: [{ variantId: A, quantity: 2 }] });
    await run(companyId, [A]);
    expect(await status(k1.packageId)).toBe('backordered');
    expect(await status(k2.packageId)).toBe('reserved');
  });

  it('AC3: cùng hạn thì đơn kéo về trước được giữ; ship_by null xếp sau', async () => {
    const { companyId, A } = await setup(1);
    const none = await seedPackage(companyId, { status: 'backordered', shipBy: null, orderCreatedAt: day(-5), lines: [{ variantId: A, quantity: 1 }] });
    const late = await seedPackage(companyId, { status: 'backordered', shipBy: day(1), orderCreatedAt: day(-1), lines: [{ variantId: A, quantity: 1 }] });
    const early = await seedPackage(companyId, { status: 'backordered', shipBy: day(1), orderCreatedAt: day(-2), lines: [{ variantId: A, quantity: 1 }] });
    await run(companyId, [A]);
    expect(await status(early.packageId)).toBe('reserved');
    expect(await status(late.packageId)).toBe('backordered');
    expect(await status(none.packageId)).toBe('backordered');
  });

  it('AC4: kiện packed chưa giữ được giữ trước kiện backordered hạn sớm hơn, trạng thái vẫn packed', async () => {
    const { companyId, A } = await setup(1);
    const packed = await seedPackage(companyId, { status: 'packed', shipBy: day(9), lines: [{ variantId: A, quantity: 1 }] });
    const back = await seedPackage(companyId, { status: 'backordered', shipBy: day(1), lines: [{ variantId: A, quantity: 1 }] });
    await run(companyId, [A]);
    const row = await packageRow(packed.packageId);
    expect(row.status).toBe('packed');
    expect(row.reserved_at).toBeInstanceOf(Date);
    expect((await packageLineRows(packed.packageId))[0]!.reserved_qty).toBe(1);
    expect(await status(back.packageId)).toBe('backordered');
  });

  it('AC5: không giữ kiện có dòng chưa ghép, kiện của gian hàng chờ kiểm kê, kiện needs_open', async () => {
    const { companyId, A } = await setup(10);
    const shopId = await channelShop(companyId, true);
    const unmapped = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: A, quantity: 1 }, { variantId: null, quantity: 1 }] });
    const waiting = await seedPackage(companyId, { status: 'backordered', shopId, lines: [{ variantId: A, quantity: 1 }] });
    const opening = await seedPackage(companyId, { status: 'backordered', needsOpen: true, lines: [{ variantId: A, quantity: 1 }] });
    const r = await run(companyId, [A]);
    expect(r.held).toEqual([]);
    for (const p of [unmapped, waiting, opening]) expect(await status(p.packageId)).toBe('backordered');
  });

  it('Review Focus 3: kiện của đơn unpaid được giữ như đơn processing', async () => {
    const { companyId, A } = await setup(1);
    const p = await seedPackage(companyId, { status: 'backordered', orderStatus: 'unpaid', lines: [{ variantId: A, quantity: 1 }] });
    await run(companyId, [A]);
    expect(await status(p.packageId)).toBe('reserved');
  });

  it('Review Focus 4: kiện backordered của đơn cancelled không được giữ', async () => {
    const { companyId, A } = await setup(1);
    const p = await seedPackage(companyId, { status: 'backordered', orderStatus: 'cancelled', lines: [{ variantId: A, quantity: 1 }] });
    await run(companyId, [A]);
    expect(await status(p.packageId)).toBe('backordered');
  });

  it('Review Focus 1: kiện ba dòng cùng SKU giữ đủ tổng số, ba dòng đều reserved_qty = quantity', async () => {
    const { companyId, A } = await setup(3);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [1, 2, 3].map(() => ({ variantId: A, quantity: 1 })) });
    await run(companyId, [A]);
    expect(await status(p.packageId)).toBe('reserved');
    expect((await packageLineRows(p.packageId)).map((l) => l.reserved_qty)).toEqual([1, 1, 1]);
    expect((await stockOfVariant(companyId, A)).reserved).toBe(3);
  });

  it('AC10: hai lượt cùng công ty đua nhau → kiện chỉ giữ một lần, số đang giữ đúng', async () => {
    const { companyId, A } = await setup(2);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: A, quantity: 2 }] });
    const results = await raceBehindLock(
      (holder) => holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`fulfillment.allocation:${companyId}`]),
      2,
      () => Promise.all([run(companyId, [A]), run(companyId, [A])]),
    );
    expect(results.flatMap((r) => r.held)).toEqual([p.packageId]);
    expect((await stockOfVariant(companyId, A)).reserved).toBe(2);
  });

  it('AC7: lượt không có gì để làm vẫn phát allocation_done với SKU kích hoạt', async () => {
    const { companyId, A } = await setup(0);
    const r = await run(companyId, [A]);
    expect(r).toEqual({ held: [], reclaimed: [], flagged: [], variantIds: [A] });
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toEqual([{ variantIds: [A] }]);
  });

  it('minor 4, 5: reserved_at lấy giờ DB cùng lịch sử hold; có package_status_changed backordered → reserved', async () => {
    const { companyId, A } = await setup(1);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: A, quantity: 1 }] });
    await run(companyId, [A]);
    const { rows } = await testPool().query<{ at: Date }>(
      `select at from core.state_transitions where entity_id = $1 and action = 'hold'`,
      [p.packageId],
    );
    expect((await packageRow(p.packageId)).reserved_at).toEqual(rows[0]!.at);
    expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toContainEqual({
      packageId: p.packageId,
      orderId: p.orderId,
      from: 'backordered',
      to: 'reserved',
    });
  });

  it('minor 7: lượt thường không khoá kiện của gian hàng chờ kiểm kê', async () => {
    const { companyId, A } = await setup(5);
    const shopId = await channelShop(companyId, true);
    const waiting = await seedPackage(companyId, { status: 'backordered', shopId, lines: [{ variantId: A, quantity: 1 }] });
    const holder = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query('select id from "order".packages where id = $1 for update', [waiting.packageId]);
      const outcome = await Promise.race([
        run(companyId, [A]).then(() => 'done'),
        new Promise((r) => setTimeout(() => r('blocked'), 3000)),
      ]);
      expect(outcome).toBe('done');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });
});
