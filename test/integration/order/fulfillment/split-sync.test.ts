// Đồng bộ kiện sàn sau khi kho tách kiện trong app (spec 205 D10, §5.5, AC12).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { testPool } from '../../helpers/db.ts';
import { ingest, remote, setup } from './platform-fixtures.ts';

const unpacked = (o: PlatformOrder): PlatformOrder => ({ ...o, lines: o.lines.map((l) => ({ ...l, packageCode: null })) });

/** Tách tay như route tách kiện: kiện mới chép đơn, gian hàng, trạng thái, lúc giữ hàng; dòng của món chuyển sang. */
async function splitByHand(packageId: string, externalLineId: string): Promise<string> {
  const db = testPool();
  const { rows } = await db.query<{ id: string }>(
    `insert into "order".packages (company_id, code, order_id, shop_id, status, reserved_at)
     select company_id, $2, order_id, shop_id, status, reserved_at from "order".packages where id = $1 returning id`,
    [packageId, `KH-T-${randomUUID().slice(0, 8)}`],
  );
  const id = rows[0]!.id;
  await db.query(
    `update "order".package_lines pl set package_id = $2
     from "order".order_lines ol where ol.id = pl.order_line_id and pl.package_id = $1 and ol.external_line_id = $3`,
    [packageId, id, externalLineId],
  );
  return id;
}

async function packageOf(id: string) {
  const { rows } = await testPool().query<{ status: string; platform_package_code: string | null }>(
    'select status, platform_package_code from "order".packages where id = $1',
    [id],
  );
  return rows[0]!;
}

async function orderOf(id: string) {
  const { rows } = await testPool().query<{ needs_attention: boolean; attention_note: string | null }>(
    'select needs_attention, attention_note from "order".orders where id = $1',
    [id],
  );
  return rows[0]!;
}

async function historyCount(ids: readonly string[]) {
  const { rows } = await testPool().query<{ n: number }>(
    `select count(*)::int as n from core.state_transitions where entity_type = 'packages' and entity_id = any($1::uuid[])`,
    [ids],
  );
  return rows[0]!.n;
}

describe('đồng bộ giữ cách chia kiện của app (spec 205 D10)', () => {
  it('D2-S04 AC12: đơn đã tách trong app, chưa đóng gói, kéo lại không đổi kiện, không bật Cần xử lý', async () => {
    const v = await setup(10);
    const o = unpacked(remote(v, { lines: 2 }));
    const { orderId, packageId } = await ingest(v.companyId, o);
    const second = await splitByHand(packageId, o.lines[1]!.externalLineId);
    const before = await historyCount([packageId, second]);

    await ingest(v.companyId, o);

    expect(await packageOf(packageId)).toEqual({ status: 'reserved', platform_package_code: null });
    expect(await packageOf(second)).toEqual({ status: 'reserved', platform_package_code: null });
    expect((await orderOf(orderId)).needs_attention).toBe(false);
    expect(await historyCount([packageId, second])).toBe(before);
  });

  it('sàn gắn mã cho món của một kiện thì chỉ kiện đó nhận mã và đổi trạng thái', async () => {
    // Ba kiện app, món của hai kiện sau chưa có mã sàn: trước #205 chúng rơi chung một nhóm mã rỗng.
    const v = await setup(10);
    const o = unpacked(remote(v, { lines: 3 }));
    const { orderId, packageId } = await ingest(v.companyId, o);
    const second = await splitByHand(packageId, o.lines[1]!.externalLineId);
    const third = await splitByHand(packageId, o.lines[2]!.externalLineId);
    const code = `FP-X-${randomUUID().slice(0, 8)}`;

    await ingest(v.companyId, {
      ...o,
      lines: o.lines.map((l, i) => (i === 0 ? { ...l, packageCode: code, status: 'packed', rawStatus: 'packed' } : l)),
    });

    expect(await packageOf(packageId)).toEqual({ status: 'packed', platform_package_code: code });
    expect(await packageOf(second)).toEqual({ status: 'reserved', platform_package_code: null });
    expect(await packageOf(third)).toEqual({ status: 'reserved', platform_package_code: null });
    expect((await orderOf(orderId)).needs_attention).toBe(false);
  });

  it('món của hai kiện app về chung một mã sàn vẫn bật Sàn chia lại kiện', async () => {
    const v = await setup(10);
    const o = unpacked(remote(v, { lines: 2 }));
    const { orderId, packageId } = await ingest(v.companyId, o);
    await splitByHand(packageId, o.lines[1]!.externalLineId);
    const code = `FP-Y-${randomUUID().slice(0, 8)}`;

    await ingest(v.companyId, { ...o, lines: o.lines.map((l) => ({ ...l, packageCode: code })) });

    expect(await orderOf(orderId)).toEqual({ needs_attention: true, attention_note: 'Sàn chia lại kiện khác lần trước' });
  });
});
