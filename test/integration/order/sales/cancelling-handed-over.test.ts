// Đơn Đang huỷ có kiện hoá ra đã bàn giao (Documents/25 §8.2, dòng "processing (giữ nguyên, cờ Đang huỷ)" và đoạn "Sàn huỷ
// đơn khi đã có kiện bàn giao"): đơn mang cờ Sàn đã huỷ, tự sang `completed` khi mọi kiện đã dừng. Cờ Đang huỷ chỉ có
// nghĩa khi còn kiện chờ mở (#238 PR 1, spec mục 10).
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { completeDueOrdersOnce, type PlatformOrder } from '#src/modules/order/index.ts';
import { outcomeOf } from '#src/modules/order/sales/domain/order.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { packageRow } from '../fulfillment/helpers.ts';
import { ingest, remote, withStatus } from '../fulfillment/platform-fixtures.ts';

const app = () => request(testApp());
let companyId: string;
let khoA: Awaited<ReturnType<typeof addMember>>;
let khoB: Awaited<ReturnType<typeof addMember>>;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  khoA = await addMember(companyId, 'warehouse');
  khoB = await addMember(companyId, 'warehouse');
});

const orderRow = async (id: string) =>
  (
    await testPool().query<{ status: string; outcome: string | null; cancelling: boolean; platform_cancelled: boolean }>(
      'select status, outcome, cancelling, platform_cancelled from "order".orders where id = $1',
      [id],
    )
  ).rows[0]!;

const packagesOf = async (orderId: string) =>
  (await testPool().query<{ id: string; status: string; platform_package_code: string }>(
    'select id, status, platform_package_code from "order".packages where order_id = $1 order by platform_package_code',
    [orderId],
  )).rows;

/** Đơn sàn đã đóng gói (`packages` kiện), rồi sàn huỷ mọi món: kiện chờ mở, đơn Đang huỷ. */
async function cancellingOrder(packages = 1) {
  const v = await createVariant(companyId);
  await receive(companyId, v.variantId, packages, 100000);
  const o = remote(v, { status: 'packed', lines: packages, packages });
  const { orderId } = await ingest(companyId, o);
  const cancelled: PlatformOrder = withStatus(o, 'cancelled');
  await ingest(companyId, cancelled);
  expect(await orderRow(orderId)).toMatchObject({ status: 'processing', cancelling: true, platform_cancelled: false });
  return { orderId, cancelled, packages: await packagesOf(orderId) };
}

/** Kho A báo không thấy kiện khi dỡ, kho B xác nhận (`lose_on_unload`): kiện `lost`, tồn trừ một lần. */
async function loseOnUnload(packageId: string) {
  const version = async () => (await packageRow(packageId)).version;
  const reported = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/report-lost`)
    .set('Authorization', `Bearer ${khoA.token}`)
    .send({ version: await version(), claimCode: 'Không thấy kiện khi dỡ' });
  expect(reported.status, JSON.stringify(reported.body)).toBe(200);
  const confirmed = await app()
    .post(`/api/v1/fulfillment/packages/${packageId}/confirm-lost`)
    .set('Authorization', `Bearer ${khoB.token}`)
    .send({ version: await version() });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect((await packageRow(packageId)).status).toBe('lost');
}

describe('đơn Đang huỷ có kiện đã bàn giao (25 §8.2)', () => {
  it('kiện packed chờ mở bị xác nhận lose_on_unload, lượt kéo sau sàn vẫn báo huỷ: platform_cancelled = true, cancelling = false', async () => {
    const o = await cancellingOrder();
    await loseOnUnload(o.packages[0]!.id);

    await ingest(companyId, o.cancelled);

    expect(await orderRow(o.orderId)).toMatchObject({ status: 'processing', cancelling: false, platform_cancelled: true });
  });

  it('mọi kiện đã dừng: lượt tự hoàn tất đưa đơn sang completed, outcome theo outcomeOf, cancelling = false, không cần lượt kéo ở giữa', async () => {
    const o = await cancellingOrder();
    await loseOnUnload(o.packages[0]!.id);

    await completeDueOrdersOnce();

    expect(await orderRow(o.orderId)).toMatchObject({ status: 'completed', outcome: outcomeOf(['lost']), cancelling: false });
    const { rows } = await testPool().query(
      `select from_state, to_state, action, source from core.state_transitions where entity_type = 'orders' and entity_id = $1 order by id desc limit 1`,
      [o.orderId],
    );
    expect(rows[0]).toEqual({ from_state: 'processing', to_state: 'completed', action: 'complete', source: 'system' });
  });

  it('còn một kiện packed chờ mở và một kiện đã lost: không hoàn tất, cancelling giữ nguyên', async () => {
    const o = await cancellingOrder(2);
    expect(o.packages).toHaveLength(2);
    await loseOnUnload(o.packages[0]!.id);

    await completeDueOrdersOnce();
    expect(await orderRow(o.orderId)).toMatchObject({ status: 'processing', cancelling: true });

    // Lượt kéo sau: có kiện đã bàn giao nên bật Sàn đã huỷ, còn kiện chờ mở nên giữ Đang huỷ.
    await ingest(companyId, o.cancelled);
    expect(await orderRow(o.orderId)).toMatchObject({ status: 'processing', cancelling: true, platform_cancelled: true });
    await completeDueOrdersOnce();
    expect((await orderRow(o.orderId)).status).toBe('processing');
  });

  it('đơn Đang huỷ thường (chưa kiện nào bàn giao, còn kiện chờ mở): hành vi cũ không đổi', async () => {
    const o = await cancellingOrder();

    await ingest(companyId, o.cancelled);
    await completeDueOrdersOnce();

    expect(await orderRow(o.orderId)).toMatchObject({ status: 'processing', cancelling: true, platform_cancelled: false });
    expect(await packageRow(o.packages[0]!.id)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
  });
});
