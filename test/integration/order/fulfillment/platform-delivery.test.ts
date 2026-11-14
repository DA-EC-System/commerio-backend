import { describe, expect, it, vi } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import type { PackageEvent } from '#src/modules/order/fulfillment/index.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { outboxOf, packageDocuments, packageRow, stockOfVariant, transitionReasonsOf, transitionsOf } from './helpers.ts';
import { ingest, remote, setup, withCancel, withEvents, withShipping, withStatus } from './platform-fixtures.ts';

const DELIVERED = EVENT_SCHEMAS['fulfillment.package_delivered'];
const FAILED = EVENT_SCHEMAS['fulfillment.package_delivery_failed'];
// Mốc trace trong quá khứ so với giờ thật để `journeyTimes` không kẹp lại `now` (mặc định là giờ đồng bộ).
const T = new Date('2026-01-10T09:00:00Z');
const T0 = new Date('2026-01-10T08:00:00Z');

const pkgTimes = async (id: string) =>
  (
    await testPool().query<{ status: string; handed_over_at: Date | null; pickup_confirmed_at: Date | null; delivered_at: Date | null }>(
      'select status, handed_over_at, pickup_confirmed_at, delivered_at from "order".packages where id = $1',
      [id],
    )
  ).rows[0]!;

const byPlatform = async (orderId: string, platformCode: string) =>
  (await testPool().query<{ id: string }>(`select id from "order".packages where order_id = $1 and platform_package_code = $2`, [orderId, platformCode])).rows[0]!;

const ev = (packageCode: string, status: PackageEvent['status'], at: Date, description: string | null = null): PackageEvent => ({
  packageCode,
  trackingCode: null,
  status,
  at,
  description,
});

