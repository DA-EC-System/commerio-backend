import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import { ingestMarketplaceOrder, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { outboxOf, packageDocuments, packageRow, stockOfVariant, transitionsOf } from './helpers.ts';
import { ingest, remote, setup, withStatus } from './platform-fixtures.ts';

// Sàn báo mất, sàn kéo lại kiện do người chuyển tay (spec #238 §5.4; AC7, AC8, AC9, AC11b).

const app = () => request(testApp());

const lostEvents = async (orderId: string) =>
  (await outboxOf(orderId, 'fulfillment.package_lost')).map((e) => EVENT_SCHEMAS['fulfillment.package_lost'].parse(e));

const orderRow = async (orderId: string) =>
  (
    await testPool().query<{ status: string; needs_attention: boolean; attention_note: string | null }>(
      'select status, needs_attention, attention_note from "order".orders where id = $1',
      [orderId],
    )
  ).rows[0]!;

const ingestResult = (companyId: string, o: PlatformOrder) => withCompany(companyId, () => ingestMarketplaceOrder(o));

/** Kho A báo, kho B xác nhận qua hai route (lịch sử ghi `source = 'user'`). */
async function loseByUsers(companyId: string, packageId: string, claimCode = 'KN-777') {
  const a = await addMember(companyId, 'warehouse');
  const b = await addMember(companyId, 'warehouse');
  const version = async () => (await packageRow(packageId)).version;
  const reported = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/report-lost`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({ version: await version(), claimCode });
  expect(reported.status).toBe(200);
  const confirmed = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/confirm-lost`)
    .set('Authorization', `Bearer ${b.token}`)
    .send({ version: await version() });
  expect(confirmed.status).toBe(200);
  return { a, b };
}

/** Đơn sàn một kiện đã đang giao (sàn báo bàn giao, tồn đã trừ). */
async function inTransitOrder() {
  const s = await setup(10);
  const o = remote(s);
  const { orderId, packageId } = await ingest(s.companyId, o);
  await ingest(s.companyId, withStatus(o, 'in_transit'));
  expect((await packageRow(packageId)).status).toBe('in_transit');
  return { s, o, orderId, packageId };
}

