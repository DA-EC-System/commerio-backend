// Áp ghép SKU lên kiện đã có (spec 237 §5.5 bảng 1, AC3–AC8, 16a, 16c, Review Focus 1, 3).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MappedSku } from '#src/modules/order/fulfillment/domain/remap.ts';
import { remapPackageLines, settleDeferredHandovers } from '#src/modules/order/fulfillment/index.ts';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, outboxOf, packageDocuments, packageRow, seedPackage, stockOfVariant } from './helpers.ts';

const REASON = 'Ghép SKU LZ-1';
const actorId = randomUUID();

afterEach(() => setStockPort());

async function setup(variants = 1) {
  const { companyId } = await createCompany();
  const vs: string[] = [];
  for (let i = 0; i < variants; i++) vs.push((await createVariant(companyId)).variantId);
  return { companyId, vs };
}

const variant = (variantId: string): MappedSku => ({ kind: 'variant', variantId });
const UNTRACKED: MappedSku = { kind: 'untracked' };

const orderLineOf = async (packageLineId: string) =>
  (await testPool().query<{ order_line_id: string }>('select order_line_id from "order".package_lines where id = $1', [packageLineId])).rows[0]!
    .order_line_id;

/** Ghép các dòng kiện (theo id dòng kiện) sang `to`. */
async function remap(
  companyId: string,
  lines: readonly (readonly [string, MappedSku])[],
  o: Partial<{ holdStock: boolean; orderCutoffAt: Date | null }> = {},
) {
  const changes = await Promise.all(lines.map(async ([lineId, to]) => ({ orderLineId: await orderLineOf(lineId), to })));
  return withCompany(companyId, () =>
    remapPackageLines(changes, { actorId, holdStock: o.holdStock ?? true, orderCutoffAt: o.orderCutoffAt ?? null, reason: REASON }),
  );
}

const lineOf = async (packageLineId: string) =>
  (
    await testPool().query<{ variant_id: string | null; stock_untracked: boolean; reserved_qty: number; stock_deducted: boolean; unit_cost: string | null }>(
      'select variant_id, stock_untracked, reserved_qty, stock_deducted, unit_cost from "order".package_lines where id = $1',
      [packageLineId],
    )
  ).rows[0]!;

const historyOf = async (packageId: string) =>
  (
    await testPool().query(
      `select action, from_state, to_state, actor_id, reason from core.state_transitions where entity_type = 'packages' and entity_id = $1 order by id`,
      [packageId],
    )
  ).rows;

const jobsOf = async (companyId: string) =>
  (
    await testPool().query<{ data: { companyId: string; variantIds: string[] } }>(
      `select data from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1 order by created_on`,
      [companyId],
    )
  ).rows.map((r) => r.data);

const versionOf = async (packageId: string) =>
  (await testPool().query<{ version: number }>('select version from "order".packages where id = $1', [packageId])).rows[0]!.version;

const settle = (companyId: string, packageId: string) =>
  withCompany(companyId, async () => settleHandover((await lockPackage(packageId))!, { actorId: null, mode: 'deduct' }));

