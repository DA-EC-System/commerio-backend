import { describe, expect, it, vi } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import type { PackageEvent } from '#src/modules/order/fulfillment/index.ts';
import { testPool } from '../../helpers/db.ts';
import { outboxOf, transitionReasonsOf, transitionsOf } from './helpers.ts';
import { ingest, remote, setup, withEvents, withShipping, withStatus } from './platform-fixtures.ts';

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
