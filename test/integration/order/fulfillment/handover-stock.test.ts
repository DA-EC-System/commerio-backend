import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HandoverStockMode } from '#src/modules/order/fulfillment/domain/handover.ts';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleDeferredHandovers, shipLateMappedLines } from '#src/modules/order/fulfillment/index.ts';
import { revertHandover, settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { companyWithVariants, receive } from '../../product/inventory/helpers.ts';
import {
  invariantBroken,
  outboxOf,
  packageDocuments,
  packageLineRows,
  packageRow,
  seedPackage,
  stockOfVariant,
} from './helpers.ts';

const settle = (companyId: string, packageId: string, mode: HandoverStockMode = 'deduct', actorId: string | null = randomUUID()) =>
  withCompany(companyId, async () => settleHandover((await lockPackage(packageId))!, { actorId, mode }));

describe('settleHandover: trừ tồn khi kiện rời kho (spec 199a §5.3)', () => {
  it('kiện đã giữ hàng: một phiếu XK, tồn thực và đang giữ giảm đúng số món, dòng có giá vốn, có package_shipped', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    const { packageId, orderId } = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: v!, quantity: 2, reserved: true }] });

    const { documents } = await settle(companyId, packageId);

    expect(documents).toHaveLength(1);
    expect(documents[0]!.number).toMatch(/^XK-/);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 8, reserved: 0 });
    expect(await packageLineRows(packageId)).toMatchObject([{ unit_cost: '100000.00', stock_deducted: true, reserved_qty: 0 }]);
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toEqual([
      { packageId, orderId, lines: [{ variantId: v!, quantity: 2, unitCost: '100000.00' }] },
    ]);
  });

  it('Review Focus 1: ba dòng cùng SKU, mỗi dòng 1 cái → tồn giảm 3, ba dòng đều đã trừ', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 50000);
    const one = { variantId: v!, quantity: 1, reserved: true };
    const { packageId } = await seedPackage(companyId, { status: 'in_transit', lines: [one, one, one] });

    await settle(companyId, packageId);

    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 2, reserved: 0 });
    expect((await packageLineRows(packageId)).map((l) => [l.stock_deducted, l.unit_cost])).toEqual([
      [true, '50000.00'],
      [true, '50000.00'],
      [true, '50000.00'],
    ]);
  });

  it('gọi lần hai không trừ thêm, documents rỗng', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    const { packageId, orderId } = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: v!, quantity: 2, reserved: true }] });
    await settle(companyId, packageId);

    expect((await settle(companyId, packageId)).documents).toEqual([]);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 8, reserved: 0 });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
  });

  it('kiện chưa giữ, đủ khả dụng → giữ rồi ship thường, không Tồn âm', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 100000);
    const { packageId } = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'marketplace',
      lines: [{ variantId: v!, quantity: 3 }],
    });

    await settle(companyId, packageId, 'deduct', null);

    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 2, reserved: 0 });
    expect(await invariantBroken(companyId, v!)).toBe(false);
    expect(await packageRow(packageId)).toMatchObject({ handover_source: 'marketplace', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.note)).toEqual([null]);
  });

  it('D2-31: kiện chưa giữ, thiếu khả dụng → ship forced, tồn âm, kiện cần xử lý', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 1, 100000);
    const { packageId } = await seedPackage(companyId, {
      status: 'in_transit',
      handoverSource: 'marketplace',
      lines: [{ variantId: v!, quantity: 3 }],
    });

    await settle(companyId, packageId, 'deduct', null);

    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: -2, reserved: 0 });
    expect(await invariantBroken(companyId, v!)).toBe(true);
    const row = await packageRow(packageId);
    expect(row).toMatchObject({ handover_source: 'forced', needs_attention: true });
    expect(row.flag_note).toContain('Bàn giao bắt buộc');
    expect(await packageLineRows(packageId)).toMatchObject([{ stock_deducted: true, unit_cost: '100000.00' }]);
  });

  it('store_only → before_cutoff, không phiếu, unit_cost null', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 100000);
    const { packageId } = await seedPackage(companyId, { status: 'in_transit', handoverSource: 'marketplace', lines: [{ variantId: v!, quantity: 2 }] });

    expect((await settle(companyId, packageId, 'store_only', null)).documents).toEqual([]);

    expect((await packageRow(packageId)).handover_source).toBe('before_cutoff');
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await packageLineRows(packageId)).toMatchObject([{ unit_cost: null, stock_deducted: false }]);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 5 });
  });

  it('defer → không đổi gì', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 5, 100000);
    const { packageId } = await seedPackage(companyId, { status: 'in_transit', handoverSource: 'marketplace', lines: [{ variantId: v!, quantity: 2 }] });

    expect((await settle(companyId, packageId, 'defer', null)).documents).toEqual([]);

    expect((await packageRow(packageId)).handover_source).toBe('marketplace');
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 5, reserved: 0 });
  });
});

