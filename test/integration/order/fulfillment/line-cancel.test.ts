// Đồng bộ khi sàn huỷ lẻ một món (spec 205 §5.10, D16–D21; AC15, AC16, AC18).
import { describe, expect, it } from 'vitest';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { testPool } from '../../helpers/db.ts';
import { splitByHand, stockOfVariant, transitionsOf } from './helpers.ts';
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
});
