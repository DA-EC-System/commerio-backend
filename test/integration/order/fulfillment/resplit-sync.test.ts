// Sàn chia lại kiện (#238 PR 3, spec §5.6, D22, D23, D29): đồng bộ kiện của đơn sàn khi danh sách kiện của sàn khác app.
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import { runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testApp } from '../../helpers/http.ts';
import { testPool } from '../../helpers/db.ts';
import { CANCELLING_SQL, packageDocuments, packageRow, packingApp, splitByHand, stockOfVariant, transitionReasonsOf, transitionsOf } from './helpers.ts';
import { ingest, remote, withCancel, withLineCancelled, withStatus } from './platform-fixtures.ts';
import {
  external,
  historyCount,
  itemStatuses,
  lineRows,
  orderFlag,
  packagesOf,
  packedSplit,
  relabeled,
  setup,
  tag,
  unpacked,
} from './resplit-fixtures.ts';

afterEach(() => setStockPort());

const NO_FLAG = { needs_attention: false, attention_note: null };
const UNHANDLED = 'Sàn chia lại kiện, app chưa tự xử lý được';

type Scenario = { companyId: string; orderId: string; next: PlatformOrder; o: PlatformOrder; v: Awaited<ReturnType<typeof setup>> };

/** AC12: sàn đổi mã gói của kiện hai món, tập món không đổi. */
async function renamed(): Promise<Scenario> {
  const v = await setup(10);
  const o = remote(v, { lines: 2 });
  const { orderId } = await ingest(v.companyId, o);
  const code = `FP-N-${tag()}`;
  const next = relabeled(o, [code, code]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC12: hai kiện của đơn đổi mã cho nhau. */
async function swapped(): Promise<Scenario> {
  const v = await setup(10);
  const o = remote(v, { lines: 2, packages: 2 });
  const { orderId } = await ingest(v.companyId, o);
  const next = relabeled(o, [o.lines[1]!.packageCode, o.lines[0]!.packageCode]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC13: kiện reserved 2 món chia thành 2 mã mới. */
async function splitInTwo(stock = 10): Promise<Scenario> {
  const v = await setup(stock);
  const o = remote(v, { lines: 2 });
  const { orderId } = await ingest(v.companyId, o);
  const next = relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC13a: sàn giữ mã cũ cho món 1, món 2 sang mã mới. */
async function keptOld(): Promise<Scenario> {
  const v = await setup(10);
  const o = remote(v, { lines: 2 });
  const { orderId } = await ingest(v.companyId, o);
  const next = relabeled(o, [o.lines[0]!.packageCode, `FP-B-${tag()}`]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC14a: hai kiện app chưa đóng (đã tách trong app) về chung một mã mới. */
async function mergedNew(): Promise<Scenario> {
  const v = await setup(10);
  const o = unpacked(remote(v, { lines: 2 }));
  const { orderId, packageId } = await ingest(v.companyId, o);
  await splitByHand(packageId, external(o, 1));
  const code = `FP-M-${tag()}`;
  const next = relabeled(o, [code, code]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC14a: sàn gộp món của kiện B vào mã kiện A. */
async function mergedIntoOld(): Promise<Scenario> {
  const v = await setup(10);
  const o = remote(v, { lines: 2, packages: 2 });
  const { orderId } = await ingest(v.companyId, o);
  const next = relabeled(o, [o.lines[0]!.packageCode, o.lines[0]!.packageCode]);
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

/** AC17: kiện in_transit, sàn báo chia khác. */
async function handedOver(): Promise<Scenario> {
  const v = await setup(10);
  const o = remote(v, { lines: 2 });
  const { orderId } = await ingest(v.companyId, o);
  await ingest(v.companyId, withStatus(o, 'in_transit'));
  const next = withStatus(relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]), 'in_transit');
  await ingest(v.companyId, next);
  return { companyId: v.companyId, orderId, next, o, v };
}

describe('sàn chia lại kiện chưa đóng (#238 §5.6)', () => {
  it('AC12: sàn đổi mã gói, tập món không đổi: chỉ platform_package_code đổi, không kiện huỷ hay lập, đơn không cờ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2 });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const before = await historyCount(orderId);
    const code = `FP-N-${tag()}`;

    await ingest(v.companyId, relabeled(o, [code, code]));

    const rows = await packagesOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: packageId, status: 'reserved', platformCode: code, replaces: null });
    expect(await historyCount(orderId)).toBe(before);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC12: hai kiện của đơn đổi mã cho nhau: cả hai nhận mã mới, không vi phạm unique', async () => {
    const { orderId, o } = await swapped();

    const rows = await packagesOf(orderId);
    expect(rows).toHaveLength(2);
    const holderOf = (i: number) => rows.find((r) => r.items.includes(external(o, i)))!;
    expect(holderOf(0).platformCode).toBe(o.lines[1]!.packageCode);
    expect(holderOf(1).platformCode).toBe(o.lines[0]!.packageCode);
    expect(rows.every((r) => r.status === 'reserved')).toBe(true);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC13: kiện reserved 2 món chia thành 2 mã mới: kiện cũ cancelled (lịch sử cancel, lý do Sàn chia lại kiện), 2 kiện mới reserved có replaces, available trước và sau bằng nhau, đơn không cờ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2 });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const before = await stockOfVariant(v.companyId, v.variantId);
    const [a, b] = [`FP-A-${tag()}`, `FP-B-${tag()}`];

    await ingest(v.companyId, relabeled(o, [a, b]));

    const rows = await packagesOf(orderId);
    const old = rows.find((r) => r.id === packageId)!;
    expect(old.status).toBe('cancelled');
    expect(await transitionsOf(packageId)).toContainEqual({ action: 'cancel', from_state: 'reserved', to_state: 'cancelled', source: 'marketplace' });
    expect(await transitionReasonsOf(packageId, 'cancelled')).toEqual(['Sàn chia lại kiện']);
    const fresh = rows.filter((r) => r.id !== packageId);
    expect(fresh.map((r) => [r.platformCode, r.status, r.replaces, r.items])).toEqual(
      expect.arrayContaining([
        [a, 'reserved', packageId, [external(o, 0)]],
        [b, 'reserved', packageId, [external(o, 1)]],
      ]),
    );
    expect(fresh).toHaveLength(2);
    for (const r of fresh) expect(await transitionReasonsOf(r.id, 'reserved')).toEqual([`Sàn chia lại kiện ${old.code}`]);
    const after = await stockOfVariant(v.companyId, v.variantId);
    expect(after.available).toBe(before.available);
    expect(after.reserved).toBe(2);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC13a: sàn giữ mã cũ cho món 1: kiện cũ reserved 1 món (lịch sử drop_lines), kiện mới reserved 1 món', async () => {
    const { orderId, o, v } = await keptOld();

    const rows = await packagesOf(orderId);
    expect(rows).toHaveLength(2);
    const old = rows.find((r) => r.platformCode === o.lines[0]!.packageCode)!;
    expect(old).toMatchObject({ status: 'reserved', items: [external(o, 0)], replaces: null });
    expect(await transitionsOf(old.id)).toContainEqual({ action: 'drop_lines', from_state: 'reserved', to_state: 'reserved', source: 'marketplace' });
    expect(await transitionReasonsOf(old.id, 'reserved')).toContain('Sàn chia lại kiện: chuyển 1 món');
    const fresh = rows.find((r) => r.id !== old.id)!;
    expect(fresh).toMatchObject({ status: 'reserved', items: [external(o, 1)], replaces: old.id });
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC14: kiện backordered của đơn khác chờ cùng SKU: kiện mới của đơn này giữ được, kiện kia vẫn backordered', async () => {
    const v = await setup(2);
    const o = remote(v, { lines: 2 });
    const { orderId } = await ingest(v.companyId, o);
    const other = await ingest(v.companyId, remote(v, { lines: 1 }));
    expect((await packagesOf(other.orderId))[0]!.status).toBe('backordered');

    await ingest(v.companyId, relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]));

    const fresh = (await packagesOf(orderId)).filter((r) => r.replaces !== null);
    expect(fresh.map((r) => r.status)).toEqual(['reserved', 'reserved']);
    expect((await packagesOf(other.orderId))[0]!.status).toBe('backordered');
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
  });

  it('AC14a: hai kiện app chưa đóng về chung một mã mới: hai kiện cũ cancelled, một kiện mới reserved, đơn không cờ', async () => {
    const { orderId, next, o } = await mergedNew();

    const rows = await packagesOf(orderId);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(2);
    const live = rows.filter((r) => r.status !== 'cancelled');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ status: 'reserved', platformCode: next.lines[0]!.packageCode, items: [external(o, 0), external(o, 1)] });
    expect(rows.map((r) => r.id)).toContain(live[0]!.replaces);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC14a: sàn gộp món của kiện B vào mã kiện A: không đổi kiện nào, đơn needs_attention với note Sàn chia lại kiện, app chưa tự xử lý được', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, packages: 2 });
    const { orderId } = await ingest(v.companyId, o);
    const before = await packagesOf(orderId);

    await ingest(v.companyId, relabeled(o, [o.lines[0]!.packageCode, o.lines[0]!.packageCode]));

    expect(await packagesOf(orderId)).toEqual(before);
    expect(await orderFlag(orderId)).toEqual({ needs_attention: true, attention_note: UNHANDLED });
  });

  it('AC17: kiện in_transit, sàn báo chia khác: kiện và đơn bật Cần xử lý, không lập kiện', async () => {
    const { orderId } = await handedOver();

    const rows = await packagesOf(orderId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'in_transit', needsAttention: true, flagNote: 'Sàn chia lại kiện đã bàn giao' });
    expect(await orderFlag(orderId)).toEqual({ needs_attention: true, attention_note: UNHANDLED });
  });

  it('AC18: kéo lại sau mỗi ca trên: version các kiện không đổi, không kiện mới, không lịch sử mới', async () => {
    for (const build of [renamed, swapped, () => splitInTwo(), keptOld, mergedNew, mergedIntoOld, handedOver]) {
      const { companyId, orderId, next } = await build();
      const before = await packagesOf(orderId);
      const history = await historyCount(orderId);
      const flag = await orderFlag(orderId);

      await ingest(companyId, next);

      expect(await packagesOf(orderId)).toEqual(before);
      expect(await historyCount(orderId)).toBe(history);
      expect(await orderFlag(orderId)).toEqual(flag);
    }
  });

  it('Review 1: hai đơn chung một mã kiện sàn, đơn A chia lại: kiện của đơn B không đổi', async () => {
    const v = await setup(10);
    const a = remote(v, { lines: 2 });
    const b = { ...remote(v, { lines: 1 }), shopId: a.shopId };
    b.lines = b.lines.map((l) => ({ ...l, packageCode: a.lines[0]!.packageCode }));
    const { orderId } = await ingest(v.companyId, a);
    const other = await ingest(v.companyId, b);
    const before = await packagesOf(other.orderId);

    await ingest(v.companyId, relabeled(a, [`FP-A-${tag()}`, `FP-B-${tag()}`]));

    expect((await packagesOf(orderId)).filter((r) => r.status === 'cancelled')).toHaveLength(1);
    expect(await packagesOf(other.orderId)).toEqual(before);
  });

  it('Review 2: gian hàng chờ kiểm kê đầu kỳ (holdStock false) bị chia lại: kiện mới backordered, không gọi reserve', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, holdStock: false });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const calls: string[] = [];
    setStockPort({
      reserve: async (id) => {
        calls.push(id);
        return { reserved: true };
      },
    });

    await ingest(v.companyId, relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]));

    const rows = await packagesOf(orderId);
    expect(rows.find((r) => r.id === packageId)!.status).toBe('cancelled');
    expect(rows.filter((r) => r.replaces === packageId).map((r) => r.status)).toEqual(['backordered', 'backordered']);
    expect(calls).toEqual([]);
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(0);
  });

  it('GET /packages/:id của kiện mới trả replaces { id, code, status: cancelled }', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2 });
    const { orderId, packageId } = await ingest(v.companyId, o);
    await ingest(v.companyId, relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]));
    const rows = await packagesOf(orderId);
    const old = rows.find((r) => r.id === packageId)!;
    const fresh = rows.find((r) => r.replaces === packageId)!;

    const res = await request(testApp()).get(`/api/v1/fulfillment/packages/${fresh.id}`).set('Authorization', `Bearer ${v.token}`);
    const oldRes = await request(testApp()).get(`/api/v1/fulfillment/packages/${packageId}`).set('Authorization', `Bearer ${v.token}`);

    expect(res.status).toBe(200);
    expect(Package.parse(res.body).replaces).toEqual({ id: packageId, code: old.code, status: 'cancelled' });
    expect(Package.parse(oldRes.body).replaces).toBeNull();
  });
});

