import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { HandoverStockMode } from '#src/modules/order/fulfillment/domain/handover.ts';
import { lockPackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { revertHandover, settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { withCompany } from '#src/shared/db/client.ts';
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