describe('revertHandover: huỷ bàn giao nhầm', () => {
  it('phiếu DX, tồn cộng lại, dòng giữ hàng lại, kiện xoá mốc bàn giao, ghi người huỷ', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    const { packageId } = await seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: v!, quantity: 2, reserved: true }] });
    await settle(companyId, packageId);
    const ceo = randomUUID();

    const doc = await withCompany(companyId, async () => revertHandover((await lockPackage(packageId))!, ceo, 'Quét nhầm kiện'));

    expect(doc!.number).toMatch(/^DX-/);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 10, reserved: 2 });
    expect(await packageLineRows(packageId)).toMatchObject([{ reserved_qty: 2, stock_deducted: false, unit_cost: null }]);
    expect(await packageRow(packageId)).toMatchObject({
      status: 'awaiting_pickup',
      handover_source: null,
      handed_over_at: null,
      handed_over_by: null,
      pickup_confirmed_at: null,
      handover_reverted_by: ceo,
    });
  });
});

describe('settleDeferredHandovers: hàm bù khi phiếu kiểm kê đầu kỳ ghi sổ (#198)', () => {
  it('AC10: chờ kiểm kê, hai kiện rời kho trước và sau countedAt; gọi lần hai không đổi gì', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    const shopId = randomUUID();
    const countedAt = new Date('2026-11-05T00:00:00Z');
    const hour = 3_600_000;
    const seed = (at: Date) =>
      seedPackage(companyId, { status: 'in_transit', handoverSource: 'marketplace', handedOverAt: at, shopId, lines: [{ variantId: v!, quantity: 2 }] });
    const before = await seed(new Date(countedAt.getTime() - hour));
    const after = await seed(new Date(countedAt.getTime() + hour));

    expect(await withCompany(companyId, () => settleDeferredHandovers(shopId, countedAt))).toEqual({ deducted: 1, storedOnly: 1 });

    expect((await packageRow(before.packageId)).handover_source).toBe('before_cutoff');
    expect(await packageDocuments(before.packageId)).toEqual([]);
    expect(await packageDocuments(after.packageId)).toHaveLength(1);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 8 });

    expect(await withCompany(companyId, () => settleDeferredHandovers(shopId, countedAt))).toEqual({ deducted: 0, storedOnly: 0 });
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 8 });
  });
});

describe('shipLateMappedLines: dòng ghép SKU muộn (#237)', () => {
  async function shippedWithUnmapped() {
    const { companyId, variants: [a, b] } = await companyWithVariants(2);
    await receive(companyId, a!, 10, 100000);
    await receive(companyId, b!, 10, 30000);
    const seeded = await seedPackage(companyId, {
      status: 'in_transit',
      lines: [
        { variantId: a!, quantity: 1, reserved: true },
        { variantId: null, quantity: 2 },
      ],
    });
    await settle(companyId, seeded.packageId);
    await testPool().query('update "order".package_lines set variant_id = $2 where id = $1', [seeded.lineIds[1], b]);
    return { companyId, a: a!, b: b!, ...seeded };
  }

  it('AC11: kiện đã rời kho, gán SKU cho dòng chưa ghép → thêm một phiếu XK chỉ cho dòng đó', async () => {
    const { companyId, a, b, packageId } = await shippedWithUnmapped();

    const docs = await withCompany(companyId, () => shipLateMappedLines(packageId));

    expect(docs).toHaveLength(1);
    expect(await packageDocuments(packageId)).toHaveLength(2);
    expect(await stockOfVariant(companyId, a)).toMatchObject({ onHand: 9 });
    expect(await stockOfVariant(companyId, b)).toMatchObject({ onHand: 8 });
    expect(await packageLineRows(packageId)).toMatchObject([
      { stock_deducted: true, unit_cost: '100000.00' },
      { stock_deducted: true, unit_cost: '30000.00' },
    ]);
  });

  it('AC11: gọi shipLateMappedLines lần hai → không phiếu mới, tồn không đổi', async () => {
    const { companyId, b, packageId } = await shippedWithUnmapped();
    await withCompany(companyId, () => shipLateMappedLines(packageId));

    expect(await withCompany(companyId, () => shipLateMappedLines(packageId))).toEqual([]);
    expect(await packageDocuments(packageId)).toHaveLength(2);
    expect(await stockOfVariant(companyId, b)).toMatchObject({ onHand: 8 });
  });

  it('AC11: kiện before_cutoff hoặc chưa rời kho → không làm gì', async () => {
    const { companyId, variants: [v] } = await companyWithVariants();
    await receive(companyId, v!, 10, 100000);
    const old = await seedPackage(companyId, { status: 'delivered', handoverSource: 'before_cutoff', lines: [{ variantId: v!, quantity: 1 }] });
    const waiting = await seedPackage(companyId, { status: 'reserved', lines: [{ variantId: v!, quantity: 1 }] });

    expect(await withCompany(companyId, () => shipLateMappedLines(old.packageId))).toEqual([]);
    expect(await withCompany(companyId, () => shipLateMappedLines(waiting.packageId))).toEqual([]);
    expect(await packageDocuments(old.packageId)).toEqual([]);
    expect(await stockOfVariant(companyId, v!)).toMatchObject({ onHand: 10 });
  });
});