const allocate = (companyId: string, variantId: string) =>
  withCompany(companyId, () => runAllocation({ stockHoldOf: awaitingStocktakeShops }, { variantIds: [variantId] }));

describe('sàn chia lại kiện đã đóng: kiện chờ thay (#238 §5.6, D9, D24)', () => {
  it('AC15: kiện packed chia thành 2 mã: kiện cũ packed, vẫn giữ, needs_open resplit, dòng chờ bỏ; 2 kiện mới backordered có replaces', async () => {
    const { v, o, orderId, packageId, a, b } = await packedSplit();

    const old = (await packagesOf(orderId)).find((r) => r.id === packageId)!;
    expect(old).toMatchObject({ status: 'packed', needsOpen: true, openPurpose: 'resplit' });
    expect(await lineRows(packageId)).toEqual([
      { item: external(o, 0), reserved: 1, drop: 1 },
      { item: external(o, 1), reserved: 1, drop: 1 },
    ]);
    for (const p of [a, b]) {
      expect(p).toMatchObject({ status: 'backordered', replaces: packageId });
      expect((await lineRows(p.id)).map((l) => l.reserved)).toEqual([0]);
    }
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
    expect(await orderFlag(orderId)).toEqual(NO_FLAG);
  });

  it('AC15: chạy lượt phân hàng khi kho còn hàng: hai kiện chờ thay vẫn backordered', async () => {
    const { v, a, b } = await packedSplit();

    const r = await allocate(v.companyId, v.variantId);

    expect(r.held).toEqual([]);
    expect((await packageRow(a.id)).status).toBe('backordered');
    expect((await packageRow(b.id)).status).toBe('backordered');
  });

  it('AC15a: kiện packed đang chờ mở vì edit bị chia lại: open_purpose thành resplit; đang cancel thì giữ cancel', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 3, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const edited = withLineCancelled(o, 2);
    await ingest(v.companyId, edited);
    expect((await packageRow(packageId)).open_purpose).toBe('edit');

    await ingest(v.companyId, relabeled(itemStatuses(edited, ['pending', 'pending', 'cancelled']), [`FP-A-${tag()}`, `FP-B-${tag()}`, o.lines[2]!.packageCode]));

    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });
    expect((await lineRows(packageId)).map((l) => l.drop)).toEqual([1, 1, 1]);
    expect((await packagesOf(orderId)).filter((r) => r.replaces === packageId)).toHaveLength(2);

    for (const [before, after] of [['stocktake', 'resplit'], ['cancel', 'cancel']] as const) {
      const w = await setup(10);
      const p = remote(w, { lines: 2, status: 'packed' });
      const seeded = await ingest(w.companyId, p);
      await testPool().query(`update "order".packages set needs_open = true, open_purpose = $2 where id = $1`, [seeded.packageId, before]);

      await ingest(w.companyId, withStatus(relabeled(p, [`FP-A-${tag()}`, `FP-B-${tag()}`]), 'pending'));

      expect(await packageRow(seeded.packageId)).toMatchObject({ needs_open: true, open_purpose: after });
    }
  });

  it('AC15a: sàn huỷ cả kiện đang chờ mở vì resplit: open_purpose thành cancel, đơn cancelling', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    // Sàn giữ mã cũ cho món 1 (vẫn đóng), món 2 sang mã mới: kiện cũ còn món 1, chờ mở để bỏ món 2.
    const next = itemStatuses(relabeled(o, [o.lines[0]!.packageCode, `FP-B-${tag()}`]), ['packed', 'pending']);
    await ingest(v.companyId, next);
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });

    await ingest(v.companyId, withCancel(next, 'cancellation'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
    expect((await lineRows(packageId)).map((l) => l.drop)).toEqual([1, 1]);
    const { rows } = await testPool().query<{ status: string; cancelling: boolean }>(`select status, ${CANCELLING_SQL} as cancelling from "order".orders where id = $1`, [orderId]);
    expect(rows[0]).toEqual({ status: 'processing', cancelling: true });
  });

  it('AC16: sàn báo một kiện chờ thay đã in_transit: kiện mới in_transit, handover_source marketplace, tồn trừ đúng một lần, kiện cũ mất dòng đó', async () => {
    const { v, o, packageId, next, a, b } = await packedSplit();

    await ingest(v.companyId, itemStatuses(next, ['in_transit', 'pending']));

    expect(await packageRow(a.id)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace', needs_attention: false });
    expect(await packageDocuments(a.id)).toHaveLength(1);
    expect(await lineRows(a.id)).toEqual([{ item: external(o, 0), reserved: 0, drop: 0 }]);
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([9, 1]);
    expect(await lineRows(packageId)).toEqual([{ item: external(o, 1), reserved: 1, drop: 1 }]);
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });
    expect((await packageRow(b.id)).status).toBe('backordered');
  });

  it('AC16: kiện cũ hết dòng sau khi kiện thay được lấy: kiện cũ cancelled, lịch sử replaced, needs_open false', async () => {
    const { v, packageId, next, a, b } = await packedSplit();

    await ingest(v.companyId, withStatus(next, 'in_transit'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'cancelled', needs_open: false, open_purpose: null });
    expect(await lineRows(packageId)).toEqual([]);
    expect(await transitionsOf(packageId)).toContainEqual({ action: 'replaced', from_state: 'packed', to_state: 'cancelled', source: 'marketplace' });
    expect(await transitionReasonsOf(packageId, 'cancelled')).toEqual([expect.stringMatching(/^Kiện thay KH-.+ đã được lấy$/)]);
    for (const p of [a, b]) expect(await packageRow(p.id)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace' });
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([8, 0]);
  });

  it('AC18: kéo lại sau AC15, AC16: không đổi gì', async () => {
    const one = await packedSplit();
    const two = await packedSplit();
    const taken = itemStatuses(two.next, ['in_transit', 'pending']);
    await ingest(two.v.companyId, taken);
    for (const { companyId, orderId, next } of [
      { companyId: one.v.companyId, orderId: one.orderId, next: one.next },
      { companyId: two.v.companyId, orderId: two.orderId, next: taken },
    ]) {
      const before = await packagesOf(orderId);
      const history = await historyCount(orderId);

      await ingest(companyId, next);

      expect(await packagesOf(orderId)).toEqual(before);
      expect(await historyCount(orderId)).toBe(history);
    }
  });

  it('Review 3 (review #393): nhóm gồm món của kiện packed và kiện reserved: kiện thay giữ ngay dòng từ kiện reserved trong cùng giao dịch, đơn khác không chen vào; dòng từ kiện packed chờ thay; khi được lấy thì nhận phần giữ, không forced', async () => {
    // Kho chỉ có 2: cả hai món của đơn đang giữ; đơn khác chờ cùng SKU.
    const v = await setup(2);
    const o = remote(v, { lines: 2, packages: 2 });
    const { orderId } = await ingest(v.companyId, o);
    await ingest(v.companyId, withStatus(o, 'packed', o.lines[0]!.packageCode!));
    const other = await ingest(v.companyId, remote(v, { lines: 1 }));
    expect((await packagesOf(other.orderId))[0]!.status).toBe('backordered');
    const before = await packagesOf(orderId);
    const packed = before.find((r) => r.items.includes(external(o, 0)))!;
    const reserved = before.find((r) => r.items.includes(external(o, 1)))!;
    expect([packed.status, reserved.status]).toEqual(['packed', 'reserved']);
    const code = `FP-N-${tag()}`;
    const next = withStatus(relabeled(o, [code, code]), 'pending');

    await ingest(v.companyId, next);

    const fresh = (await packagesOf(orderId)).find((r) => r.platformCode === code)!;
    // Kiện thay còn chờ thay (món 1 nằm trong kiện packed) nên ở `backordered`, nhưng món 2 (từ kiện reserved) đã giữ.
    expect(fresh).toMatchObject({ status: 'backordered', items: [external(o, 0), external(o, 1)] });
    expect(await lineRows(fresh.id)).toEqual([
      { item: external(o, 0), reserved: 0, drop: 0 },
      { item: external(o, 1), reserved: 1, drop: 0 },
    ]);
    expect(await packageRow(reserved.id)).toMatchObject({ status: 'cancelled' });
    expect(await packageRow(packed.id)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);
    // Lượt phân hàng của phần vừa nhả: đơn khác không giành được (kiện thay đã giữ trong cùng giao dịch).
    expect((await allocate(v.companyId, v.variantId)).held).toEqual([]);
    expect((await packagesOf(other.orderId))[0]!.status).toBe('backordered');

    await ingest(v.companyId, withStatus(next, 'in_transit'));

    expect(await packageRow(fresh.id)).toMatchObject({ status: 'in_transit', handover_source: 'marketplace', needs_attention: false });
    expect(await packageRow(packed.id)).toMatchObject({ status: 'cancelled', needs_open: false });
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([0, 0]);
    expect((await packagesOf(other.orderId))[0]!.status).toBe('backordered');
  });

  it('Review 3 (review #393): kiện thay giữ một phần, kho mở kiện cũ: phần chờ thay được giữ, kiện thay sang reserved, không giữ trùng phần đã giữ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, packages: 2 });
    const { orderId } = await ingest(v.companyId, o);
    await ingest(v.companyId, withStatus(o, 'packed', o.lines[0]!.packageCode!));
    const packed = (await packagesOf(orderId)).find((r) => r.items.includes(external(o, 0)))!;
    const code = `FP-N-${tag()}`;
    await ingest(v.companyId, withStatus(relabeled(o, [code, code]), 'pending'));
    const fresh = (await packagesOf(orderId)).find((r) => r.platformCode === code)!;
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);

    const res = await packingApp().post(`/api/v1/fulfillment/packages/${packed.id}/open`).set('Authorization', `Bearer ${v.token}`).send({ version: (await packageRow(packed.id)).version });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await packageRow(packed.id)).toMatchObject({ status: 'cancelled' });
    expect(await packageRow(fresh.id)).toMatchObject({ status: 'reserved' });
    expect((await lineRows(fresh.id)).map((l) => l.reserved)).toEqual([1, 1]);
    const stock = await stockOfVariant(v.companyId, v.variantId);
    expect([stock.onHand, stock.reserved]).toEqual([10, 2]);
  });

  it('Review 3 (review #393): sàn huỷ kiện thay đang giữ một phần: nhả đúng phần đã giữ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, packages: 2 });
    const { orderId } = await ingest(v.companyId, o);
    await ingest(v.companyId, withStatus(o, 'packed', o.lines[0]!.packageCode!));
    const code = `FP-N-${tag()}`;
    const next = withStatus(relabeled(o, [code, code]), 'pending');
    await ingest(v.companyId, next);
    const fresh = (await packagesOf(orderId)).find((r) => r.platformCode === code)!;
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(2);

    await ingest(v.companyId, withCancel(next, 'cancellation'));

    expect(await packageRow(fresh.id)).toMatchObject({ status: 'cancelled' });
    expect((await lineRows(fresh.id)).map((l) => l.reserved)).toEqual([0, 0]);
    // Còn phần giữ của kiện cũ đã đóng (chờ mở để huỷ).
    expect((await stockOfVariant(v.companyId, v.variantId)).reserved).toBe(1);
  });

  it('Review 4: kiện chờ thay chỉ có dòng không quản tồn: backordered lúc lập, không reserved', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 1, untracked: 1, status: 'packed' });
    const { orderId, packageId } = await ingest(v.companyId, o);
    const code = `FP-Q-${tag()}`;

    await ingest(v.companyId, withStatus(relabeled(o, [`FP-A-${tag()}`, code]), 'pending'));

    const gift = (await packagesOf(orderId)).find((r) => r.platformCode === code)!;
    expect(gift).toMatchObject({ status: 'backordered', replaces: packageId, items: [external(o, 1)] });
  });
});

