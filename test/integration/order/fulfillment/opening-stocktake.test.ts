import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { settleOpeningStocktake } from '#src/modules/order/index.ts';
import { DISMANTLE_NOTE } from '#src/modules/order/fulfillment/service/allocation.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import { deliverForReturn, type PackageEvent } from '#src/modules/order/fulfillment/index.ts';
import { channelShop, invariantBroken, outboxOf, packageDocuments, packageLineRows, packageRow, seedPackage } from './helpers.ts';
import { ingest, remote, withEvents } from './platform-fixtures.ts';

const HOUR = 3_600_000;

async function setup(stock: number) {
  const { companyId } = await createCompany();
  const { variantId: A, sku } = await createVariant(companyId);
  const shopId = await channelShop(companyId, true);
  if (stock > 0) await receive(companyId, A, stock, 100000);
  return { companyId, A, sku, shopId, countedAt: new Date(Date.now() - 2 * HOUR), documentId: randomUUID() };
}

/** Giao dịch thoát chờ kiểm kê của channel (#289): bỏ phiếu khỏi gian hàng rồi gọi fulfillment, cùng giao dịch. */
const exitAwaiting = (s: { companyId: string; shopId: string; documentId: string; countedAt: Date }) =>
  withCompany(s.companyId, async () => {
    await getDb().execute(
      sql`update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null, order_cutoff_at = ${s.countedAt} where id = ${s.shopId}`,
    );
    return settleOpeningStocktake({ shopId: s.shopId, documentId: s.documentId, countedAt: s.countedAt });
  });

