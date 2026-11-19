// Mở kiện cũ chờ dỡ để chia lại, mở kiện `awaiting_pickup` giữ vận đơn (#238 PR 3, spec §5.6 "Mở kiện", D20, D24 đến
// D26). Cổng sàn giả `packingApp`: hàm sàn không truyền thì ném, nên route gọi sàn sai là 500.
import { describe, expect, it, vi } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import type { MarketplacePackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { CANCELLING_SQL, packageDocuments, packageRow, packingApp, stockOfVariant, transitionsOf } from './helpers.ts';
import { ingest, remote, withCancel, withLineCancelled, withStatus } from './platform-fixtures.ts';
import { external, historyCount, itemStatuses, lineRows, packagesOf, packedSplit, relabeled, setup, tag } from './resplit-fixtures.ts';

type Action = 'open' | 'pack' | 'ready' | 'report-lost' | 'confirm-lost';
const post = (token: string, id: string, action: Action, body: object, fake: Partial<MarketplacePackages> = {}) =>
  packingApp(fake).post(`/api/v1/fulfillment/packages/${id}/${action}`).set('Authorization', `Bearer ${token}`).send(body);
const versionOf = async (id: string) => (await packageRow(id)).version;

async function orderRow(orderId: string) {
  const { rows } = await testPool().query<{ status: string; cancelling: boolean }>(`select status, ${CANCELLING_SQL} as cancelling from "order".orders where id = $1`, [orderId]);
  return rows[0]!;
}

async function waybillOf(packageId: string) {
  const { rows } = await testPool().query<{
    status: string;
    platform_package_code: string | null;
    tracking_code: string | null;
    carrier_code: string | null;
    carrier_name: string | null;
    waybill_kept: boolean;
    needs_open: boolean;
  }>(
    `select status, platform_package_code, tracking_code, carrier_code, carrier_name, waybill_kept, needs_open
       from "order".packages where id = $1`,
    [packageId],
  );
  return rows[0]!;
}

async function allocationJobs(companyId: string, variantId: string) {
  const { rows } = await testPool().query<{ data: { variantIds: string[] } }>(
    `select data from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1 and data->'variantIds' ? $2`,
    [companyId, variantId],
  );
  return rows.map((r) => r.data.variantIds);
}

/** Kiện `awaiting_pickup` 2 món đã có vận đơn và ĐVVC; sàn huỷ món 2 nên kiện chờ mở vì `edit`. */
async function pickupEdited() {
  const v = await setup(10);
  const o = remote(v, { lines: 2, status: 'awaiting_pickup' });
  const { orderId, packageId } = await ingest(v.companyId, o);
  const tracking = `VD-${tag()}`;
  await testPool().query(`update "order".packages set tracking_code = $2, carrier_code = 'LEX', carrier_name = 'LEX VN' where id = $1`, [packageId, tracking]);
  await ingest(v.companyId, withLineCancelled(o, 1));
  expect(await packageRow(packageId)).toMatchObject({ status: 'awaiting_pickup', needs_open: true, open_purpose: 'edit' });
  return { v, o, orderId, packageId, tracking };
}

describe('mở kiện cũ chờ dỡ để chia lại (#238 §5.6, D24, D26)', () => {
  it('AC15: kho mở kiện cũ resplit (mọi dòng chờ bỏ): kiện cũ cancelled, không gọi repack, đơn không khép, 2 kiện thay reserved', async () => {
    const { v, orderId, packageId, a, b } = await packedSplit();

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(packageId)).toMatchObject({ status: 'cancelled', needs_open: false, open_purpose: null });
    expect(await transitionsOf(packageId)).toContainEqual({ action: 'open_cancel', from_state: 'packed', to_state: 'cancelled', source: 'user' });
    for (const p of [a, b]) {
      expect(await packageRow(p.id)).toMatchObject({ status: 'reserved' });
      expect((await lineRows(p.id)).map((l) => l.reserved)).toEqual([1]);
    }
    expect(await orderRow(orderId)).toEqual({ status: 'processing', cancelling: false });
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([10, 2]);
  });

  it('AC15: kiện thay của đơn giữ hàng trước kiện backordered của đơn khác cùng SKU', async () => {
    const v = await setup(0);
    // Đơn khác về trước, thiếu hàng: lượt phân hàng thường sẽ xét nó trước.
    const other = await ingest(v.companyId, remote(v, { lines: 1 }));
    await receive(v.companyId, v.variantId, 2, 100000);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    await ingest(v.companyId, itemStatuses(relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]), ['pending', 'pending']));
    expect((await packageRow(other.packageId)).status).toBe('backordered');

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const fresh = (await packagesOf(orderId)).filter((r) => r.replaces === packageId);
    expect(fresh.map((r) => r.status)).toEqual(['reserved', 'reserved']);
    expect((await packageRow(other.packageId)).status).toBe('backordered');
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
  });

  it('AC15: mở kiện packed resplit còn dòng (sàn giữ mã cũ): gọi repack một lần như kiện sửa, về reserved, dòng chờ bỏ xoá, kiện thay reserved', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    await ingest(v.companyId, itemStatuses(relabeled(o, [o.lines[0]!.packageCode, `FP-B-${tag()}`]), ['packed', 'pending']));
    const fresh = (await packagesOf(orderId)).find((r) => r.replaces === packageId)!;
    expect(fresh.status).toBe('backordered');
    // Gói cũ còn trên sàn với phần còn lại (đã đóng): đóng gói lại phải qua repack, không gọi `pack` trên gói đã đóng.
    const repack = vi.fn(async () => 'repacked' as const);

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) }, { repack });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(repack).toHaveBeenCalledTimes(1);
    expect(repack).toHaveBeenCalledWith(v.companyId, expect.any(String), o.lines[0]!.packageCode);
    expect(await waybillOf(packageId)).toMatchObject({ status: 'reserved', needs_open: false, platform_package_code: null, tracking_code: null, waybill_kept: false });
    expect(await packageRow(packageId)).toMatchObject({ open_purpose: null });
    expect(await lineRows(packageId)).toEqual([{ item: external(o, 0), reserved: 1, drop: 0 }]);
    expect(await packageRow(fresh.id)).toMatchObject({ status: 'reserved' });
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
    expect(await allocationJobs(v.companyId, v.variantId)).toEqual([[v.variantId]]);
  });

  it('Review 4: mở kiện cũ thì kiện thay toàn dòng không quản tồn về reserved (không còn gì để giữ, spec 237 D10)', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 1, untracked: 1, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const gift = `FP-Q-${tag()}`;
    await ingest(v.companyId, itemStatuses(relabeled(o, [`FP-A-${tag()}`, gift]), ['pending', 'pending']));
    const before = await packagesOf(orderId);
    expect(before.find((r) => r.platformCode === gift)).toMatchObject({ status: 'backordered' });

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await packagesOf(orderId);
    expect(after.filter((r) => r.replaces === packageId).map((r) => [r.platformCode === gift, r.status]).sort()).toEqual([
      [false, 'reserved'],
      [true, 'reserved'],
    ]);
  });

  it('Review 5: kéo lại ngay sau khi kho mở kiện cũ: không đổi kiện nào, không clear_code', async () => {
    const { v, orderId, packageId, next, o } = await packedSplit();
    expect((await post(v.token, packageId, 'open', { version: await versionOf(packageId) })).status).toBe(200);
    const before = await packagesOf(orderId);
    const history = await historyCount(orderId);

    await ingest(v.companyId, next);

    expect(await packagesOf(orderId)).toEqual(before);
    expect(await historyCount(orderId)).toBe(history);
    expect(before.find((r) => r.id === packageId)).toMatchObject({ status: 'cancelled', platformCode: o.lines[0]!.packageCode });
  });

  it('sàn huỷ cả đơn khi mọi món của kiện cũ đã sang kiện thay: kiện thay cancelled, kiện cũ chờ mở cancel, đơn Đang huỷ tới khi kho mở kiện cũ', async () => {
    const { v, orderId, packageId, next, a, b } = await packedSplit();

    await ingest(v.companyId, withCancel(next, 'cancellation'));

    for (const p of [a, b]) expect((await packageRow(p.id)).status).toBe('cancelled');
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
    expect(await orderRow(orderId)).toEqual({ status: 'processing', cancelling: true });
    const version = await versionOf(packageId);

    // Kéo lại: đơn vẫn Đang huỷ, kiện cũ không ghi lại.
    await ingest(v.companyId, withCancel(next, 'cancellation'));
    expect(await orderRow(orderId)).toEqual({ status: 'processing', cancelling: true });
    expect(await versionOf(packageId)).toBe(version);

    const res = await post(v.token, packageId, 'open', { version });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(packageId)).toMatchObject({ status: 'cancelled', needs_open: false });
    expect((await orderRow(orderId)).status).toBe('cancelled');
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(0);
  });
});

