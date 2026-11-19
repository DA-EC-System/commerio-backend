// Đồng bộ khi sàn huỷ lẻ một món (spec 205 §5.10, D16–D21; AC15, AC16, AC18).
import { describe, expect, it } from 'vitest';
import { completeDueOrdersOnce, type PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { getOrder } from '#src/modules/order/sales/service/orders.ts';
import { CANCELLING_SQL, packageRow, packingApp, splitByHand, stockOfVariant, transitionsOf } from './helpers.ts';
import { createModuleContext } from '#src/wiring.ts';
import { ingest, remote, setup, withLineCancelled, withStatus } from './platform-fixtures.ts';

const unpacked = (o: PlatformOrder): PlatformOrder => ({ ...o, lines: o.lines.map((l) => ({ ...l, packageCode: null })) });

/** Dòng của kiện kèm mã món sàn, theo mã món (dòng chèn cùng một câu trùng `created_at`). */
async function linesOf(packageId: string) {
  const { rows } = await testPool().query<{ external_line_id: string; pending_drop_qty: number; reserved_qty: number }>(
    `select ol.external_line_id, pl.pending_drop_qty, pl.reserved_qty from "order".package_lines pl
     join "order".order_lines ol on ol.id = pl.order_line_id where pl.package_id = $1 order by ol.external_line_id`,
    [packageId],
  );
  return rows;
}

async function packageOf(id: string) {
  const { rows } = await testPool().query<{ status: string; version: number; needs_open: boolean; open_purpose: string | null }>(
    'select status, version, needs_open, open_purpose from "order".packages where id = $1',
    [id],
  );
  return rows[0]!;
}

async function orderOf(id: string) {
  const { rows } = await testPool().query<{ status: string; needs_attention: boolean }>('select status, needs_attention from "order".orders where id = $1', [id]);
  return rows[0]!;
}

async function dropReasons(packageId: string) {
  const { rows } = await testPool().query<{ reason: string | null }>(
    `select reason from core.state_transitions where entity_type = 'packages' and entity_id = $1 and action = 'drop_lines' order by id`,
    [packageId],
  );
  return rows.map((r) => r.reason);
}

const reservedOf = async (companyId: string, variantId: string) => (await stockOfVariant(companyId, variantId))?.reserved ?? 0;

describe('sàn huỷ lẻ một món (spec 205 §5.10)', () => {
  it('AC15: kiện reserved ba món, sàn huỷ một món thì gỡ dòng và nhả phần giữ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3 });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const before = await packageOf(packageId);
    expect(await reservedOf(v.companyId, v.variantId)).toBe(3);

    await ingest(v.companyId, withLineCancelled(o, 2));

    expect((await linesOf(packageId)).map((l) => l.external_line_id)).toEqual([o.lines[0]!.externalLineId, o.lines[1]!.externalLineId]);
    expect(await reservedOf(v.companyId, v.variantId)).toBe(2);
    const after = await packageOf(packageId);
    expect(after.status).toBe('reserved');
    expect(after.version).toBeGreaterThan(before.version);
    expect(await transitionsOf(packageId)).toContainEqual({ action: 'drop_lines', from_state: 'reserved', to_state: 'reserved', source: 'marketplace' });
    expect(await dropReasons(packageId)).toEqual(['Sàn huỷ 1 món']);
    expect((await orderOf(orderId)).status).toBe('processing');
  });

  it('kiện backordered: gỡ dòng không gọi cổng tồn nhả hàng', async () => {
    const v = await setup(null);
    const o = remote(v, { lines: 2 });
    const { packageId } = await ingest(v.companyId, o);
    expect((await packageOf(packageId)).status).toBe('backordered');

    await ingest(v.companyId, withLineCancelled(o, 1));

    expect(await linesOf(packageId)).toHaveLength(1);
    expect(await reservedOf(v.companyId, v.variantId)).toBe(0);
    expect((await packageOf(packageId)).status).toBe('backordered');
  });

  it('AC16: kiện packed ba món, sàn huỷ một món thì dòng đó chờ bỏ, kiện chờ mở, vẫn giữ hàng', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3 });
    const { packageId } = await ingest(v.companyId, o);
    const packed = withStatus(o, 'packed');
    await ingest(v.companyId, packed);

    await ingest(v.companyId, withLineCancelled(packed, 2));

    expect((await linesOf(packageId)).map((l) => l.pending_drop_qty)).toEqual([0, 0, 1]);
    expect(await packageOf(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'edit' });
    expect(await reservedOf(v.companyId, v.variantId)).toBe(3);
  });

  it('kéo lại không đánh dấu chờ bỏ lần hai', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3 });
    const { packageId } = await ingest(v.companyId, o);
    const packed = withStatus(o, 'packed');
    await ingest(v.companyId, packed);
    await ingest(v.companyId, withLineCancelled(packed, 2));
    const before = await packageOf(packageId);

    await ingest(v.companyId, withLineCancelled(packed, 2));

    expect((await packageOf(packageId)).version).toBe(before.version);
  });

  it('AC18: kiện in_transit, sàn huỷ một món thì không đổi dòng kiện', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3 });
    const { packageId } = await ingest(v.companyId, o);
    const shipped = withStatus(o, 'in_transit');
    await ingest(v.companyId, shipped);

    await ingest(v.companyId, withLineCancelled(shipped, 2));

    expect((await linesOf(packageId)).map((l) => l.pending_drop_qty)).toEqual([0, 0, 0]);
    expect((await packageOf(packageId)).status).toBe('in_transit');
  });

  it('D21: kiện packed đang chờ bỏ một món, rồi sàn huỷ hết thì mục đích mở nâng lên cancel', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3 });
    const { packageId } = await ingest(v.companyId, o);
    const packed = withStatus(o, 'packed');
    await ingest(v.companyId, packed);
    await ingest(v.companyId, withLineCancelled(packed, 2));

    await ingest(v.companyId, withStatus(o, 'cancelled'));

    expect(await packageOf(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
    expect((await linesOf(packageId)).map((l) => l.pending_drop_qty)).toEqual([1, 1, 1]);
  });

  it('món huỷ là dòng chưa ghép SKU: gỡ được, không gọi cổng tồn (Review Focus 2)', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 1, unmapped: 1 });
    const { packageId } = await ingest(v.companyId, o);
    const held = await reservedOf(v.companyId, v.variantId);

    await ingest(v.companyId, withLineCancelled(o, 1));

    expect((await linesOf(packageId)).map((l) => l.external_line_id)).toEqual([o.lines[0]!.externalLineId]);
    expect(await reservedOf(v.companyId, v.variantId)).toBe(held);
  });

  it('đơn đã tách hai kiện app, sàn huỷ một món thì chỉ kiện chứa món đổi (Review Focus 3)', async () => {
    const v = await setup(10);
    const o = unpacked(remote(v, { lines: 3 }));
    const { orderId, packageId } = await ingest(v.companyId, o);
    const second = await splitByHand(packageId, o.lines[2]!.externalLineId);
    const secondBefore = await packageOf(second);

    await ingest(v.companyId, withLineCancelled(o, 1));

    expect((await linesOf(packageId)).map((l) => l.external_line_id)).toEqual([o.lines[0]!.externalLineId]);
    expect((await packageOf(second)).version).toBe(secondBefore.version);
    expect((await linesOf(second)).map((l) => l.external_line_id)).toEqual([o.lines[2]!.externalLineId]);
    expect((await orderOf(orderId)).needs_attention).toBe(false);
  });

  it('gian hàng chờ kiểm kê đầu kỳ: gỡ dòng không gọi release (Review Focus 5)', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, holdStock: false });
    const { packageId } = await ingest(v.companyId, o);

    await ingest(v.companyId, withLineCancelled(o, 1));

    expect(await packageOf(packageId)).toMatchObject({ status: 'backordered' });
    expect(await linesOf(packageId)).toHaveLength(1);
    expect(await reservedOf(v.companyId, v.variantId)).toBe(0);
  });

  it('D17: món huỷ vì giao không thành không bị gỡ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2 });
    const { packageId } = await ingest(v.companyId, o);

    await ingest(v.companyId, withLineCancelled(o, 1, 'failed_delivery'));

    expect(await linesOf(packageId)).toHaveLength(2);
  });

  it('KH-B09: khách huỷ một món đã đóng kiện riêng: đơn không Đang huỷ (chỉ kiện chờ mở), tiền bỏ món huỷ; kiện còn lại giao xong thì hoàn tất, không cờ Sàn đã huỷ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, packages: 2, status: 'packed' });
    const { orderId } = await ingest(v.companyId, o);
    const codes = [...new Set(o.lines.map((l) => l.packageCode!))];
    const cancelledCode = o.lines[0]!.packageCode!;
    const liveCode = codes.find((c) => c !== cancelledCode)!;
    const pkgOf = async (code: string) =>
      (await testPool().query<{ id: string }>('select id from "order".packages where order_id = $1 and platform_package_code = $2', [orderId, code])).rows[0]!.id;
    const cancelledPkg = await pkgOf(cancelledCode);
    const flagOf = async () =>
      (
        await testPool().query<{ status: string; cancelling: boolean; cancel_pending: boolean; platform_cancelled: boolean; cancel_reason: string | null; subtotal: string; total: string }>(
          `select status, ${CANCELLING_SQL} as cancelling, cancel_pending, platform_cancelled, cancel_reason, subtotal, total from "order".orders where id = $1`,
          [orderId],
        )
      ).rows[0]!;
    expect(await flagOf()).toMatchObject({ subtotal: '200000.00', total: '200000.00' });

    const lineCancel = withLineCancelled(o, 0);
    lineCancel.lines[0]!.info = { ...lineCancel.lines[0]!.info, cancelInitiator: 'buyer', cancelKind: 'cancellation', cancelReason: 'Đổi ý' };
    await ingest(v.companyId, lineCancel);

    expect(await packageRow(cancelledPkg)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
    // Huỷ một món (25 §8.3 Huỷ dòng): đơn chạy tiếp, không mang cờ Đang huỷ (chỉ kiện chờ mở), không lý do huỷ cả đơn;
    // tiền chỉ còn món chưa huỷ; người huỷ suy ra từ dòng.
    expect(await flagOf()).toMatchObject({ status: 'processing', cancelling: false, cancel_pending: false, cancel_reason: null, subtotal: '100000.00', total: '100000.00' });
    const view = await withCompany(v.companyId, () => getOrder(createModuleContext(), orderId));
    expect(view.flags).not.toContain('cancelling');
    expect(view.display.stage).not.toBe('cancelling');
    expect(view.cancelInitiators).toEqual(['buyer']);
    expect(view.lines.map((l) => l.cancelledQty)).toEqual([1, 0]);
    // Giờ huỷ món cho lịch sử đơn (#417): chỉ món đã huỷ có giờ.
    expect(view.lines[0]!.cancelledAt).toEqual(expect.any(String));
    expect(view.lines[1]!.cancelledAt).toBeNull();

    const kho = await addMember(v.companyId, 'warehouse');
    const opened = await packingApp()
      .post(`/api/v1/fulfillment/packages/${cancelledPkg}/open`)
      .set('Authorization', `Bearer ${kho.token}`)
      .send({ version: (await packageRow(cancelledPkg)).version });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(opened.body.status).toBe('cancelled');
    expect(await flagOf()).toMatchObject({ status: 'processing', cancelling: false });

    await ingest(v.companyId, withStatus(lineCancel, 'delivered', liveCode));
    expect(await completeDueOrdersOnce(new Date(Date.now() + 8 * 86_400_000), createModuleContext())).toBeGreaterThanOrEqual(1);
    expect(await flagOf()).toMatchObject({ status: 'completed', cancelling: false, cancel_pending: false, platform_cancelled: false });
  });
});