describe('đồng bộ sàn: giao xong, giao thất bại (spec 199c §5.4)', () => {
  it('AC1 US-DH-10.1: in_transit → delivered, delivered_at theo trace, package_delivered đủ tiền', async () => {
    const s = await setup(10);
    const o = remote(s);
    const code = o.lines[0]!.packageCode!;
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withEvents(withStatus(o, 'delivered'), [ev(code, 'delivered', T)]));

    const times = await pkgTimes(packageId);
    expect(times.status).toBe('delivered');
    expect(times.delivered_at?.toISOString()).toBe(T.toISOString());
    const [hist] = (await transitionsOf(packageId)).filter((t) => t.to_state === 'delivered');
    expect(hist!.action).toBe('deliver');
    expect(hist!.source).toBe('marketplace');

    const payload = DELIVERED.parse((await outboxOf(orderId, 'fulfillment.package_delivered'))[0]!);
    expect(payload.deliveredAt).toBe(T.toISOString());
    expect(payload.lines[0]!.unitCost).toBe('100000.00');
  });

  it('AC1: mốc rời kho lấy sự kiện sớm nhất của trace', async () => {
    const s = await setup(10);
    const o = remote(s);
    const code = o.lines[0]!.packageCode!;
    const { packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withEvents(withStatus(o, 'in_transit'), [ev(code, 'in_transit', T0)]));
    const times = await pkgTimes(packageId);
    expect(times.handed_over_at?.toISOString()).toBe(T0.toISOString());
    expect(times.pickup_confirmed_at?.toISOString()).toBe(T0.toISOString());
  });

  it('AC2: đơn hai kiện, kiện giao sau mang ship "0.00"', async () => {
    const s = await setup(20);
    const o = remote(s, { lines: 2, packages: 2 });
    const c1 = o.lines[0]!.packageCode!;
    const c2 = o.lines[1]!.packageCode!;
    const oo = withShipping(o, { shippingFee: '15000.00', shippingFeeOriginal: '30000.00', shippingFeeDiscountPlatform: '12000.00' });
    const { orderId } = await ingest(s.companyId, oo);
    // Kiện 1 giao trước (mang ship cấp đơn), kiện 2 giao sau (ship "0.00").
    await ingest(s.companyId, withStatus(oo, 'delivered', c1));
    await ingest(s.companyId, withEvents(withStatus(oo, 'delivered', c2), [ev(c2, 'delivered', T)]));

    const payloads = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => DELIVERED.parse(p));
    expect(payloads).toHaveLength(2);
    const id1 = (await byPlatform(orderId, c1)).id;
    const id2 = (await byPlatform(orderId, c2)).id;
    const first = payloads.find((p) => p.packageId === id1)!;
    expect(first.shippingIncome).toBe('15000.00');
    expect(first.shippingCost).toBe('30000.00');
    expect(first.platformSubsidy).toBe('12000.00');
    const second = payloads.find((p) => p.packageId === id2)!;
    expect(second.shippingIncome).toBe('0.00');
    expect(second.shippingCost).toBe('0.00');
  });

  it('Review Focus 1: trace có sự kiện của hai kiện, mỗi kiện lấy đúng mốc của mình', async () => {
    const s = await setup(20);
    const o = remote(s, { lines: 2, packages: 2 });
    const c1 = o.lines[0]!.packageCode!;
    const c2 = o.lines[1]!.packageCode!;
    const { orderId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withEvents(withStatus(o, 'in_transit'), [ev(c1, 'in_transit', T0), ev(c2, 'in_transit', T)]));

    const p1 = await pkgTimes((await byPlatform(orderId, c1)).id);
    const p2 = await pkgTimes((await byPlatform(orderId, c2)).id);
    expect(p1.handed_over_at?.toISOString()).toBe(T0.toISOString());
    expect(p2.handed_over_at?.toISOString()).toBe(T.toISOString());
  });

  it('AC3: kéo lại cùng trạng thái không phát package_delivered lần hai', async () => {
    const s = await setup(10);
    const o = remote(s);
    const code = o.lines[0]!.packageCode!;
    const { orderId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withEvents(withStatus(o, 'delivered'), [ev(code, 'delivered', T)]));
    await ingest(s.companyId, withEvents(withStatus(o, 'delivered'), [ev(code, 'delivered', T)])); // kéo lại
    expect((await outboxOf(orderId, 'fulfillment.package_delivered')).length).toBe(1);
  });

  it('AC4: không có trace → delivered_at là giờ đồng bộ', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    const fake = new Date('2026-12-01T00:00:00Z');
    vi.useFakeTimers({ now: fake, toFake: ['Date'] });
    try {
      await ingest(s.companyId, withStatus(o, 'delivered'));
      const times = await pkgTimes(packageId);
      expect(times.delivered_at?.toISOString()).toBe(fake.toISOString());
      expect((await outboxOf(orderId, 'fulfillment.package_delivered')).length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AC5 US-DH-10.1: in_transit → delivery_failed, lý do theo trace; không trace thì câu mặc định', async () => {
    const s = await setup(10);
    const o = remote(s);
    const code = o.lines[0]!.packageCode!;
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));

    // Có trace: lý do từ sự kiện delivery_failed.
    await ingest(s.companyId, withEvents(withStatus(o, 'delivery_failed'), [ev(code, 'delivery_failed', T, 'Khách không nghe máy')]));
    expect(FAILED.parse((await outboxOf(orderId, 'fulfillment.package_delivery_failed'))[0]!).reason).toBe('Khách không nghe máy');
    expect((await transitionReasonsOf(packageId, 'delivery_failed'))[0]).toBe('Khách không nghe máy');

    // Không trace: câu mặc định.
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'delivery_failed'));
    const failed = await outboxOf(orderId, 'fulfillment.package_delivery_failed');
    expect(FAILED.parse(failed.slice(-1)[0]!).reason).toBe('Sàn báo giao không thành công');
  });

  it('Review Focus 2: sàn báo lại failed_delivery không phát lần hai, không thêm lịch sử', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'delivery_failed'));
    await ingest(s.companyId, withStatus(o, 'delivery_failed')); // kéo lại cùng trạng thái

    expect((await outboxOf(orderId, 'fulfillment.package_delivery_failed')).length).toBe(1);
    expect((await transitionsOf(packageId)).filter((t) => t.to_state === 'delivery_failed').length).toBe(1);
  });

  it('AC6: delivery_failed → in_transit → delivered: một package_delivered', async () => {
    const s = await setup(10);
    const o = remote(s);
    const code = o.lines[0]!.packageCode!;
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'delivery_failed'));
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withEvents(withStatus(o, 'delivered'), [ev(code, 'delivered', T)]));

    const times = await pkgTimes(packageId);
    expect(times.status).toBe('delivered');
    expect((await outboxOf(orderId, 'fulfillment.package_delivered')).length).toBe(1);
  });
});