describe('mở kiện awaiting_pickup giữ vận đơn (#238 D25)', () => {
  it('kiện giữ vận đơn bị sàn đổi mã (hai kiện đổi mã cho nhau): không vỡ CHECK packages_waybill_kept, mã đổi, waybill_kept tắt', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, packages: 2 });
    const { orderId } = await ingest(v.companyId, o);
    const rows = await packagesOf(orderId);
    const first = rows.find((r) => r.items.includes(external(o, 0)));
    const second = rows.find((r) => r.items.includes(external(o, 1)));
    await testPool().query(`update "order".packages set tracking_code = $2, waybill_kept = true where id = $1`, [first!.id, `VD-${tag()}`]);

    await ingest(v.companyId, relabeled(o, [second!.platformCode, first!.platformCode]));

    expect(await waybillOf(first!.id)).toMatchObject({ platform_package_code: second!.platformCode, waybill_kept: false });
    expect(await waybillOf(second!.id)).toMatchObject({ platform_package_code: first!.platformCode });
  });

  it('AC19: kiện awaiting_pickup chờ mở vì edit, mở còn món: reserved, giữ mã kiện sàn, vận đơn, ĐVVC, waybill_kept true, không gọi repack', async () => {
    const { v, o, packageId, tracking } = await pickupEdited();

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await waybillOf(packageId)).toEqual({
      status: 'reserved',
      platform_package_code: o.lines[0]!.packageCode,
      tracking_code: tracking,
      carrier_code: 'LEX',
      carrier_name: 'LEX VN',
      waybill_kept: true,
      needs_open: false,
    });
    expect(await lineRows(packageId)).toEqual([{ item: external(o, 0), reserved: 1, drop: 0 }]);
  });

  it('AC19: đóng gói lại rồi báo sẵn sàng kiện waybill_kept: không gọi pack, readyToShip; kiện awaiting_pickup với vận đơn cũ, waybill_kept false', async () => {
    const { v, o, packageId, tracking } = await pickupEdited();
    expect((await post(v.token, packageId, 'open', { version: await versionOf(packageId) })).status).toBe(200);

    const packed = await post(v.token, packageId, 'pack', { version: await versionOf(packageId), lines: [{ variantId: v.variantId, quantity: 1 }] });

    expect(packed.status, JSON.stringify(packed.body)).toBe(200);
    expect(await waybillOf(packageId)).toMatchObject({
      status: 'packed',
      platform_package_code: o.lines[0]!.packageCode,
      tracking_code: tracking,
      carrier_code: 'LEX',
      carrier_name: 'LEX VN',
      waybill_kept: true,
    });

    const ready = await post(v.token, packageId, 'ready', { version: await versionOf(packageId) });

    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(await waybillOf(packageId)).toMatchObject({
      status: 'awaiting_pickup',
      platform_package_code: o.lines[0]!.packageCode,
      tracking_code: tracking,
      carrier_code: 'LEX',
      waybill_kept: false,
    });
  });

  it('AC19: kiện awaiting_pickup không có cờ Cần mở: open 409 invalid_transition', async () => {
    const v = await setup(10);
    const { packageId } = await ingest(v.companyId, remote(v, { lines: 1, status: 'awaiting_pickup' }));
    const version = await versionOf(packageId);

    const res = await post(v.token, packageId, 'open', { version });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(await packageRow(packageId)).toMatchObject({ status: 'awaiting_pickup', version });
  });
});