describe('settleOpeningStocktake: phiếu kiểm kê đầu kỳ ghi sổ (spec 199b §5.5)', () => {
  it('AC11: bù kiện rời kho trước rồi mới phân hàng: kiện rời kho trừ thường, kiện awaiting_pickup chưa giữ được giữ, kiện backordered ở lại; có cause', async () => {
    const s = await setup(3);
    const k1 = await seedPackage(s.companyId, {
      status: 'in_transit',
      shopId: s.shopId,
      handoverSource: 'marketplace',
      handedOverAt: new Date(s.countedAt.valueOf() + HOUR),
      lines: [{ variantId: s.A, quantity: 2 }],
    });
    const k2 = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
    const k3 = await seedPackage(s.companyId, { status: 'backordered', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });

    expect(await exitAwaiting(s)).toEqual({ deducted: 1, storedOnly: 0, held: 1 });

    expect(await packageDocuments(k1.packageId)).toHaveLength(1);
    expect((await packageRow(k1.packageId)).handover_source).toBe('marketplace');
    expect(await invariantBroken(s.companyId, s.A)).toBe(false);
    expect((await packageRow(k2.packageId)).status).toBe('awaiting_pickup');
    expect((await packageLineRows(k2.packageId))[0]!.reserved_qty).toBe(1);
    expect((await packageRow(k3.packageId)).status).toBe('backordered');
    expect((await outboxOf(s.companyId, 'fulfillment.allocation_done')).at(-1)).toEqual({
      variantIds: [s.A],
      cause: { type: 'stocktake', documentId: s.documentId },
    });
  });

  it('AC12: kiện đã đóng không giữ được → Cần xử lý với DISMANTLE_NOTE', async () => {
    const s = await setup(1);
    const p = await seedPackage(s.companyId, { status: 'packed', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 2 }] });
    await exitAwaiting(s);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_attention: true, flag_note: DISMANTLE_NOTE });
  });

  it('AC13: không có gì để làm vẫn phát cause, variantIds rỗng; gọi lần hai không phiếu XK mới, không giữ thêm, phát lại cause', async () => {
    const s = await setup(0);
    const cause = { type: 'stocktake', documentId: s.documentId };
    expect(await exitAwaiting(s)).toEqual({ deducted: 0, storedOnly: 0, held: 0 });
    expect(await exitAwaiting(s)).toEqual({ deducted: 0, storedOnly: 0, held: 0 });
    expect(await outboxOf(s.companyId, 'fulfillment.allocation_done')).toEqual([
      { variantIds: [], cause },
      { variantIds: [], cause },
    ]);
  });

  describe('kho quét lúc chờ kiểm kê (spec 199b D7)', () => {
    const scan = async (token: string, id: string) =>
      request(testApp())
        .post('/api/v1/fulfillment/packages/hand-over')
        .set('Authorization', `Bearer ${token}`)
        .send({ packages: [{ id, version: (await packageRow(id)).version }] });

    it('AC14: kiện quét sau countedAt được trừ đúng một lần khi phiếu đầu kỳ ghi sổ; quét trước countedAt thành before_cutoff', async () => {
      const s = await setup(5);
      const kho = await addMember(s.companyId, 'warehouse');
      const after = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
      const before = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
      expect((await scan(kho.token, after.packageId)).status).toBe(200);
      expect((await scan(kho.token, before.packageId)).status).toBe(200);
      await testPool().query('update "order".packages set handed_over_at = $2 where id = $1', [before.packageId, new Date(s.countedAt.valueOf() - HOUR)]);

      expect(await exitAwaiting(s)).toMatchObject({ deducted: 1, storedOnly: 1 });

      expect(await packageDocuments(after.packageId)).toHaveLength(1);
      expect(await packageRow(before.packageId)).toMatchObject({ handover_source: 'before_cutoff' });
      expect(await packageDocuments(before.packageId)).toEqual([]);
      expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 0 });
      expect(await packageDocuments(after.packageId)).toHaveLength(1);
    });

    it('AC16: lần quét đua thoát chờ: thoát chờ giữ khoá gian hàng, lần quét đợi, commit xong thì kiện trừ ngay một lần, không còn kiện hoãn chưa bù', async () => {
      const s = await setup(5);
      const kho = await addMember(s.companyId, 'warehouse');
      const p = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });

      const res = await raceBehindLock(
        (holder) =>
          holder.query('update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null where id = $1', [s.shopId]),
        1,
        () => scan(kho.token, p.packageId),
      );

      expect(res.status).toBe(200);
      expect(res.body.handedOver[0].issue.number).toMatch(/^XK-/);
      expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 0 });
      expect(await packageDocuments(p.packageId)).toHaveLength(1);
    });
  });

  it('AC11: kiện hoãn trừ đã giao chưa phát; settleOpeningStocktake → phiếu XK rồi package_delivered có unitCost; gọi lại không phát thêm', async () => {
    const s = await setup(3);
    const o = { ...remote({ variantId: s.A, sku: s.sku }, { status: 'delivered', holdStock: false }), shopId: s.shopId };
    const code = o.lines[0]!.packageCode!;
    // Rời kho, giao sau lúc đếm (countedAt là 2 giờ trước, vẫn trong quá khứ so với giờ thật).
    const events: PackageEvent[] = [
      { packageCode: code, trackingCode: null, status: 'in_transit', at: new Date(s.countedAt.valueOf() + HOUR / 2), description: null },
      { packageCode: code, trackingCode: null, status: 'delivered', at: new Date(s.countedAt.valueOf() + HOUR), description: null },
    ];
    const { orderId, packageId } = await ingest(s.companyId, withEvents(o, events));
    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toEqual([]);

    expect(await exitAwaiting(s)).toMatchObject({ deducted: 1, storedOnly: 0 });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    const delivered = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => EVENT_SCHEMAS['fulfillment.package_delivered'].parse(p));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.lines).toMatchObject([{ variantId: s.A, unitCost: '100000.00' }]);
    expect(delivered[0]!.deliveredAt).toBe(events[1]!.at.toISOString());

    await exitAwaiting(s);
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toHaveLength(1);
    expect(await packageDocuments(packageId)).toHaveLength(1);
  });

  it('kiện hoãn trừ đang giao, sàn mở yêu cầu trả (deliverForReturn) → delivered nhưng chưa phát; settleOpeningStocktake → phiếu XK rồi đúng một package_delivered có unitCost', async () => {
    const s = await setup(3);
    const o = { ...remote({ variantId: s.A, sku: s.sku }, { status: 'in_transit', holdStock: false }), shopId: s.shopId };
    const events: PackageEvent[] = [
      { packageCode: o.lines[0]!.packageCode!, trackingCode: null, status: 'in_transit', at: new Date(s.countedAt.valueOf() + HOUR / 2), description: null },
    ];
    const { orderId, packageId } = await ingest(s.companyId, withEvents(o, events));
    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace' });
    expect(await packageDocuments(packageId)).toEqual([]);

    expect(await withCompany(s.companyId, () => deliverForReturn(packageId, 'Sàn mở yêu cầu trả'))).toBe('jumped');
    expect((await packageRow(packageId)).status).toBe('delivered');
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toEqual([]);

    expect(await exitAwaiting(s)).toMatchObject({ deducted: 1, storedOnly: 0 });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    const delivered = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => EVENT_SCHEMAS['fulfillment.package_delivered'].parse(p));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.lines).toMatchObject([{ variantId: s.A, unitCost: '100000.00' }]);

    await exitAwaiting(s);
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toHaveLength(1);
  });

  it('kiện hoãn trừ đã giao, rời kho trước lúc đếm → store_only: before_cutoff, không phiếu XK, package_delivered với unitCost null; gọi lại không phát thêm', async () => {
    const s = await setup(3);
    const o = { ...remote({ variantId: s.A, sku: s.sku }, { status: 'delivered', holdStock: false }), shopId: s.shopId };
    const code = o.lines[0]!.packageCode!;
    // Rời kho trước lúc đếm (kiểm kê đã tính hàng này), giao sau lúc đếm.
    const events: PackageEvent[] = [
      { packageCode: code, trackingCode: null, status: 'in_transit', at: new Date(s.countedAt.valueOf() - HOUR / 2), description: null },
      { packageCode: code, trackingCode: null, status: 'delivered', at: new Date(s.countedAt.valueOf() + HOUR), description: null },
    ];
    const { orderId, packageId } = await ingest(s.companyId, withEvents(o, events));
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toEqual([]);

    expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 1 });

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'before_cutoff' });
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toEqual([]);
    const delivered = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => EVENT_SCHEMAS['fulfillment.package_delivered'].parse(p));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.lines).toMatchObject([{ variantId: s.A, quantity: 1, unitCost: null }]);
    expect(delivered[0]!.deliveredAt).toBe(events[1]!.at.toISOString());

    expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toHaveLength(1);
  });

  it('review I1: lấy khoá phân hàng trước khi bù kiện hoãn (thứ tự khoá §5.10): đang chờ khoá thì chưa khoá kiện nào', async () => {
    const s = await setup(5);
    const k = await seedPackage(s.companyId, {
      status: 'in_transit',
      shopId: s.shopId,
      handoverSource: 'marketplace',
      handedOverAt: new Date(s.countedAt.valueOf() + HOUR),
      lines: [{ variantId: s.A, quantity: 1 }],
    });
    const holder = await testPool().connect();
    const probe = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`fulfillment.allocation:${s.companyId}`]);
      const pending = exitAwaiting(s);
      for (let i = 0; i < 200; i++) {
        const { rows } = await probe.query<{ n: number }>(
          `select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory' and pid <> pg_backend_pid()`,
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await probe.query('begin');
      await expect(probe.query('select id from "order".packages where id = $1 for update nowait', [k.packageId])).resolves.toBeDefined();
      await probe.query('rollback');
      await holder.query('commit');
      expect(await pending).toMatchObject({ deducted: 1 });
    } finally {
      await probe.query('rollback').catch(() => {});
      await holder.query('rollback').catch(() => {});
      holder.release();
      probe.release();
    }
  });
});
