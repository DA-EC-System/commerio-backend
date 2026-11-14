import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import { updatePackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { settleDeferredHandovers } from '#src/modules/order/fulfillment/service/handover-stock.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { receive } from '../../product/inventory/helpers.ts';
import {
  channelShop,
  outboxOf,
  packageDocuments,
  packageLineRows,
  packageRow,
  seedPackage,
  stockOfVariant,
  transitionsOf,
} from './helpers.ts';

// Kho báo, người khác xác nhận kiện thất lạc (spec #238 §5.3, Documents/21 §19.2; AC 1 đến 6).

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let khoA: Awaited<ReturnType<typeof addMember>>;
let khoB: Awaited<ReturnType<typeof addMember>>;
let variantId: string;

beforeAll(async () => {
  company = await createCompany();
  khoA = await addMember(company.companyId, 'warehouse');
  khoB = await addMember(company.companyId, 'warehouse');
  ({ variantId } = await createVariant(company.companyId));
  await receive(company.companyId, variantId, 100, 100000);
});

const versionOf = async (id: string) => (await packageRow(id)).version;
const report = async (id: string, body: { version?: number; claimCode?: unknown } = {}, token = khoA.token) =>
  app()
    .post(`/api/v1/fulfillment/packages/${id}/report-lost`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: body.version ?? (await versionOf(id)), claimCode: 'claimCode' in body ? body.claimCode : 'KN-001' });
const confirm = async (id: string, body: { version?: number } = {}, token = khoB.token) =>
  app()
    .post(`/api/v1/fulfillment/packages/${id}/confirm-lost`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: body.version ?? (await versionOf(id)) });

/** Kiện đã bàn giao, đang đi (tồn đã trừ lúc bàn giao, giá vốn chốt). */
const inTransit = (companyId = company.companyId, v = variantId) =>
  seedPackage(companyId, { status: 'in_transit', lines: [{ variantId: v, quantity: 2, unitCost: '100000.00' }] });

const lostEvents = async (orderId: string) =>
  (await outboxOf(orderId, 'fulfillment.package_lost')).map((e) => EVENT_SCHEMAS['fulfillment.package_lost'].parse(e));

