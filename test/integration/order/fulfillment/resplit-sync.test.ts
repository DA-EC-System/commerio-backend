// Sàn chia lại kiện (#238 PR 3, spec §5.6, D22, D23, D29): đồng bộ kiện của đơn sàn khi danh sách kiện của sàn khác app.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import { setStockPort } from '#src/modules/order/fulfillment/service/stock-port.ts';
import type { PlatformOrder } from '#src/modules/order/index.ts';
import { testApp } from '../../helpers/http.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { splitByHand, stockOfVariant, transitionReasonsOf, transitionsOf } from './helpers.ts';
import { ingest, remote, withStatus } from './platform-fixtures.ts';

afterEach(() => setStockPort());

const tag = () => randomUUID().slice(0, 8);

async function setup(stock: number) {
  const company = await createCompany();
  const { variantId, sku } = await createVariant(company.companyId);
  if (stock > 0) await receive(company.companyId, variantId, stock, 100000);
  return { companyId: company.companyId, token: company.ceo.token, variantId, sku };
}

/** Mã kiện sàn của từng món (`codes[i]` cho món thứ i). */
const relabeled = (o: PlatformOrder, codes: readonly (string | null)[]): PlatformOrder => ({
  ...o,
  lines: o.lines.map((l, i) => ({ ...l, packageCode: codes[i] ?? null })),
});
const unpacked = (o: PlatformOrder) => relabeled(o, o.lines.map(() => null));

interface Row {
  id: string;
  code: string;
  status: string;
  platformCode: string | null;
  replaces: string | null;
  version: number;
  needsAttention: boolean;
  flagNote: string | null;
  needsOpen: boolean;
  openPurpose: string | null;
  items: string[];
}

/** Kiện của đơn theo mã app, kèm món (`external_line_id`) theo thứ tự dòng. */
async function packagesOf(orderId: string): Promise<Row[]> {
  const { rows } = await testPool().query<Row>(
    `select p.id, p.code, p.status, p.platform_package_code as "platformCode", p.replaces_package_id as "replaces", p.version,
            p.needs_attention as "needsAttention", p.flag_note as "flagNote", p.needs_open as "needsOpen", p.open_purpose as "openPurpose",
            coalesce(array_agg(ol.external_line_id order by ol.external_line_id) filter (where ol.id is not null), '{}') as items
       from "order".packages p
       left join "order".package_lines pl on pl.package_id = p.id
       left join "order".order_lines ol on ol.id = pl.order_line_id
      where p.order_id = $1 group by p.id order by p.code`,
    [orderId],
  );
  return rows;
}

async function orderFlag(orderId: string) {
  const { rows } = await testPool().query<{ needs_attention: boolean; attention_note: string | null }>(
    'select needs_attention, attention_note from "order".orders where id = $1',
    [orderId],
  );
  return rows[0]!;
}

async function historyCount(orderId: string) {
  const { rows } = await testPool().query<{ n: number }>(
    `select count(*)::int as n from core.state_transitions where entity_type = 'packages'
       and entity_id in (select id from "order".packages where order_id = $1)`,
    [orderId],
  );
  return rows[0]!.n;
}

const external = (o: PlatformOrder, i: number) => o.lines[i]!.externalLineId;
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
