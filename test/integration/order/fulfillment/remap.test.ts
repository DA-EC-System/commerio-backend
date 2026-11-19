// Áp ghép SKU lên kiện đã có (spec 237 §5.5 bảng 1, AC3–AC8, 16a, 16c, Review Focus 1, 3; PR 2: bảng 2, 3, ca 17–25).
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { MappedSku } from '#src/modules/order/fulfillment/domain/remap.ts';
import { remapPackageLines, settleDeferredHandovers } from '#src/modules/order/fulfillment/index.ts';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, outboxOf, packageDocuments, packageRow, seedPackage, stockOfVariant } from './helpers.ts';
import { packedSplit } from './resplit-fixtures.ts';

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
  it('D2-G01 kiện backordered → biến thể: dòng kiện có biến thể, xếp phân hàng, một dòng lịch sử remap, version tăng', async () => {
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

  it('D2-G06 16a: kiện backordered một dòng → không quản tồn: kiện reserved (lịch sử hold), có reserved_at, không gọi cổng tồn', async () => {
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

  it('D2-G05 Review Focus 3: kiện reserved có dòng mới mà biến thể mới hết hàng → nhả cả kiện về backordered (reclaim), xếp phân hàng', async () => {
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

  it('D2-G05 Review Focus 3: kiện reserved, biến thể mới đủ hàng → giữ dòng mới, kiện vẫn reserved', async () => {
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
    // Giữ ngoài lượt phân hàng: báo channel đẩy tồn mới của biến thể vừa giữ (review I2, như kiện mới lập, spec 199b D4).
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toEqual([{ variantIds: [B] }]);
  });

  it('D2-G03 AC3: kiện in_transit bàn giao bắt buộc có dòng chưa ghép → một phiếu XK mới chỉ gồm dòng đó, giá vốn bình quân; gọi lại không thêm phiếu', async () => {
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

  it('D2-G03 AC4: kiện delivered chưa phát package_delivered, ghép dòng cuối → trừ tồn rồi phát package_delivered một lần, dòng mang giá vốn thật', async () => {
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

  it('D2-G03 AC5: kiện delivered đã phát package_delivered → trừ tồn, không phát lần hai', async () => {
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

  it('D2-G04 AC6: kiện returned → dòng có biến thể, không phiếu XK, tồn không đổi', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 10, 30000);
    const p = await seedPackage(companyId, { status: 'returned', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_deducted: false });
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await stockOfVariant(companyId, B!)).toMatchObject({ onHand: 10, reserved: 0 });
  });

  it('D2-G04 AC7: kiện before_cutoff → dòng có biến thể, không trừ', async () => {
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

  it('D2-G04 16c: kiện rời kho trước mốc kéo đơn, chưa dòng nào trừ → dòng có biến thể, không phiếu, kiện ghi before_cutoff', async () => {
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

  it('D2-G04 AC8: gian hàng chờ kiểm kê → không giữ, không trừ; hàm bù của phiếu đầu kỳ trừ kiện in_transit sau đó', async () => {
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

  it('D2-G03 Review Focus 1: kiện in_transit có hai dòng chưa ghép, ghép một → chỉ dòng đó vào phiếu XK, dòng kia vẫn chưa ghép', async () => {
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

  it('D2-G09 AC14: cổng tồn ném lỗi giữa lúc áp → hàm ném, giao dịch rollback, dòng kiện vẫn chưa ghép', async () => {
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

// Đổi ghép đã dùng (spec 237 §5.5 bảng 2, 3; §5.6; §9 PR 2). A là ghép cũ, B là ghép mới.
const pendingOf = async (packageLineId: string) =>
  (await testPool().query<{ remap_pending: boolean }>('select remap_pending from "order".package_lines where id = $1', [packageLineId])).rows[0]!
    .remap_pending;

const jobVariants = async (companyId: string) => [...new Set((await jobsOf(companyId)).flatMap((j) => j.variantIds))].sort();

const allocate = (companyId: string, variantIds: string[]) => withCompany(companyId, () => runAllocation({}, { variantIds }));

/** Dòng đơn của dòng kiện thành dòng chờ bỏ (sàn huỷ món): ghi `cancelled_qty` cùng giao dịch (trigger kiểm bằng). */
async function markPendingDrop(packageLineId: string) {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await client.query(
      `update "order".order_lines set cancelled_qty = quantity where id = (select order_line_id from "order".package_lines where id = $1)`,
      [packageLineId],
    );
    await client.query('update "order".package_lines set pending_drop_qty = quantity where id = $1', [packageLineId]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

const setUntracked = (packageLineId: string) =>
  testPool().query('update "order".package_lines set variant_id = null, stock_untracked = true where id = $1', [packageLineId]);

describe('remapPackageLines: đổi ghép đã dùng (spec 237 §5.5 bảng 2, 3)', () => {
  it('D2-G10 17: kiện reserved giữ A, B đủ → nhả A, giữ B, kiện reserved, có việc phân hàng gồm A, lịch sử remap', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, B!, 5, 30000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A!, quantity: 1, reserved: true }] });

    const out = await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect([...out.values()]).toEqual(['applied']);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 1 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect((await stockOfVariant(companyId, B!)).reserved).toBe(1);
    expect(await jobVariants(companyId)).toContain(A);
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap']);
  });

  it('D2-G10 18: B không đủ → mọi dòng nhả, kiện backordered (lịch sử reclaim), dòng là B, việc phân hàng gồm A và B', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A!, quantity: 1, reserved: true }] });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'backordered' });
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap', 'reclaim']);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect(await jobVariants(companyId)).toEqual([A!, B!].sort());
  });

  it('D2-G10 18a: kiện backordered giữ một phần A → nhả phần đang giữ, dòng B, xếp lượt', async () => {
    const { companyId, vs: [A, B, C] } = await setup(3);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, {
      status: 'backordered',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: C!, quantity: 1 },
      ],
    });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'backordered' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect(await jobVariants(companyId)).toEqual([A!, B!, C!].sort());
  });

  it('D2-G11 19: kiện packed giữ A → dòng vẫn A, remap_pending, needs_open + remap, version tăng, lịch sử "…: chờ dỡ kiện", kết quả needs_unload', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, B!, 5, 30000);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A!, quantity: 1, reserved: true }] });
    const before = await versionOf(p.packageId);

    const out = await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect([...out.values()]).toEqual(['needs_unload']);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: A, reserved_qty: 1 });
    expect(await pendingOf(p.lineIds[0]!)).toBe(true);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'remap' });
    expect(await versionOf(p.packageId)).toBe(before + 1);
    expect(await historyOf(p.packageId)).toEqual([
      { action: 'remap', from_state: 'packed', to_state: 'packed', actor_id: actorId, reason: `${REASON}: chờ dỡ kiện` },
    ]);
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(1);
    expect((await stockOfVariant(companyId, B!)).reserved).toBe(0);
  });

  it('D2-G11 19e: gọi lại cùng B → không ghi, version giữ, không lịch sử mới, kết quả needs_unload', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A!, quantity: 1, reserved: true }] });
    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);
    const before = await versionOf(p.packageId);

    const out = await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect([...out.values()]).toEqual(['needs_unload']);
    expect(await versionOf(p.packageId)).toBe(before);
    expect(await historyOf(p.packageId)).toHaveLength(1);
  });

  it('D2-G12 20b: kiện ở 19, đổi về A → dấu xoá, mục đích stocktake, có việc phân hàng; chạy runAllocation cho A thì cờ gỡ', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A!, quantity: 1, reserved: true }] });
    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);
    const before = await versionOf(p.packageId);

    const out = await remap(companyId, [[p.lineIds[0]!, variant(A!)]]);

    expect([...out.values()]).toEqual(['applied']);
    expect(await pendingOf(p.lineIds[0]!)).toBe(false);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: A, reserved_qty: 1 });
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake' });
    expect(await versionOf(p.packageId)).toBe(before + 1);
    expect(await jobVariants(companyId)).toEqual([A]);
    expect((await historyOf(p.packageId)).map((h) => h.action)).toEqual(['remap', 'remap']);

    await allocate(companyId, [A!]);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: false, open_purpose: null });
  });

  it('D2-G12 20f: kiện ở 19 có báo thất lạc chờ xác nhận, đổi về A rồi runAllocation → mục đích stocktake, cờ và báo cáo còn', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A!, quantity: 1, reserved: true }] });
    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);
    const reporter = randomUUID();
    await testPool().query(
      `update "order".packages set lost_reported_by = $2, lost_reported_at = now(), lost_claim_code = 'KN-1' where id = $1`,
      [p.packageId, reporter],
    );

    await remap(companyId, [[p.lineIds[0]!, variant(A!)]]);
    await allocate(companyId, [A!]);

    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake', lost_reported_by: reporter, lost_claim_code: 'KN-1' });
  });

  it('D2-G12 19f: kiện ở 19 có thêm một dòng chờ bỏ, đổi về A → dấu xoá, mục đích stocktake, runAllocation không gỡ cờ', async () => {
    const { companyId, vs: [A, B, C] } = await setup(3);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, C!, 5, 100000);
    const p = await seedPackage(companyId, {
      status: 'packed',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: C!, quantity: 1, reserved: true },
      ],
    });
    await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);
    await markPendingDrop(p.lineIds[1]!);

    await remap(companyId, [[p.lineIds[0]!, variant(A!)]]);
    expect(await pendingOf(p.lineIds[0]!)).toBe(false);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake' });

    await allocate(companyId, [A!, C!]);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake' });
  });

  it('D2-G14 22: kiện in_transit đã trừ A → không phiếu mới, dòng giữ A, kết quả kept', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, B!, 5, 30000);
    const p = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: A!, quantity: 1, unitCost: '100000' }] });
    const docs = (await packageDocuments(p.packageId)).length;

    const out = await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect([...out.values()]).toEqual(['kept']);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: A, stock_deducted: true });
    expect(await packageDocuments(p.packageId)).toHaveLength(docs);
    expect(await historyOf(p.packageId)).toEqual([]);
  });

  it('D2-G15 23: kiện reserved giữ A → không quản tồn: nhả A, dòng stock_untracked, kiện reserved', async () => {
    const { companyId, vs: [A] } = await setup();
    await receive(companyId, A!, 5, 100000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A!, quantity: 1, reserved: true }] });

    await remap(companyId, [[p.lineIds[0]!, UNTRACKED]]);

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: null, stock_untracked: true, reserved_qty: 0 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect(await jobVariants(companyId)).toEqual([A]);
  });

  it('D2-G15 24: dòng stock_untracked ở kiện backordered → B: dòng có B, có việc phân hàng', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    await setUntracked(p.lineIds[0]!);

    const out = await remap(companyId, [[p.lineIds[0]!, variant(B!)]]);

    expect([...out.values()]).toEqual(['applied']);
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, stock_untracked: false });
    expect(await jobVariants(companyId)).toEqual([B]);
  });

  it('D2-G15 24a: dòng stock_untracked ở kiện packed đang giữ dòng khác → B: dòng B, không Cần mở; B đủ thì giữ, thiếu thì kiện giữ nguyên và xếp lượt', async () => {
    const { companyId, vs: [B, C, D] } = await setup(3);
    await receive(companyId, B!, 1, 30000);
    await receive(companyId, C!, 5, 100000);
    await receive(companyId, D!, 5, 100000);
    const enough = await seedPackage(companyId, {
      status: 'packed',
      lines: [
        { variantId: null, quantity: 1 },
        { variantId: C!, quantity: 1, reserved: true },
      ],
    });
    const short = await seedPackage(companyId, {
      status: 'packed',
      lines: [
        { variantId: null, quantity: 1 },
        { variantId: D!, quantity: 1, reserved: true },
      ],
    });
    await setUntracked(enough.lineIds[0]!);
    await setUntracked(short.lineIds[0]!);

    await remap(companyId, [[enough.lineIds[0]!, variant(B!)]]);
    await remap(companyId, [[short.lineIds[0]!, variant(B!)]]);

    expect(await packageRow(enough.packageId)).toMatchObject({ status: 'packed', needs_open: false });
    expect(await lineOf(enough.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 1 });
    expect(await packageRow(short.packageId)).toMatchObject({ status: 'packed', needs_open: false });
    expect(await lineOf(short.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect(await jobVariants(companyId)).toEqual([B]);
  });

  it('D2-G18 18b: kiện thay backordered có dòng chờ thay A, kiện cũ packed có dòng chờ bỏ A → đổi ghép: dòng chờ thay giữ A, kiện thay không sang reserved', async () => {
    const { v, orderId, packageId, a, b } = await packedSplit();
    const { variantId: B } = await createVariant(v.companyId);
    await receive(v.companyId, B, 10, 30000);
    const { rows: lines } = await testPool().query<{ id: string }>('select id from "order".order_lines where order_id = $1', [orderId]);

    const out = await withCompany(v.companyId, () =>
      remapPackageLines(
        lines.map((l) => ({ orderLineId: l.id, to: variant(B) })),
        { actorId, holdStock: true, orderCutoffAt: null, reason: REASON },
      ),
    );

    expect([...out.values()]).toEqual(['kept', 'kept']);
    const { rows } = await testPool().query<{ package_id: string; variant_id: string }>(
      'select package_id, variant_id from "order".package_lines where package_id = any($1)',
      [[packageId, a.id, b.id]],
    );
    expect(rows.every((r) => r.variant_id === v.variantId)).toBe(true);
    expect(await packageRow(a.id)).toMatchObject({ status: 'backordered' });
    expect(await packageRow(b.id)).toMatchObject({ status: 'backordered' });
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });
  });

  it('D2-G10 Review Focus 3: kiện reserved hai dòng A, B; đổi A → B: hai dòng B, giữ đủ tổng; B thiếu thì kiện backordered', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, B!, 2, 30000);
    const enough = await seedPackage(companyId, {
      status: 'reserved',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: B!, quantity: 1, reserved: true },
      ],
    });

    await remap(companyId, [[enough.lineIds[0]!, variant(B!)]]);

    expect(await packageRow(enough.packageId)).toMatchObject({ status: 'reserved' });
    expect(await lineOf(enough.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 1 });
    expect(await lineOf(enough.lineIds[1]!)).toMatchObject({ variant_id: B, reserved_qty: 1 });
    expect((await stockOfVariant(companyId, B!)).reserved).toBe(2);
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);

    const short = await seedPackage(companyId, {
      status: 'reserved',
      lines: [
        { variantId: A!, quantity: 1, reserved: true },
        { variantId: A!, quantity: 2, reserved: true },
      ],
    });
    await remap(companyId, [[short.lineIds[0]!, variant(B!)]]);
    expect(await packageRow(short.packageId)).toMatchObject({ status: 'backordered' });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(0);
    expect((await stockOfVariant(companyId, B!)).reserved).toBe(2);
  });

  it('D2-G15 Review Focus 4: gian hàng chờ kiểm kê, dòng untracked ở kiện reserved → B: không gọi cổng tồn, kiện backordered, không việc phân hàng', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    const shopId = await channelShop(companyId, true);
    const p = await seedPackage(companyId, { status: 'reserved', shopId, lines: [{ variantId: null, quantity: 1 }], fallbackVariantId: A! });
    await setUntracked(p.lineIds[0]!);
    const boom = async () => {
      throw new Error('không được gọi cổng tồn');
    };
    setStockPort({ reserve: boom, release: boom, ship: boom });

    await remap(companyId, [[p.lineIds[0]!, variant(B!)]], { holdStock: false });

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'backordered' });
    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: B, reserved_qty: 0 });
    expect(await jobsOf(companyId)).toEqual([]);
  });

  it('D2-G16 25: cổng tồn ném lỗi lúc reserve B → hàm ném, dòng vẫn A, A vẫn được giữ, kiện vẫn reserved', async () => {
    const { companyId, vs: [A, B] } = await setup(2);
    await receive(companyId, A!, 5, 100000);
    await receive(companyId, B!, 5, 30000);
    const p = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: A!, quantity: 1, reserved: true }] });
    setStockPort({
      reserve: async () => {
        throw new Error('hỏng');
      },
    });

    await expect(remap(companyId, [[p.lineIds[0]!, variant(B!)]])).rejects.toThrow('hỏng');

    expect(await lineOf(p.lineIds[0]!)).toMatchObject({ variant_id: A, reserved_qty: 1 });
    expect((await stockOfVariant(companyId, A!)).reserved).toBe(1);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved' });
    expect(await historyOf(p.packageId)).toEqual([]);
  });
});