describe('kiện đang chờ mở: chặn báo sẵn sàng, quét bàn giao; sàn báo rời kho (#238 D27, D28)', () => {
  it('AC19a: ready kiện packed có cờ Cần mở: 409 awaiting_open, không gọi readyToShip', async () => {
    const { v, packageId } = await packedSplit();
    const version = await versionOf(packageId);

    const res = await post(v.token, packageId, 'ready', { version });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toBe('/problems/awaiting_open');
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, version });
  });

  it('AC19a: quét bàn giao kiện awaiting_pickup có cờ Cần mở: failed[].code awaiting_open, kiện không đổi, tồn không đổi', async () => {
    const { v, packageId } = await pickupEdited();
    const version = await versionOf(packageId);
    const before = await stockOfVariant(v.companyId, v.variantId);

    const res = await packingApp().post('/api/v1/fulfillment/packages/hand-over').set('Authorization', `Bearer ${v.token}`).send({ packages: [{ id: packageId, version }] });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ handedOver: [], failed: [{ packageId, code: 'awaiting_open', detail: expect.any(String) }] });
    expect(await packageRow(packageId)).toMatchObject({ status: 'awaiting_pickup', needs_open: true, version });
    expect(await stockOfVariant(v.companyId, v.variantId)).toEqual(before);
  });

  it('AC19b: sàn báo kiện packed chờ mở resplit đã in_transit: in_transit, trừ mọi dòng một lần, needs_open false, needs_attention với note rời kho; kiện thay thành ứng viên', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    // Sàn giữ mã cũ cho món 1, món 2 sang mã mới: kiện cũ còn món 1 và dòng chờ bỏ của món 2.
    const next = itemStatuses(relabeled(o, [o.lines[0]!.packageCode, `FP-B-${tag()}`]), ['packed', 'pending']);
    await ingest(v.companyId, next);
    const fresh = (await packagesOf(orderId)).find((r) => r.replaces === packageId)!;

    await ingest(v.companyId, itemStatuses(next, ['in_transit', 'pending']));

    expect(await packageRow(packageId)).toMatchObject({
      status: 'in_transit',
      handover_source: 'marketplace',
      needs_open: false,
      open_purpose: null,
      needs_attention: true,
      flag_note: 'Sàn báo kiện rời kho khi còn chờ dỡ kiện về kệ',
    });
    expect(await packageDocuments(packageId)).toHaveLength(1);
    expect(await lineRows(packageId)).toEqual([
      { item: external(o, 0), reserved: 0, drop: 0 },
      { item: external(o, 1), reserved: 0, drop: 1 },
    ]);
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([8, 0]);

    const r = await withCompany(v.companyId, () => runAllocation({ stockHoldOf: awaitingStocktakeShops }, { variantIds: [v.variantId] }));

    expect(r.held).toEqual([fresh.id]);
    expect((await packageRow(fresh.id)).status).toBe('reserved');
  });

  it('kiện chờ mở vì stocktake rời kho: gỡ cờ, không bật Cần xử lý (như PR 2)', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 1, status: 'packed' });
    const { packageId } = await ingest(v.companyId, o);
    await testPool().query(`update "order".packages set needs_open = true, open_purpose = 'stocktake' where id = $1`, [packageId]);

    await ingest(v.companyId, withStatus(o, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'in_transit', needs_open: false, open_purpose: null, needs_attention: false, flag_note: null });
  });
});