describe('hạn bàn giao của kiện thay khi sàn chia lại (KH-B01)', () => {
  const deadline = new Date('2026-11-23T05:00:00Z');
  const shipByOf = async (orderId: string) =>
    (
      await testPool().query<{ status: string; ship_by: Date | null; replaces: string | null }>(
        'select status, ship_by, replaces_package_id as replaces from "order".packages where order_id = $1',
        [orderId],
      )
    ).rows;

  it('kiện chưa đóng chia thành hai mã mới cùng lượt sàn có hạn: hai kiện thay nhận hạn, kiện cũ huỷ giữ hạn cũ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2 });
    const { orderId, packageId } = await ingest(v.companyId, o);

    await ingest(v.companyId, { ...relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]), shipBy: deadline });

    const rows = await shipByOf(orderId);
    expect(rows.filter((r) => r.replaces === packageId).map((r) => r.ship_by)).toEqual([deadline, deadline]);
    expect(rows.find((r) => r.replaces === null)).toMatchObject({ status: 'cancelled', ship_by: null });
  });

  it('kiện đã đóng chia lại: kiện cũ chờ dỡ và hai kiện thay cùng nhận hạn mới ở lượt sau', async () => {
    const { v, orderId, next } = await packedSplit();

    await ingest(v.companyId, { ...next, shipBy: deadline });

    const rows = await shipByOf(orderId);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.ship_by).toEqual(deadline);
  });
});