describe('remapPackageLines: ghép lần đầu áp lên kiện (spec 237 §5.5 bảng 1)', () => {
  it('kiện backordered → biến thể: dòng kiện có biến thể, xếp phân hàng, một dòng lịch sử remap, version tăng', async () => {
    const { companyId, vs: [A] } = await setup();
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    const before = await versionOf(p.packageId);

    const out = await remap(companyId, [[p.lineIds[0]!, variant(A!)]]);

    expect(out).toEqual(new Map([[await orderLineOf(p.lineIds[0]!), 'applied']]));
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: A, stock_untracked: false, reserved_qty: 0 });
    expect(await jobsOf(companyId)).toEqual([{ companyId, variantIds: [A] }]);
    expect(await historyOf(p.packageId)).toEqual([
      { action: 'remap', from_state: 'backordered', to_state: 'backordered', actor_id: actorId, reason: REASON },
    ]);
    expect(await versionOf(p.packageId)).toBe(before + 1);
  });

  it('16a: kiện backordered một dòng → không quản tồn: kiện reserved (lịch sử hold), có reserved_at, không gọi cổng tồn', async () => {
    const { companyId, vs: [A] } = await setup();
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    setStockPort({
      reserve: async () => {
        throw new Error('không được gọi cổng tồn');
      },
    });

    await remap(companyId, [[p.lineIds[0]!, UNTRACKED]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    const { rows } = await testPool().query('select reserved_at from "order".packages where id = $1', [p.packageId]);
    expect(rows[0].reserved_at).toBeInstanceOf(Date);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: null, stock_untracked: true, reserved_qty: 0 });
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap', 'hold']);
    expect(await jobsOf(companyId)).toEqual([]);
  });

  it('Review Focus 3: kiện reserved có dòng mới mà biến thể mới hết hàng → nhả cả kiện về backordered (reclaim), xếp phân hàng', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, {
      status: 'reserved',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: null, quantity: 1 },
      ],
    });

    await remap(companyId, [[p.lineIds[1]!, variant(B!)]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'backordered' });
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap', 'reclaim']);
    expect((await lineOf(p.lineIds[0]!)).reserved_qty).toBe(0);
    expect(await lineOf(p.lineIds[1]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect(await jobsOf(companyId)).toEqual([{ companyId, variantIds: [A!, B!].sort() }]);
  });

  it('Review Focus 3: kiện reserved, biến thể mới đủ hàng → giữ dòng mới, kiện vẫn reserved', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, B!, 5, 30000);
    const p = await seedPackage(companyId, {
      status: 'reserved',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: null, quantity: 1 },
      ],
    });

    await remap(companyId, [[p.lineIds[1]!, variant(B!)]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    expect(await lineOf(p.lineIds[1]!)).toMatchObject({ variant_id: B, reserved_qty: 1 });
    expect((await stockOfVariant(companyId, B!)).reserved).toBe(1);
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(1);
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap']);
  });

  it('AC3: kiện in_transit bàn giao bắt buộc có dòng chưa ghép → một phiếu XK mới chỉ gồm dòng đó, giá vốn bình quân; gọi lại không thêm phiếu', async () => {
    const { companyId, vs: [a, b] } = await setup(2);
    await receive(companyId, a!, 10, 100000);
    await receive(companyId, b!, 10, 30000);
    const p = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'forced',
      lines: [
        { variantId: a!, quantity: 1, reserved: true },
        { variantId: null, quantity: 2 },
      ],
    });
    await settle(companyId, p.packageId);
    expect(await packageDocuments(p.packageId)).toHaveLength(1);

    await remap(companyId, [[p.lineIds[1]!, variant(b!)]]);

    expect(await packageDocuments(p.packageId)).toHaveLength(2);
    expect(await stockOfVariant(companyId, a!)).toMatchObject({ onHand: 9 });
    expect(await stockOfVariant(companyId, b!)).toMatchObject({ onHand: 8 });
    expect(await lineOf(p.lineIds[1]!)).toMatchObject({ variant_id: b, stock_deducted: true, unit_cost: '30000.00' });

    const again = await remap(companyId, [[p.lineIds[1]!, variant(b!)]]);
    expect([...again.values()]).toEqual(['applied']);
    expect(await packageDocuments(p.packageId)).toHaveLength(2);
    expect(await stockOfVariant(companyId, b!)).toMatchObject({ onHand: 8 });
  });

  it('AC4: kiện delivered chưa phát package_delivered, ghép dòng cuối → trừ tồn rồi phát package_delivered một lần, dòng mang giá vốn thật', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, {
      status: 'delivered',
      deliveredAt: new Date('2026-11-12T09:00:00Z'),
      lines: [
        { variantId: A!, quantity: 1, unitCost: '100000.00' },
        { variantId: null, quantity: 1 },
      ],
    });

    await remap(companyId, [[p.lineIds[1]!, variant(B!)]]);

    expect(await packageDocuments(p.packageId)).toHaveLength(1);
    const delivered = await outboxOf(p.orderId, 'fulfillment.package_delivered');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: A, unitCost: '100000.00' }),
        expect.objectContaining({ variantId: B, unitCost: '30000.00' }),
      ]),
    );
  });

  it('AC5: kiện delivered đã phát package_delivered → trừ tồn, không phát lần hai', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, {
      status: 'delivered',
      lines: [
        { variantId: A!, quantity: 1, unitCost: '100000.00' },
        { variantId: null, quantity: 1 },
      ],
    });
    await testPool().query('update "order".packages set delivery_posted_at = now() where id = $1', [p.packageId]);

    await remap(companyId, [[p.lineIds[1]!, variant(B!)]]);

    expect(await stockOfVariant(companyId, B!)).toMatchObject({ onHand: 9 });
    expect(await outboxOf(p.orderId, 'fulfillment.package_delivered')).toEqual([]);
  });

  it('AC6: kiện returned → dòng có biến thể, không phiếu XK, tồn không đổi', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, { status: 'returned', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: false });
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await stockOfVariant(companyId, B!)).toMatchObject({ onHand: 10, reserved: 0 });
  });

  it('AC7: kiện before_cutoff → dòng có biến thể, không trừ', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'before_cutoff',
      lines: [{ variantId: null, quantity: 1 }],
      fallbackVariantId: A!,
    });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: false });
    expect(await packageDocuments(p.packageId)).toEqual([]);
  });

  it('16c: kiện rời kho trước mốc kéo đơn, chưa dòng nào trừ → dòng có biến thể, không phiếu, kiện ghi before_cutoff', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const cutoff = new Date('2026-11-10T00:00:00Z');
    const p = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'marketplace',
      handedOverAt: new Date('2026-11-09T00:00:00Z'),
      lines: [{ variantId: null, quantity: 1 }],
      fallbackVariantId: A!,
    });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]], { orderCutoffAt: cutoff });

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: false });
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await packageRow(p.packageId)).toMatchObject({ handover_source: 'before_cutoff' });
  });

  it('AC8: gian hàng chờ kiểm kê → không giữ, không trừ; hàm bù của phiếu đầu kỳ trừ kiện in_transit sau đó', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const shopId = await channelShop(companyId, true);
    const handedOverAt = new Date('2026-11-12T00:00:00Z');
    const waiting = await seedPackage(companyId, { status: 'backordered', shopId, lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    const out = await seedPackage(companyId, {
      status: 'in_transit',
      shopId,
      handoverSource: 'marketplace',
      handedOverAt,
      lines: [{ variantId: null, quantity: 1 }],
      fallbackVariantId: A!,
    });
    setStockPort({
      reserve: async () => {
        throw new Error('không được giữ');
      },
      ship: async () => {
        throw new Error('không được trừ');
      },
    });

    await remap(companyId, [
      [waiting.lineIds[0]!, variant(B!)],
      [out.lineIds[0]!, variant(B!)],
    ], { holdStock: false });

    expect(await packageRow(waiting.packageId)).toMatchObject({ status: 'backordered' });
    expect(await lineOf(waiting.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect(await lineOf(out.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: false });
    expect(await packageDocuments(out.packageId)).toEqual([]);

    setStockPort();
    const countedAt = new Date(handedOverAt.getTime() - 60_000);
    expect(await withCompany(companyId, () => settleDeferredHandovers(shopId, countedAt))).toEqual({ deducted: 1, storedOnly: 0 });
    expect(await packageDocuments(out.packageId)).toHaveLength(1);
    expect(await lineOf(out.lineIds[0]!)).toMatchObject({ stock_deducted: true });
  });

  it('Review Focus 1: kiện in_transit có hai dòng chưa ghép, ghép một → chỉ dòng đó vào phiếu XK, dòng kia vẫn chưa ghép', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, {
      status: 'in_transit',
      lines: [
        { variantId: null, quantity: 1 },
        { variantId: null, quantity: 2 },
      ],
      fallbackVariantId: A!,
    });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await packageDocuments(p.packageId)).toHaveLength(1);
    expect(await stockOfVariant(companyId, B!)).toMatchObject({ onHand: 9 });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: true });
    expect(await lineOf(p.lineIds[1]!)).toMatchObject({ variant_id: null, stock_untracked: false, stock_deducted: false });
  });

  it('AC14: cổng tồn ném lỗi giữa lúc áp → hàm ném, giao dịch rollback, dòng kiện vẫn chưa ghép', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    setStockPort({
      ship: async () => {
        throw new Error('hỏng');
      },
    });

    await expect(remap(companyId, [[p.lineIds[0]!, variant(B!)]])).rejects.toThrow('hỏng');

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: null, stock_untracked: false });
    expect(await historyOf(p.packageId)).toEqual([]);
  });

  it('dòng đơn không có dòng kiện nào: không có trong kết quả', async () => {
    const { companyId } = await setup();
    const out = await withCompany(companyId, () =>
      remapPackageLines([{ orderLineId: randomUUID(), to: UNTRACKED }], { actorId, holdStock: true, orderCutoffAt: null, reason: REASON }),
    );
    expect(out).toEqual(new Map());
  });
});