describe('kiện chờ thay không báo sẵn sàng, không quét bàn giao (#238 D9, D28, review #393)', () => {
  const handOver = (token: string, id: string, version: number) =>
    packingApp().post('/api/v1/fulfillment/packages/hand-over').set('Authorization', `Bearer ${token}`).send({ packages: [{ id, version }] });

  it('sàn đẩy kiện chờ thay sang awaiting_pickup, packed: quét bàn giao vào failed awaiting_open, ready 409 awaiting_open, kiện và tồn không đổi', async () => {
    const { v, next, a, b } = await packedSplit();
    await ingest(v.companyId, itemStatuses(next, ['awaiting_pickup', 'packed']));
    expect((await packageRow(a.id)).status).toBe('awaiting_pickup');
    expect((await packageRow(b.id)).status).toBe('packed');
    const stock = await stockOfVariant(v.companyId, v.variantId);
    const [versionA, versionB] = [await versionOf(a.id), await versionOf(b.id)];

    const scan = await handOver(v.token, a.id, versionA);
    const ready = await post(v.token, b.id, 'ready', { version: versionB });

    expect(scan.status, JSON.stringify(scan.body)).toBe(200);
    expect(scan.body.handedOver).toEqual([]);
    expect(scan.body.failed).toEqual([expect.objectContaining({ packageId: a.id, code: 'awaiting_open' })]);
    expect(ready.status, JSON.stringify(ready.body)).toBe(409);
    expect(ready.body.type).toBe('/problems/awaiting_open');
    expect(await packageRow(a.id)).toMatchObject({ status: 'awaiting_pickup', version: versionA });
    expect(await packageRow(b.id)).toMatchObject({ status: 'packed', version: versionB });
    expect(await stockOfVariant(v.companyId, v.variantId)).toEqual(stock);
  });

  it('kiện chờ thay đã bị quét bàn giao (dữ liệu trước khi chặn) rồi sàn báo in_transit: nhả phần giữ của dòng chờ bỏ, không chuyển sang dòng đã trừ; mở kiện cũ thì đang giữ 1, có thể bán 8', async () => {
    const { v, o, packageId, next, a, b } = await packedSplit();
    await ingest(v.companyId, itemStatuses(next, ['awaiting_pickup', 'pending']));
    // Dựng dữ liệu như trước khi chặn quét kiện chờ thay: tạm đưa kiện cũ ra khỏi nhóm đã đóng để quét được kiện thay.
    await testPool().query(`update "order".packages set status = 'reserved' where id = $1`, [packageId]);
    expect((await handOver(v.token, a.id, await versionOf(a.id))).body.handedOver).toHaveLength(1);
    await testPool().query(`update "order".packages set status = 'packed' where id = $1`, [packageId]);
    expect(await stockOfVariant(v.companyId, v.variantId)).toMatchObject({ onHand: 9, reserved: 2 });

    await ingest(v.companyId, itemStatuses(next, ['in_transit', 'pending']));

    expect(await lineRows(packageId)).toEqual([{ item: external(o, 1), reserved: 1, drop: 1 }]);
    expect(await lineRows(a.id)).toEqual([{ item: external(o, 0), reserved: 0, drop: 0 }]);
    expect(await stockOfVariant(v.companyId, v.variantId)).toMatchObject({ onHand: 9, reserved: 1 });

    const res = await post(v.token, packageId, 'open', { version: await versionOf(packageId) });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(packageId)).toMatchObject({ status: 'cancelled' });
    expect(await packageRow(b.id)).toMatchObject({ status: 'reserved' });
    expect(await stockOfVariant(v.companyId, v.variantId)).toMatchObject({ onHand: 9, reserved: 1, available: 8 });
  });
});