describe('sàn báo mất (spec #238 §5.4)', () => {
  it('AC7: sàn báo lost cho kiện in_transit: lost, lost_source marketplace, lịch sử platform_lost, package_lost với claimCode null', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    const before = await stockOfVariant(s.companyId, s.variantId);

    await ingest(s.companyId, withStatus(o, 'lost'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace', lost_confirmed_by: null, needs_attention: false });
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ action: 'platform_lost', from_state: 'in_transit', to_state: 'lost', source: 'marketplace' });
    expect(await lostEvents(orderId)).toEqual([{ packageId, orderId, claimCode: null }]);
    expect(await outboxOf(orderId, 'fulfillment.package_status_changed')).toContainEqual({ packageId, orderId, from: 'in_transit', to: 'lost' });
    expect(await stockOfVariant(s.companyId, s.variantId)).toEqual(before);
  });

  it('kho đã báo trước rồi sàn báo lost: package_lost mang mã khiếu nại của kho, báo cáo giữ nguyên', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    const a = await addMember(s.companyId, 'warehouse');
    const res = await app()
      .post(`/api/v1/fulfillment/packages/${packageId}/report-lost`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ version: (await packageRow(packageId)).version, claimCode: 'KN-KHO-1' });
    expect(res.status).toBe(200);

    await ingest(s.companyId, withStatus(o, 'lost'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace', lost_reported_by: a.accountId, lost_claim_code: 'KN-KHO-1' });
    expect(await lostEvents(orderId)).toEqual([{ packageId, orderId, claimCode: 'KN-KHO-1' }]);
  });

  it('Review 4: sàn báo lost hai lượt liên tiếp: lượt hai changed false, package_lost chỉ một bản ghi', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();

    expect((await ingestResult(s.companyId, withStatus(o, 'lost'))).changed).toBe(true);
    const version = (await packageRow(packageId)).version;
    expect((await ingestResult(s.companyId, withStatus(o, 'lost'))).changed).toBe(false);

    expect((await packageRow(packageId)).version).toBe(version);
    expect(await lostEvents(orderId)).toHaveLength(1);
  });

  it('AC11b (D18): kiện reserved mà sàn báo lost: lost, tồn trừ đúng một lần, lost_source marketplace, phát package_lost', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { orderId, packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('reserved');

    await ingest(s.companyId, withStatus(o, 'lost'));
    await ingest(s.companyId, withStatus(o, 'lost'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace', handover_source: 'marketplace', needs_attention: false });
    expect((await packageDocuments(packageId)).map((d) => d.kind)).toEqual(['shipment']);
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
    expect(await outboxOf(orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    expect(await lostEvents(orderId)).toEqual([{ packageId, orderId, claimCode: null }]);
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ action: 'platform_sync', from_state: 'reserved', to_state: 'lost' });
  });

  it('D18: kiện awaiting_pickup mà sàn báo lost: nhảy cóc platform_sync, không ghi lose', async () => {
    const s = await setup(10);
    const o = remote(s);
    const { packageId } = await ingest(s.companyId, o);
    await ingest(s.companyId, withStatus(o, 'awaiting_pickup'));
    expect((await packageRow(packageId)).status).toBe('awaiting_pickup');

    await ingest(s.companyId, withStatus(o, 'lost'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace' });
    expect((await transitionsOf(packageId)).map((t) => t.action)).not.toContain('lose');
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: 9, reserved: 0 });
  });

  it('D18: kiện backordered thiếu hàng mà sàn báo lost: lost, handover_source forced, cờ Cần xử lý', async () => {
    const s = await setup(null);
    const o = remote(s, { lines: 2 });
    const { orderId, packageId } = await ingest(s.companyId, o);
    expect((await packageRow(packageId)).status).toBe('backordered');
    await receive(s.companyId, s.variantId, 1, 100000);

    await ingest(s.companyId, withStatus(o, 'lost'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace', handover_source: 'forced', needs_attention: true });
    expect(await stockOfVariant(s.companyId, s.variantId)).toMatchObject({ onHand: -1 });
    expect(await lostEvents(orderId)).toHaveLength(1);
  });

  it('kiện lần đầu thấy đã lost: lost_source marketplace; đơn trước mốc bắt đầu lấy đơn thì không phát package_lost', async () => {
    const s = await setup(10);
    const after = await ingest(s.companyId, remote(s, { status: 'lost' }));
    expect(await packageRow(after.packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace' });
    expect(await lostEvents(after.orderId)).toEqual([{ packageId: after.packageId, orderId: after.orderId, claimCode: null }]);

    const before = await ingest(
      s.companyId,
      remote(s, { status: 'lost', placedAt: new Date('2026-10-01T00:00:00Z'), orderCutoffAt: new Date('2026-11-01T00:00:00Z') }),
    );
    expect(await packageRow(before.packageId)).toMatchObject({ status: 'lost', lost_source: 'marketplace', handover_source: 'before_cutoff' });
    expect(await lostEvents(before.orderId)).toEqual([]);
  });
});

describe('sàn kéo lại kiện do người chuyển tay (spec #238 §5.4, D2-33..36)', () => {
  it('AC8 (D2-35): kiện lost do người xác nhận, sàn báo delivered: delivered, cờ Cần xử lý, cột lost_* về null, đơn bật Cần xử lý', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    await loseByUsers(s.companyId, packageId);
    const before = await stockOfVariant(s.companyId, s.variantId);

    const result = await ingestResult(s.companyId, withStatus(o, 'delivered'));

    expect(result.changed).toBe(true);
    expect(await packageRow(packageId)).toMatchObject({
      status: 'delivered',
      needs_attention: true,
      flag_note: 'Sàn báo delivered sau khi người dùng chuyển lost',
      lost_reported_by: null,
      lost_reported_at: null,
      lost_claim_code: null,
      lost_confirmed_by: null,
      lost_source: null,
      lost_self_approved: false,
    });
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ action: 'platform_deliver', from_state: 'lost', to_state: 'delivered', source: 'marketplace' });
    expect(await outboxOf(orderId, 'fulfillment.package_delivered')).toHaveLength(1);
    expect(await stockOfVariant(s.companyId, s.variantId)).toEqual(before);
    expect(await orderRow(orderId)).toMatchObject({ status: 'processing', needs_attention: true, attention_note: 'Sàn báo lại kiện đã thất lạc hoặc đang hoàn' });
  });

  it('D2-33: kiện lost do người xác nhận, sàn báo in_transit: in_transit, lịch sử platform_in_transit', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    await loseByUsers(s.companyId, packageId);

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({
      status: 'in_transit', needs_attention: true, flag_note: 'Sàn báo in_transit sau khi người dùng chuyển lost', lost_reported_by: null, lost_source: null,
    });
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ action: 'platform_in_transit', from_state: 'lost', to_state: 'in_transit' });
    expect((await orderRow(orderId)).needs_attention).toBe(true);
  });

  it('AC9: kiện lost do sàn báo, sàn báo in_transit: giữ lost, cờ Cần xử lý, revived false', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    await ingest(s.companyId, withStatus(o, 'lost'));

    await ingest(s.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({
      status: 'lost', needs_attention: true, flag_note: 'Sàn báo in_transit khi kiện đang lost', lost_source: 'marketplace',
    });
    expect((await transitionsOf(packageId)).at(-1)).toMatchObject({ action: 'platform_lost' });
    expect((await orderRow(orderId)).needs_attention).toBe(false);
  });

  it('đơn completed có kiện lost do người, sàn báo delivered: đơn vẫn completed, có cờ Cần xử lý', async () => {
    const { s, o, orderId, packageId } = await inTransitOrder();
    await loseByUsers(s.companyId, packageId);
    await testPool().query(`update "order".orders set status = 'completed', outcome = 'none' where id = $1`, [orderId]);

    await ingest(s.companyId, withStatus(o, 'delivered'));

    expect((await packageRow(packageId)).status).toBe('delivered');
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: true });
  });
});
