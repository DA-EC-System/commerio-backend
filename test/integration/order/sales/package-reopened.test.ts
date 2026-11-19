// Kiện mở lại sau khi đơn hoàn tất (#236 PR 3, spec 5.5, D9): consumer `sales-package-reopened` giữ đơn `completed`,
// tính lại `outcome` theo kiện hiện tại, bật Cần xử lý khi kiện thật sự mở lại, không đè ghi chú của luồng khác (trừ note
// "trạng thái app chưa biết" của #358). Sự kiện giao bằng cách đọc outbox thật rồi gọi handler (`deliver`).
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';
import { UNKNOWN_STATUS_NOTE } from '#src/modules/order/sales/service/ingest.ts';
import { onPackageStatusChanged } from '#src/modules/order/sales/service/package-reopened.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { outboxOf, packageRow } from '../fulfillment/helpers.ts';
import { ingest, remote, setup, withStatus } from '../fulfillment/platform-fixtures.ts';

const app = () => request(testApp());

const orderRow = async (id: string) =>
  (
    await testPool().query<{
      status: string;
      outcome: string | null;
      needs_attention: boolean;
      attention_note: string | null;
      version: number;
      completed_at: Date;
    }>('select status, outcome, needs_attention, attention_note, version, completed_at from "order".orders where id = $1', [id])
  ).rows[0]!;

const packageCode = async (packageId: string) =>
  (await testPool().query<{ code: string }>('select code from "order".packages where id = $1', [packageId])).rows[0]!.code;

/** Đơn đã hoàn tất ở lượt trước (không chạy việc nền); `extra` đặt sẵn cờ, note. */
const markCompleted = (orderId: string, outcome: string, extra: { needsAttention?: boolean; note?: string } = {}) =>
  testPool().query(
    `update "order".orders set status = 'completed', outcome = $2, completed_at = now(), needs_attention = $3, attention_note = $4
     where id = $1`,
    [orderId, outcome, extra.needsAttention ?? false, extra.note ?? null],
  );

const maxOutboxId = async () =>
  Number((await testPool().query<{ id: string | null }>('select max(id) as id from core.outbox_messages')).rows[0]!.id ?? 0);

/** Giao cho handler mọi `package_status_changed` của đơn phát sau `afterId`, theo thứ tự outbox. */
async function deliver(companyId: string, orderId: string, afterId: number) {
  const { rows } = await testPool().query<{ payload: Parameters<typeof onPackageStatusChanged>[0]['payload']; created_at: Date }>(
    `select payload, created_at from core.outbox_messages
     where type = 'fulfillment.package_status_changed' and key = $1 and id > $2 order by id`,
    [orderId, afterId],
  );
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) await withCompany(companyId, () => onPackageStatusChanged({ payload: r.payload, occurredAt: r.created_at.toISOString() }));
}

/** Sự kiện tự dựng (ca không có đường thật sinh đúng sự kiện cần thử). */
const handle = (
  companyId: string,
  payload: { packageId: string; orderId: string; from: PackageStatus | null; to: PackageStatus },
  occurredAt: Date,
) => withCompany(companyId, () => onPackageStatusChanged({ payload, occurredAt: occurredAt.toISOString() }));

const statusChangedCount = async (orderId: string) => (await outboxOf(orderId, 'sales.order_status_changed')).length;

/** Kho A báo, kho B xác nhận thất lạc qua hai route (chép từ `platform-lost.test.ts`: helper dùng chung đang đóng băng). */
async function loseByUsers(companyId: string, packageId: string) {
  const a = await addMember(companyId, 'warehouse');
  const b = await addMember(companyId, 'warehouse');
  const version = async () => (await packageRow(packageId)).version;
  const reported = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/report-lost`)
    .set('Authorization', `Bearer ${a.token}`)
    .send({ version: await version(), claimCode: 'KN-777' });
  expect(reported.status).toBe(200);
  const confirmed = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/confirm-lost`)
    .set('Authorization', `Bearer ${b.token}`)
    .send({ version: await version() });
  expect(confirmed.status).toBe(200);
  return { a, b };
}