const orderFlags = async (orderId: string) =>
  (
    await testPool().query<{ status: string; platform_cancelled: boolean; cancelling: boolean }>(
      'select status, platform_cancelled, cancelling from "order".orders where id = $1',
      [orderId],
    )
  ).rows[0]!;

describe('đồng bộ sàn: hoàn về, huỷ vì giao không thành, nhảy từ trước bàn giao (spec 199c §5.4)', () => {
  it('AC7 US-DH-10.1: sàn báo shipped_back → returning; shipped_back_success → vẫn returning, không phiếu KT, không package_returned', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'returning'));
    expect((await packageRow(packageId)).status).toBe('returning');

    await ingest(s.companyId, withStatus(o, 'returned'));
    expect(await packageRow(packageId)).toMatchObject({ status: 'returning', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await outboxOf(orderId, 'fulfillment.package_returned')).toEqual([]);
  });

  it('AC7: mọi món huỷ cancellation-failed Delivery trên kiện in_transit → returning; đơn vẫn processing, cờ platform_cancelled, không sales.order_cancelled', async () => {
    const s = await setup(10);
    const o = remote(s, { lines: 2 });
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withCancel(o, 'failed_delivery'));

    expect((await packageRow(packageId)).status).toBe('returning');
    expect(await orderFlags(orderId)).toMatchObject({ status: 'processing', platform_cancelled: true, cancelling: false });
    expect(await outboxOf(orderId, 'sales.order_cancelled')).toEqual([]);
    expect((await transitionsOf(packageId)).filter((t) => t.to_state === 'returning')).toMatchObject([{ action: 'return', source: 'marketplace' }]);
  });

  it('D2 + D5: kiện reserved, mọi món huỷ cancellation-failed Delivery → bù bàn giao (một phiếu XK) rồi returning; đơn vẫn processing, cờ platform_cancelled; kéo lại không trừ thêm', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, withCancel(o, 'failed_delivery'));
    await ingest(s.companyId, withCancel(o, 'failed_delivery'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'returning', handover_source: 'marketplace' });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    expect(await orderFlags(orderId)).toMatchObject({ status: 'processing', platform_cancelled: true, cancelling: false });
    expect(await outboxOf(orderId, 'sales.order_cancelled')).toEqual([]);
  });

  it('AC8 US-DH-10.2: kiện reserved, sàn báo failed_delivery → một phiếu XK, delivery_failed, có package_shipped, package_delivery_failed; kéo lại không trừ thêm', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, withStatus(o, 'delivery_failed'));
    await ingest(s.companyId, withStatus(o, 'delivery_failed'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivery_failed', handover_source: 'marketplace', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    const failed = await outboxOf(orderId, 'fulfillment.package_delivery_failed');
    expect(failed).toHaveLength(1);
    expect(FAILED.parse(failed[0]!).reason).toBe('Sàn báo giao không thành công');
  });

  it('AC8: kiện backordered thiếu hàng, sàn báo shipped_back → bàn giao bắt buộc rồi returning', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('backordered');
    await receive(s.companyId, s.variantId, 1, 100000);

    await ingest(s.companyId, withStatus(o, 'returning'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'returning', handover_source: 'forced', needs_attention: true });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: -1 });
  });

  it('AC8: kiện reserved, sàn báo lost → cờ Cần xử lý như cũ', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'lost'));
    expect(await packageRow(packageId)).toMatchObject({ status: 'reserved', needs_attention: true, flag_note: 'Sàn báo lost khi kiện đang reserved' });
    expect(await packageDocuments(packageId)).toEqual([]);
  });

  it.each([
    ['packed', 'delivery_failed'],
    ['awaiting_pickup', 'returning'],
  ] as const)('D5: kiện %s, sàn báo %s → một phiếu XK, package_shipped, kiện vào trạng thái sàn báo; kéo lại không trừ thêm', async (from, to) => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, from));
    expect((await packageRow(packageId)).status).toBe(from);

    await ingest(s.companyId, withStatus(o, to));
    await ingest(s.companyId, withStatus(o, to));

    expect(await packageRow(packageId)).toMatchObject({ status: to, handover_source: 'marketplace', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    expect(await outboxOf(orderId, 'fulfillment.package_delivery_failed')).toHaveLength(to === 'delivery_failed' ? 1 : 0);
    expect((await transitionsOf(packageId)).filter((t) => t.to_state === to)).toHaveLength(1);
  });

  it('kiện lần đầu thấy đã giao thất bại (kiện mới) → delivery_failed, trừ tồn một lần, package_delivery_failed và lịch sử mang lý do của trace', async () => {
    const s = await setup(10);
    const base = remote(s, { status: 'delivery_failed' });
    const code = base.lines[0]!.packageCode!;
    const o = withEvents(base, [ev(code, 'in_transit', T0), ev(code, 'delivery_failed', T, 'Khách hẹn giao lại')]);

    const { orderId, packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, o); // kéo lại cùng trạng thái

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivery_failed', handover_source: 'marketplace' });
    expect((await pkgTimes(packageId)).handed_over_at?.toISOString()).toBe(T0.toISOString());
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    const failed = (await outboxOf(orderId, 'fulfillment.package_delivery_failed')).map((p) => FAILED.parse(p));
    expect(failed).toEqual([{ packageId, orderId, reason: 'Khách hẹn giao lại' }]);
    expect(await transitionReasonsOf(packageId, 'delivery_failed')).toEqual(['Khách hẹn giao lại']);
  });

  it('AC9: kiện lần đầu thấy đã hoàn về, đơn đặt trước mốc → returned, before_cutoff, không phiếu KT, không package_returned', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { orderId, packageId } = await ingest(
      s.companyId,
      remote(s, { status: 'returned', placedAt: new Date(cutoff.getTime() - 60_000), orderCutoffAt: cutoff }),
    );

    expect(await packageRow(packageId)).toMatchObject({ status: 'returned', handover_source: 'before_cutoff' });
    expect(await packageDocuments(packageId)).toEqual([]);
    expect(await outboxOf(orderId, 'fulfillment.package_returned')).toEqual([]);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 10 });
  });

  it('AC9: kiện lần đầu thấy đã hoàn về, đơn đặt sau mốc → returning, có phiếu XK', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { packageId } = await ingest(
      s.companyId,
      remote(s, { status: 'returned', placedAt: new Date(cutoff.getTime() + 60_000), orderCutoffAt: cutoff }),
    );

    expect(await packageRow(packageId)).toMatchObject({ status: 'returning', handover_source: 'marketplace' });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9 });
  });

  it('AC10: kiện lần đầu thấy đã giao, đơn đặt trước mốc → package_delivered với unitCost null', async () => {
    const s = await setup(10);
    const cutoff = new Date('2026-11-05T00:00:00Z');
    const { orderId, packageId } = await ingest(
      s.companyId,
      remote(s, { status: 'delivered', placedAt: new Date(cutoff.getTime() - 60_000), orderCutoffAt: cutoff }),
    );

    expect(await packageRow(packageId)).toMatchObject({ status: 'delivered', handover_source: 'before_cutoff' });
    const payloads = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => DELIVERED.parse(p));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.lines).toMatchObject([{ variantId: s.variantId, quantity: 1, unitPrice: '100000.00', unitCost: null }]);
  });

  it('AC10: kiện có dòng chưa ghép giao xong → dòng đó variantId null, unitCost null', async () => {
    const s = await setup(10);
    const { orderId } = await ingest(s.companyId, remote(s, { status: 'delivered', unmapped: 1 }));

    const payloads = (await outboxOf(orderId, 'fulfillment.package_delivered')).map((p) => DELIVERED.parse(p));
    expect(payloads).toHaveLength(1);
    expect(payloads[0]!.lines).toEqual(
      expect.arrayContaining([
        { variantId: s.variantId, quantity: 1, unitPrice: '100000.00', unitCost: '100000.00' },
        { variantId: null, quantity: 1, unitPrice: '100000.00', unitCost: null },
      ]),
    );
  });

  it('AC14: kiện returned (kho quét trước), sàn báo shipped_back hay shipped_back_success → không đổi, không cờ', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await ingest(s.companyId, withStatus(o, 'returning'));
    // Kho quét nhận trước (route ở test receive-return): đưa kiện về `returned` bằng SQL.
    await testPool().query(`update "order".packages set status = 'returned' where id = $1`, [packageId]);
    const before = (await transitionsOf(packageId)).length;

    await ingest(s.companyId, withStatus(o, 'returning'));
    await ingest(s.companyId, withStatus(o, 'returned'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'returned', needs_attention: false });
    expect(await transitionsOf(packageId)).toHaveLength(before);
  });
});
