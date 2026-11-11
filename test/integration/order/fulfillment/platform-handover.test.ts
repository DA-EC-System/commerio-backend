import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lockPackage, updatePackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleHandover } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { invariantBroken, packageDocuments, packageLineRows, packageRow, stockOfVariant } from './helpers.ts';
import { ingest, remote, setup, withStatus } from './platform-fixtures.ts';

describe('đồng bộ sàn trừ tồn qua lõi bàn giao (spec 199a §5.4)', () => {
  it('AC7 US-DH-10.2: kiện reserved, sàn báo in_transit → trừ đúng một lần, marketplace, có pickup_confirmed_at', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'in_transit'));

    const row = await packageRow(packageId);
    expect(row).toMatchObject({ status: 'in_transit', handover_source: 'marketplace' });
    expect(row.pickup_confirmed_at).not.toBeNull();
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await packageLineRows(packageId)).toMatchObject([{ stock_deducted: true, unit_cost: '100000.00' }]);
  });

  it('AC7: kiện reserved, sàn báo delivered → trừ đúng một lần', async () => {
    const s = await setup(10);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);

    await ingest(s.companyId, withStatus(o, 'delivered'));
    await ingest(s.companyId, withStatus(o, 'delivered'));

    expect((await packageRow(packageId)).status).toBe('delivered');
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 8, reserved: 0 });
  });

  it('AC8 D2-31: kiện backordered, sàn báo in_transit, đủ khả dụng → giữ rồi ship thường, không Tồn âm', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('backordered');
    await receive(s.companyId, s.variantId, 5, 100000);

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.note)).toEqual([null]);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 3, reserved: 0 });
    expect(await invariantBroken(s.companyId, s.variantId)).toBe(false);
  });

  it('AC8 D2-31: kiện backordered, sàn báo in_transit, thiếu khả dụng → bàn giao bắt buộc, Tồn âm', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);
    await receive(s.companyId, s.variantId, 1, 100000);

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'forced', needs_attention: true });
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: -1 });
    expect(await invariantBroken(s.companyId, s.variantId)).toBe(true);
  });

  it('AC9: kiện lần đầu thấy đã in_transit, đơn đặt trước mốc → before_cutoff, không phiếu', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { packageId } = await ingest(
      s.companyId,
      remote(s, { status: 'in_transit', placedAt: new Date(cutoff.getTime() - 60_000), orderCutoffAt: cutoff }),
    );

    expect((await packageRow(packageId)).handover_source).toBe('before_cutoff');
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await packageLineRows(packageId)).toMatchObject([{ unit_cost: null, stock_deducted: false }]);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 10 });
  });

  it('AC9: kiện lần đầu thấy đã in_transit, đơn đặt sau mốc → trừ tồn', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { packageId } = await ingest(
      s.companyId,
      remote(s, { status: 'in_transit', placedAt: new Date(cutoff.getTime() + 60_000), orderCutoffAt: cutoff }),
    );

    expect((await packageRow(packageId)).handover_source).toBe('marketplace');
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9 });
  });

  it('AC3: kiện kho đã quét, sàn báo in_transit rồi delivered → chỉ ghi pickup_confirmed_at, không phiếu mới', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    // Giả lập kho quét bằng lõi (route có ở test hand-over).
    await withCompany(s.companyId, async () => {
      const pkg = (await lockPackage(packageId))!;
      await updatePackage(packageId, { status: 'in_transit', handoverSource: 'scan', handedOverAt: new Date() });
      await settleHandover(pkg, { actorId: randomUUID(), mode: 'deduct' });
    });

    await ingest(s.companyId, withStatus(o, 'in_transit'));
    const confirmed = (await packageRow(packageId)).pickup_confirmed_at;
    expect(confirmed).not.toBeNull();

    await ingest(s.companyId, withStatus(o, 'delivered'));
    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'scan', pickup_confirmed_at: confirmed });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
  });

  it('review cuối #1: kho đã quét mà sàn còn báo awaiting_pickup → kiện giữ in_transit, không cờ, không lịch sử mới; sàn báo in_transit sau đó chỉ ghi pickup_confirmed_at', async () => {
    const s = await setup(10);
    const o = remote(s, { status: 'awaiting_pickup' });
    const { packageId } = await ingest(s.companyId, o);
    await withCompany(s.companyId, async () => {
      const pkg = (await lockPackage(packageId))!;
      await updatePackage(packageId, { status: 'in_transit', handoverSource: 'scan', handedOverAt: new Date() });
      await settleHandover(pkg, { actorId: randomUUID(), mode: 'deduct' });
    });
    const transitions = async () =>
      (await testPool().query('select count(*)::int as n from core.state_transitions where entity_id = $1', [packageId])).rows[0].n;
    const before = await transitions();

    await ingest(s.companyId, o);

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'scan', needs_attention: false, pickup_confirmed_at: null });
    expect(await transitions()).toBe(before);

    await ingest(s.companyId, withStatus(o, 'in_transit'));
    const row = await packageRow(packageId);
    expect(row).toMatchObject({ status: 'in_transit', handover_source: 'scan' });
    expect(row.pickup_confirmed_at).not.toBeNull();
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
  });

  it('review cuối #1: kiện sàn đã báo rời kho, sàn lại báo awaiting_pickup → cờ Cần xử lý, trạng thái và tồn giữ nguyên', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));

    await ingest(s.companyId, withStatus(o, 'awaiting_pickup'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace', needs_attention: true });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9 });
  });

  it('AC10: gian hàng chờ kiểm kê (holdStock false), sàn báo in_transit → chưa trừ, handover_source marketplace', async () => {
    const s = await setup(10);
    const o = remote(s, { holdStock: false });
    const { packageId } = await ingest(s.companyId, o);

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 10, reserved: 0 });
  });

  it('Review Focus 2: sàn nhảy cóc kiện có một dòng chưa ghép SKU → chỉ trừ dòng đã ghép', async () => {
    const s = await setup(10);
    const o = remote(s, { unmapped: 1 });
    const { packageId } = await ingest(s.companyId, o);

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect((await packageRow(packageId)).status).toBe('in_transit');
    const lines = await packageLineRows(packageId);
    expect(lines.map((l) => l.stock_deducted).sort()).toEqual([false, true]);
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9 });
  });
});