describe('kiện cũ chờ dỡ để chia lại bị xác nhận mất (#238 D20)', () => {
  it('AC11c: kiện cũ packed chờ mở resplit bị xác nhận mất (lose_on_unload): tồn trừ mọi món trong hộp một lần, xếp lượt cho SKU dòng chờ bỏ, chạy lượt thì kiện thay reserved khi đủ hàng, kiểm bằng không vỡ', async () => {
    const { v, packageId, a, b } = await packedSplit();
    const khoA = await addMember(v.companyId, 'warehouse');
    const khoB = await addMember(v.companyId, 'warehouse');

    const reported = await post(khoA.token, packageId, 'report-lost', { version: await versionOf(packageId), claimCode: 'KN-1' });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);
    const confirmed = await post(khoB.token, packageId, 'confirm-lost', { version: await versionOf(packageId) });

    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(await packageRow(packageId)).toMatchObject({ status: 'lost', needs_open: false, handover_source: 'scan' });
    expect(await lineRows(packageId)).toEqual([
      expect.objectContaining({ reserved: 0, drop: 1 }),
      expect.objectContaining({ reserved: 0, drop: 1 }),
    ]);
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([8, 0]);
    expect(await allocationJobs(v.companyId, v.variantId)).toEqual([[v.variantId]]);

    const r = await withCompany(v.companyId, () => runAllocation({ stockHoldOf: awaitingStocktakeShops }, { variantIds: [v.variantId] }));

    expect([...r.held].sort()).toEqual([a.id, b.id].sort());
    for (const p of [a, b]) expect((await packageRow(p.id)).status).toBe('reserved');
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
  });
});