/** Kiện chờ đổi ghép như sau ca 19 của spec 237 (dấu trên dòng, Cần mở `remap`), dựng thẳng bằng SQL. */
async function markRemap(packageId: string) {
  await testPool().query(`update "order".packages set needs_open = true, open_purpose = 'remap' where id = $1`, [packageId]);
  await testPool().query(`update "order".package_lines set remap_pending = true where package_id = $1 and pending_drop_qty = 0`, [packageId]);
}

// Mục đích Cần mở khi kiện còn dấu chờ đổi ghép (spec 237 §5.6, D17, D18).
describe('chia lại kiện và dấu chờ đổi ghép (spec 237 D17, D18)', () => {
  it('D2-G12 19c: kiện packed Cần mở resplit có dòng sống mang dấu, kiện thay được lấy → mục đích thành remap, không gỡ', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { packageId } = await ingest(v.companyId, o);
    // Sàn giữ mã cũ cho món 1 (vẫn đóng), món 2 sang mã mới: kiện cũ còn món 1, chờ mở để bỏ món 2.
    const next = itemStatuses(relabeled(o, [o.lines[0]!.packageCode, `FP-B-${tag()}`]), ['packed', 'pending']);
    await ingest(v.companyId, next);
    expect(await packageRow(packageId)).toMatchObject({ needs_open: true, open_purpose: 'resplit' });
    // Đổi ghép SKU của món 1 lúc kiện chờ chia lại: dấu trên dòng sống, mục đích giữ resplit.
    await testPool().query('update "order".package_lines set remap_pending = true where package_id = $1 and pending_drop_qty = 0', [packageId]);

    await ingest(v.companyId, itemStatuses(next, ['packed', 'in_transit']));

    expect(await lineRows(packageId)).toEqual([{ item: external(o, 0), reserved: 1, drop: 0 }]);
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'remap' });
  });

  it('D2-G12 19d: kiện mang remap, sàn chia lại kiện → mục đích resplit', async () => {
    const v = await setup(10);
    const o = remote(v, { lines: 2, status: 'packed' });
    const { packageId } = await ingest(v.companyId, o);
    await markRemap(packageId);

    await ingest(v.companyId, withStatus(relabeled(o, [`FP-A-${tag()}`, `FP-B-${tag()}`]), 'pending'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'resplit' });
  });
});