/** Đơn sàn một kiện đang giao (chép từ `platform-lost.test.ts`). */
async function inTransitOrder() {
  const s = await setup(10);
  const o = remote(s);
  const { orderId, packageId } = await ingest(s.companyId, o);
  await ingest(s.companyId, withStatus(o, 'in_transit'));
  expect((await packageRow(packageId)).status).toBe('in_transit');
  return { s, o, orderId, packageId };
}

/** Đơn đã hoàn tất với kết quả `none` vì kiện thất lạc do người xác nhận. */
async function completedLostOrder(extra: { needsAttention?: boolean; note?: string } = {}) {
  const r = await inTransitOrder();
  const { b } = await loseByUsers(r.s.companyId, r.packageId);
  await markCompleted(r.orderId, 'none', extra);
  return { ...r, warehouse: b };
}

describe('kiện mở lại sau hoàn tất (#236 PR 3, 5.5)', () => {
  it('AC25: đơn completed, kiện lost do người xác nhận, sàn báo đã giao → giữ completed, cờ bật, outcome none → full', async () => {
    const { s, o, orderId } = await completedLostOrder();
    const after = await maxOutboxId();
    await ingest(s.companyId, withStatus(o, 'delivered'));
    await deliver(s.companyId, orderId, after);
    expect(await orderRow(orderId)).toMatchObject({
      status: 'completed',
      needs_attention: true,
      outcome: 'full',
      attention_note: 'Sàn báo lại kiện đã thất lạc hoặc đang hoàn',
    });
  });

  it('AC25a: sàn báo in_transit rồi delivered → sau bước 1 cờ bật, outcome none; sau bước 2 outcome full', async () => {
    const { s, o, orderId } = await completedLostOrder();
    let after = await maxOutboxId();
    await ingest(s.companyId, withStatus(o, 'in_transit'));
    await deliver(s.companyId, orderId, after);
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: true, outcome: 'none' });
    after = await maxOutboxId();
    await ingest(s.companyId, withStatus(o, 'delivered'));
    await deliver(s.companyId, orderId, after);
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: true, outcome: 'full' });
  });

  /** Người dùng báo tìm thấy kiện thất lạc (`found`, như `receive-return.test.ts`). */
  async function found(packageId: string, token: string) {
    const res = await app()
      .post(`/api/v1/fulfillment/packages/${packageId}/found`)
      .set('Authorization', `Bearer ${token}`)
      .send({ version: (await packageRow(packageId)).version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }

  it('AC26: đơn completed, kiện lost, người dùng found → giữ completed, cờ bật kèm note mở lại, outcome giữ none', async () => {
    const { s, orderId, packageId, warehouse } = await completedLostOrder();
    const after = await maxOutboxId();
    await found(packageId, warehouse.token);
    await deliver(s.companyId, orderId, after);
    expect(await orderRow(orderId)).toMatchObject({
      status: 'completed',
      needs_attention: true,
      outcome: 'none',
      attention_note: `Kiện ${await packageCode(packageId)} đổi lost → ${(await packageRow(packageId)).status} sau khi đơn hoàn tất`,
    });
  });

  it('AC27: như 26, đơn đã có cờ với note của luồng khác → note giữ nguyên', async () => {
    const { s, orderId, packageId, warehouse } = await completedLostOrder({ needsAttention: true, note: 'Khách khiếu nại' });
    const after = await maxOutboxId();
    await found(packageId, warehouse.token);
    await deliver(s.companyId, orderId, after);
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: true, attention_note: 'Khách khiếu nại' });
  });

  it('AC27a: note UNKNOWN_STATUS_NOTE (#358) bị thay bằng note mở lại; lượt kéo sạch sau đó không gỡ cờ', async () => {
    const s = await setup(10);
    const o = withStatus(remote(s), 'delivered');
    const { orderId, packageId } = await ingest(s.companyId, o);
    await markCompleted(orderId, 'full', { needsAttention: true, note: `${UNKNOWN_STATUS_NOTE}: x` });
    const { completed_at } = await orderRow(orderId);
    await handle(s.companyId, { packageId, orderId, from: 'lost', to: 'delivered' }, new Date(completed_at.getTime() + 1000));
    const note = `Kiện ${await packageCode(packageId)} đổi lost → delivered sau khi đơn hoàn tất`;
    expect(await orderRow(orderId)).toMatchObject({ needs_attention: true, attention_note: note });
    await ingest(s.companyId, o);
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: true, attention_note: note });
  });

  /** Đơn sàn một kiện đã giao, đánh dấu hoàn tất với kết quả `none` (cố ý lệch kiện hiện tại). */
  async function completedDeliveredOrder() {
    const s = await setup(10);
    const { orderId, packageId } = await ingest(s.companyId, withStatus(remote(s), 'delivered'));
    await markCompleted(orderId, 'none');
    return { companyId: s.companyId, orderId, packageId, completedAt: (await orderRow(orderId)).completed_at };
  }

  it('AC28: sự kiện từ trạng thái dừng xảy ra trước completed_at, mọi kiện hiện đã dừng → không bật cờ, outcome theo kiện hiện tại', async () => {
    const { companyId, orderId, packageId, completedAt } = await completedDeliveredOrder();
    await handle(companyId, { packageId, orderId, from: 'lost', to: 'delivered' }, new Date(completedAt.getTime() - 60_000));
    expect(await orderRow(orderId)).toMatchObject({ status: 'completed', needs_attention: false, attention_note: null, outcome: 'full' });
  });

  it('AC29: cùng sự kiện hai lần → lần hai không ghi, không phát', async () => {
    const { companyId, orderId, packageId, completedAt } = await completedDeliveredOrder();
    const event = { packageId, orderId, from: 'lost', to: 'delivered' } as const;
    const occurredAt = new Date(completedAt.getTime() + 1000);
    await handle(companyId, event, occurredAt);
    const first = await orderRow(orderId);
    const events = await statusChangedCount(orderId);
    expect(first).toMatchObject({ needs_attention: true, outcome: 'full' });
    await handle(companyId, event, occurredAt);
    expect((await orderRow(orderId)).version).toBe(first.version);
    expect(await statusChangedCount(orderId)).toBe(events);
  });

  it('Review Focus 3: sự kiện của đơn không thấy được → bỏ qua, không lỗi', async () => {
    const { companyId } = await setup(null);
    await expect(handle(companyId, { packageId: randomUUID(), orderId: randomUUID(), from: 'lost', to: 'delivered' }, new Date())).resolves.toBeUndefined();
  });

  it('Review Focus 4: kiện chưa dừng, sự kiện from null, đơn completed → cờ bật, note "mới"', async () => {
    const { s, orderId, packageId } = await inTransitOrder();
    await markCompleted(orderId, 'none');
    await handle(s.companyId, { packageId, orderId, from: null, to: 'in_transit' }, new Date());
    expect(await orderRow(orderId)).toMatchObject({
      status: 'completed',
      needs_attention: true,
      attention_note: `Kiện ${await packageCode(packageId)} đổi mới → in_transit sau khi đơn hoàn tất`,
    });
  });

  it('đơn chưa hoàn tất (processing) → consumer bỏ qua', async () => {
    const { s, orderId, packageId } = await inTransitOrder();
    const before = await orderRow(orderId);
    await handle(s.companyId, { packageId, orderId, from: 'lost', to: 'in_transit' }, new Date());
    expect(await orderRow(orderId)).toMatchObject({ status: 'processing', version: before.version, needs_attention: false });
  });
});