describe('POST /fulfillment/packages/:id/report-lost, confirm-lost (spec #238 §5.3)', () => {
  it('AC1: kho A báo, kiện giữ trạng thái, có cờ lost_reported và lostReport đủ người, giờ, mã', async () => {
    const p = await inTransit();
    const version = await versionOf(p.packageId);

    const res = await report(p.packageId, { claimCode: '  KN-123 ' });

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('in_transit');
    expect(pkg.flags).toContain('lost_reported');
    expect(pkg.lostReport).toMatchObject({ by: { id: khoA.accountId }, claimCode: 'KN-123' });
    expect(pkg.lostReport!.by.name).not.toBe('');
    expect(Date.parse(pkg.lostReport!.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(pkg.version).toBe(version + 1);
    expect(await transitionsOf(p.packageId)).toEqual([]);
    const { rows } = await testPool().query<{ actor_id: string; action: string; after: Record<string, unknown> }>(
      `select actor_id, action, after from core.audit_logs where entity_type = 'order.packages' and entity_id = $1`,
      [p.packageId],
    );
    expect(rows).toEqual([{ actor_id: khoA.accountId, action: 'update', after: { code: p.packageCode, lostReported: true, claimCode: 'KN-123' } }]);
  });

  it('AC2 (D2-26): kho B xác nhận, kiện lost, lost_source user, tồn không đổi, phát package_lost kèm claimCode', async () => {
    const p = await inTransit();
    await report(p.packageId);
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await confirm(p.packageId);

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('lost');
    expect(pkg.flags).not.toContain('lost_reported');
    expect(pkg.statusHistory.at(-1)).toMatchObject({
      from: 'in_transit', to: 'lost', by: { id: khoB.accountId }, source: 'user', reason: 'Mã khiếu nại KN-001', selfApproved: false,
    });
    expect(await packageRow(p.packageId)).toMatchObject({
      status: 'lost', lost_source: 'user', lost_confirmed_by: khoB.accountId, lost_reported_by: khoA.accountId, lost_self_approved: false,
    });
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(before);
    expect(await lostEvents(p.orderId)).toEqual([{ packageId: p.packageId, orderId: p.orderId, claimCode: 'KN-001' }]);
    expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toContainEqual({
      packageId: p.packageId, orderId: p.orderId, from: 'in_transit', to: 'lost',
    });
    expect((await transitionsOf(p.packageId)).at(-1)).toMatchObject({ action: 'lose', source: 'user' });
  });

  it('AC3 (D2-26p): kho A tự xác nhận trả 409 second_person_required', async () => {
    const p = await inTransit();
    await report(p.packageId);

    const res = await confirm(p.packageId, {}, khoA.token);

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/second_person_required');
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'in_transit', lost_confirmed_by: null });
  });

  it('AC3: CEO tự xác nhận được, lost_self_approved true, lịch sử selfApproved, có dòng nhật ký tự duyệt', async () => {
    const p = await inTransit();
    await report(p.packageId, {}, company.ceo.token);

    const res = await confirm(p.packageId, {}, company.ceo.token);

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.statusHistory.at(-1)).toMatchObject({ to: 'lost', selfApproved: true });
    const row = await packageRow(p.packageId);
    expect(row).toMatchObject({ status: 'lost', lost_source: 'user', lost_self_approved: true });
    expect(row.lost_confirmed_by).toBe(row.lost_reported_by);
    const { rows } = await testPool().query<{ after: Record<string, unknown> }>(
      `select after from core.audit_logs where entity_type = 'order.packages' and entity_id = $1 and after @> '{"selfApproved": true}'::jsonb`,
      [p.packageId],
    );
    expect(rows).toEqual([{ after: { code: p.packageCode, status: 'lost', action: 'lose', selfApproved: true } }]);
  });

  it('AC4: báo lần hai 409 already_reported; xác nhận khi chưa báo 409 not_reported; Admin, Sale 403', async () => {
    const reported = await inTransit();
    await report(reported.packageId);
    const again = await report(reported.packageId, {}, khoB.token);
    expect(again.status).toBe(409);
    expect(again.body.type).toBe('/problems/already_reported');

    const fresh = await inTransit();
    const notReported = await confirm(fresh.packageId);
    expect(notReported.status).toBe(409);
    expect(notReported.body.type).toBe('/problems/not_reported');

    for (const role of ['sale', 'admin'] as const) {
      const member = await addMember(company.companyId, role);
      const r = await report(fresh.packageId, {}, member.token);
      const c = await confirm(reported.packageId, {}, member.token);
      expect([r.status, c.status]).toEqual([403, 403]);
      expect([r.body.type, c.body.type]).toEqual(['/problems/forbidden', '/problems/forbidden']);
    }
    expect(await packageRow(fresh.packageId)).toMatchObject({ lost_reported_by: null });
    expect((await packageRow(reported.packageId)).status).toBe('in_transit');
  });

  it('AC5: báo kiện awaiting_pickup không có cờ Cần mở trả 409 not_awaiting_open', async () => {
    const p = await seedPackage(company.companyId, { status: 'awaiting_pickup', lines: [{ variantId, quantity: 1, reserved: true }] });

    const res = await report(p.packageId);

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/not_awaiting_open');
    expect(await packageRow(p.packageId)).toMatchObject({ lost_reported_by: null });
  });

  it('AC6 (D2-32): kiện packed đang chờ mở, A báo, B xác nhận: tồn thực và đang giữ giảm đúng số món một lần, handover_source scan, không có cờ pickup_unconfirmed, needs_open gỡ', async () => {
    const p = await seedPackage(company.companyId, { status: 'packed', needsOpen: true, lines: [{ variantId, quantity: 3, reserved: true }] });
    expect((await report(p.packageId)).status).toBe(200);
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await confirm(p.packageId);

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('lost');
    expect(pkg.flags).not.toContain('pickup_unconfirmed');
    expect(pkg.flags).not.toContain('needs_open');
    expect(pkg.openPurpose).toBeNull();
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 3, reserved: before.reserved - 3 });
    expect(await packageRow(p.packageId)).toMatchObject({
      status: 'lost', handover_source: 'scan', handed_over_by: khoB.accountId, pickup_confirmed_at: null, needs_open: false,
      open_purpose: null, lost_source: 'user', lost_confirmed_by: khoB.accountId,
    });
    expect((await packageRow(p.packageId)).handed_over_at).not.toBeNull();
    expect(await packageLineRows(p.packageId)).toMatchObject([{ stock_deducted: true, reserved_qty: 0, unit_cost: '100000.00' }]);
    expect(await outboxOf(p.orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    expect(await lostEvents(p.orderId)).toEqual([{ packageId: p.packageId, orderId: p.orderId, claimCode: 'KN-001' }]);
    expect((await transitionsOf(p.packageId)).at(-1)).toMatchObject({ action: 'lose_on_unload', from_state: 'packed', to_state: 'lost' });

    // Gửi lại: kiện đã lost, không trừ thêm.
    const again = await confirm(p.packageId, {}, khoB.token);
    expect(again.status).toBe(409);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 3, reserved: before.reserved - 3 });
  });

  it('báo kiện reserved trả 409 invalid_transition kèm current', async () => {
    const p = await seedPackage(company.companyId, { status: 'reserved', lines: [{ variantId, quantity: 1, reserved: true }] });

    const res = await report(p.packageId);

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(Package.parse(res.body.current).status).toBe('reserved');
  });

  it('version lệch trả 409 version_conflict kèm current', async () => {
    const p = await inTransit();
    const version = await versionOf(p.packageId);

    const stale = await report(p.packageId, { version: version + 3 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');
    expect(Package.parse(stale.body.current).version).toBe(version);

    await report(p.packageId, { version });
    const staleConfirm = await confirm(p.packageId, { version });
    expect(staleConfirm.status).toBe(409);
    expect(staleConfirm.body.type).toBe('/problems/version_conflict');
    expect(Package.parse(staleConfirm.body.current).version).toBe(version + 1);
    expect((await packageRow(p.packageId)).status).toBe('in_transit');
  });

  it('Review 1: sàn đưa kiện sang delivered sau khi báo, xác nhận trả 409 not_reported và tồn không đổi', async () => {
    const p = await inTransit();
    await report(p.packageId);
    await withCompany(company.companyId, () => updatePackage(p.packageId, { status: 'delivered', deliveredAt: new Date() }));
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await confirm(p.packageId);

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/not_reported');
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(before);
    expect((await packageRow(p.packageId)).status).toBe('delivered');
  });

  it('Review 2: lose_on_unload ở gian hàng chờ kiểm kê: kiện lost, tồn chưa trừ; settleDeferredHandovers sau đó trừ đúng một lần', async () => {
    const own = await createCompany();
    const a = await addMember(own.companyId, 'warehouse');
    const b = await addMember(own.companyId, 'warehouse');
    const { variantId: v } = await createVariant(own.companyId);
    await receive(own.companyId, v, 5, 100000);
    const shopId = await channelShop(own.companyId, true);
    const countedAt = new Date(Date.now() - 60_000);
    const p = await seedPackage(own.companyId, { status: 'packed', needsOpen: true, shopId, lines: [{ variantId: v, quantity: 2 }] });
    expect((await report(p.packageId, {}, a.token)).status).toBe(200);
    const before = await stockOfVariant(own.companyId, v);

    const res = await confirm(p.packageId, {}, b.token);

    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('lost');
    expect(await stockOfVariant(own.companyId, v)).toEqual(before);
    expect(await packageLineRows(p.packageId)).toMatchObject([{ stock_deducted: false }]);

    expect(await withCompany(own.companyId, () => settleDeferredHandovers(shopId, countedAt))).toMatchObject({ deducted: 1 });
    expect(await stockOfVariant(own.companyId, v)).toMatchObject({ onHand: before.onHand - 2, reserved: before.reserved });
    await withCompany(own.companyId, () => settleDeferredHandovers(shopId, countedAt));
    expect(await stockOfVariant(own.companyId, v)).toMatchObject({ onHand: before.onHand - 2 });
    expect(await packageLineRows(p.packageId)).toMatchObject([{ stock_deducted: true }]);
  });

  it('Review 3: lose_on_unload kiện có dòng chưa ghép SKU: 200, phiếu xuất chỉ gồm dòng đã ghép', async () => {
    const p = await seedPackage(company.companyId, {
      status: 'awaiting_pickup',
      needsOpen: true,
      lines: [
        { variantId, quantity: 1, reserved: true },
        { variantId: null, quantity: 1 },
      ],
    });
    await report(p.packageId);
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await confirm(p.packageId);

    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('lost');
    const docs = await packageDocuments(p.packageId);
    expect(docs).toHaveLength(1);
    const { rows } = await testPool().query<{ variant_id: string; quantity: number }>(
      'select variant_id, quantity from product.stock_document_lines where document_id = $1',
      [docs[0]!.id],
    );
    expect(rows).toEqual([{ variant_id: variantId, quantity: 1 }]);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 1 });
  });

  it('Review 5: claimCode toàn khoảng trắng và 101 ký tự trả 422 validation_failed; 100 ký tự qua', async () => {
    const p = await inTransit();

    for (const claimCode of ['   ', 'x'.repeat(101), undefined]) {
      const res = await report(p.packageId, { claimCode });
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/validation_failed');
      expect(res.body.errors).toHaveProperty('claimCode');
    }
    const ok = await report(p.packageId, { claimCode: 'y'.repeat(100) });
    expect(ok.status).toBe(200);
    expect(Package.parse(ok.body).lostReport?.claimCode).toBe('y'.repeat(100));
  });

  it('hai người xác nhận cùng lúc: một 200, một 409 invalid_transition', async () => {
    const p = await inTransit();
    await report(p.packageId);
    const version = await versionOf(p.packageId);
    const khoC = await addMember(company.companyId, 'warehouse');

    const [x, y] = await raceBehindLock(
      (holder) => holder.query('select id from "order".packages where id = $1 for update', [p.packageId]),
      2,
      () => Promise.all([confirm(p.packageId, { version }), confirm(p.packageId, { version }, khoC.token)]),
    );

    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.type).toBe('/problems/invalid_transition');
    expect(await lostEvents(p.orderId)).toHaveLength(1);
  });

  it('đơn đang huỷ, kiện packed chờ mở để huỷ không thấy khi dỡ: A báo, B xác nhận → 200, kiện lost, tồn trừ một lần (spec #238 mục 10)', async () => {
    const p = await seedPackage(company.companyId, {
      status: 'packed',
      needsOpen: true,
      cancelling: true,
      lines: [{ variantId, quantity: 2, reserved: true }],
    });
    expect((await report(p.packageId)).status).toBe(200);
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await confirm(p.packageId);

    expect(res.status).toBe(200);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'lost', needs_open: false, open_purpose: null, handover_source: 'scan' });
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 2, reserved: before.reserved - 2 });
    expect(await outboxOf(p.orderId, 'fulfillment.package_shipped')).toHaveLength(1);
    // 25 §8.2: có kiện hoá ra đã bàn giao thì đơn không sang `cancelled`. Cờ của đơn (`cancelling` còn bật,
    // `platform_cancelled` chỉ bật ở lượt kéo đơn sau) lệch §8.2, chưa khẳng định: chờ Khang quyết phần sales.
    const { rows } = await testPool().query<{ status: string }>('select status from "order".orders where id = $1', [p.orderId]);
    expect(rows[0]!.status).toBe('processing');
  });

  it('kiện công ty khác và id sai dạng trả 404', async () => {
    const other = await createCompany();
    const foreign = await inTransit(other.companyId, (await createVariant(other.companyId)).variantId);

    for (const id of [foreign.packageId, 'khong-phai-uuid', randomUUID()]) {
      const r = await report(id, { version: 0 });
      const c = await confirm(id, { version: 0 });
      expect([r.status, c.status]).toEqual([404, 404]);
      expect([r.body.type, c.body.type]).toEqual(['/problems/not_found', '/problems/not_found']);
    }
    expect(await packageRow(foreign.packageId)).toMatchObject({ lost_reported_by: null });
  });
});
