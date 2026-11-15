// Kiểm kê đếm thiếu hàng trong kiện đã đóng → cờ Cần mở với mục đích `stocktake` (spec #238 §5.5, D15, D21; AC 11, 11a).
// Thay cho cờ Cần xử lý "Dỡ kiện về kệ" (`DISMANTLE_NOTE`) không có thao tác đi kèm; cờ dạng cũ vẫn được gỡ.
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { PackagePage } from '#src/modules/order/fulfillment/api/schemas.ts';
import { DISMANTLE_NOTE, onStocktakePosted, runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { updatePackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive, setBuckets } from '../../product/inventory/helpers.ts';
import { channelShop, packageLineRows, packageRow, packingApp, seedPackage, transitionsOf } from './helpers.ts';
import { ingest, remote, withStatus } from './platform-fixtures.ts';

const ctx = { stockHoldOf: awaitingStocktakeShops };
const app = () => request(testApp());

let companyId: string;
let kho: Awaited<ReturnType<typeof addMember>>;
beforeAll(async () => {
  ({ companyId } = await createCompany());
  kho = await addMember(companyId, 'warehouse');
});

/** Sự kiện `inventory.stocktake_posted` của phiếu kiểm kê thường (không nguồn, Documents/21 §11.2). */
function posted(variantIds: string[]) {
  const now = new Date().toISOString();
  return {
    payload: {
      documentId: randomUUID(),
      number: 'KK-000002',
      source: null,
      postedAt: now,
      countedAt: now,
      lines: variantIds.map((variantId) => ({ variantId, countedQty: 0, delta: -1 })),
    },
  };
}

const stocktake = (variantIds: string[]) => withCompany(companyId, () => onStocktakePosted(ctx)(posted(variantIds)));
const run = (variantIds: string[], opts: Parameters<typeof runAllocation>[2] = {}) =>
  withCompany(companyId, () => runAllocation(ctx, { variantIds }, opts));

/** SKU mới, nhập `stock`. */
async function sku(stock: number) {
  const { variantId } = await createVariant(companyId);
  if (stock > 0) await receive(companyId, variantId, stock, 100000);
  return variantId;
}

/** Kiện `packed` đang giữ 1 món mỗi SKU; rồi kiểm kê đếm còn 0 cho mọi SKU (tồn thực < đang giữ). */
async function sealedHolder(opts: Partial<Parameters<typeof seedPackage>[1]> = {}, skus = 1) {
  const variants = await Promise.all(Array.from({ length: skus }, () => sku(1)));
  const p = await seedPackage(companyId, { status: 'packed', lines: variants.map((v) => ({ variantId: v, quantity: 1, reserved: true })), ...opts });
  for (const v of variants) await setBuckets(companyId, v, { onHand: 0, invariantBroken: true });
  return { ...p, variants };
}

const tab = async (name: string) => {
  const res = await app().get(`/api/v1/fulfillment/packages?tab=${name}&pageSize=100`).set('Authorization', `Bearer ${kho.token}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PackagePage.parse(res.body).items;
};

describe('kiểm kê đếm thiếu: cờ Cần mở stocktake (spec #238 §5.5)', () => {
  it('AC11: phiếu kiểm kê đếm thấp hơn hàng trong kiện packed đang giữ: needs_open, open_purpose stocktake, nằm trong tab needs_open, needs_attention không đổi', async () => {
    const p = await sealedHolder();

    await stocktake(p.variants);

    expect(await packageRow(p.packageId)).toMatchObject({
      status: 'packed',
      needs_open: true,
      open_purpose: 'stocktake',
      needs_attention: false,
      flag_note: null,
    });
    expect((await packageLineRows(p.packageId))[0]!.reserved_qty).toBe(1);
    const items = await tab('needs_open');
    expect(items.find((i) => i.id === p.packageId)).toMatchObject({ status: 'packed', openPurpose: 'stocktake', flags: expect.arrayContaining(['needs_open']) });
  });

  it('AC11: không mở mà hàng về đủ: lượt phân hàng kế gỡ cờ, kiện vẫn packed và vẫn giữ hàng', async () => {
    const p = await sealedHolder();
    await stocktake(p.variants);
    await receive(companyId, p.variants[0]!, 1, 100000);

    const r = await run(p.variants);

    expect(r.cleared).toEqual([p.packageId]);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: false, open_purpose: null });
    expect((await packageLineRows(p.packageId))[0]!.reserved_qty).toBe(1);
  });

  it('tồn mới về chưa đủ cho mọi SKU kiện đang giữ: cờ còn nguyên', async () => {
    const p = await sealedHolder({}, 2);
    await stocktake(p.variants);
    const { version } = await packageRow(p.packageId);
    await receive(companyId, p.variants[0]!, 1, 100000);

    // Lượt chỉ chạy qua SKU vừa về: vẫn xét mọi SKU kiện đang giữ.
    const r = await run([p.variants[0]!]);

    expect(r.cleared).toEqual([]);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake', version });
  });

  it('AC11a: kiện packed chưa giữ hàng sau phiếu đầu kỳ: có cờ stocktake, vẫn là ứng viên; giữ được thì cờ gỡ', async () => {
    const A = await sku(1);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A, quantity: 2 }] });

    const opening = await withCompany(companyId, () =>
      runAllocation({}, { all: true }, { opening: true, cause: { type: 'stocktake', documentId: randomUUID() } }),
    );
    expect(opening.flagged).toContain(p.packageId);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'stocktake', needs_attention: false });

    await receive(companyId, A, 1, 100000);
    const r = await run([A]);

    expect(r.held).toEqual([p.packageId]);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_open: false, open_purpose: null });
    expect((await packageLineRows(p.packageId))[0]!.reserved_qty).toBe(2);
  });

  it('Review 2: kiện đang chờ mở vì cancel bị đếm thiếu: giữ cancel; hàng về đủ cũng không gỡ', async () => {
    const p = await sealedHolder({ needsOpen: true, openPurpose: 'cancel' });
    const { version } = await packageRow(p.packageId);

    await stocktake(p.variants);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'cancel', version });

    await receive(companyId, p.variants[0]!, 1, 100000);
    const r = await run(p.variants);
    expect(r.cleared).toEqual([]);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'cancel', version });
  });

  it('Review 3: nhận lại cùng sự kiện kiểm kê: version của kiện đã gắn cờ không đổi', async () => {
    const p = await sealedHolder();
    const event = posted(p.variants);
    await withCompany(companyId, () => onStocktakePosted(ctx)(event));
    const { version } = await packageRow(p.packageId);

    const again = await withCompany(companyId, async () => {
      await onStocktakePosted(ctx)(event);
      return runAllocation(ctx, { variantIds: p.variants }, { stocktake: true });
    });

    expect(again).toMatchObject({ flagged: [], cleared: [] });
    expect(await packageRow(p.packageId)).toMatchObject({ needs_open: true, open_purpose: 'stocktake', version });
  });

  it('Review 4: kiện gắn cờ stocktake có báo cáo thất lạc treo, cờ tự gỡ: ba cột báo cáo về null, report-lost trả 409 not_awaiting_open', async () => {
    const p = await sealedHolder();
    await stocktake(p.variants);
    const report = async () =>
      app()
        .post(`/api/v1/fulfillment/packages/${p.packageId}/report-lost`)
        .set('Authorization', `Bearer ${kho.token}`)
        .send({ version: (await packageRow(p.packageId)).version, claimCode: 'Không thấy kiện khi dỡ' });
    const first = await report();
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect((await packageRow(p.packageId)).lost_reported_by).toBe(kho.accountId);

    await receive(companyId, p.variants[0]!, 1, 100000);
    expect((await run(p.variants)).cleared).toEqual([p.packageId]);

    expect(await packageRow(p.packageId)).toMatchObject({
      status: 'packed',
      needs_open: false,
      lost_reported_by: null,
      lost_reported_at: null,
      lost_claim_code: null,
    });
    const again = await report();
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(again.body.type).toBe('/problems/not_awaiting_open');
  });

  it('Review 5: kiện mang cờ dạng cũ (needs_attention + DISMANTLE_NOTE) giữ lại được hàng: cờ cũ gỡ', async () => {
    const A = await sku(1);
    const p = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A, quantity: 2 }] });
    await testPool().query('update "order".packages set needs_attention = true, flag_note = $2 where id = $1', [p.packageId, DISMANTLE_NOTE]);
    await receive(companyId, A, 1, 100000);

    const r = await run([A]);

    expect(r.held).toEqual([p.packageId]);
    expect(await packageRow(p.packageId)).toMatchObject({ needs_attention: false, flag_note: null, needs_open: false, open_purpose: null });
  });

  it('kiện đã có needs_attention vì lý do khác bị đếm thiếu: thêm needs_open stocktake, flag_note giữ nguyên', async () => {
    const p = await sealedHolder();
    await testPool().query(`update "order".packages set needs_attention = true, flag_note = 'Ghi chú khác' where id = $1`, [p.packageId]);

    const r = await run(p.variants, { stocktake: true });

    expect(r.flagged).toEqual([p.packageId]);
    expect(await packageRow(p.packageId)).toMatchObject({
      needs_open: true,
      open_purpose: 'stocktake',
      needs_attention: true,
      flag_note: 'Ghi chú khác',
    });
  });
});

describe('mở kiện stocktake, huỷ thắng kiểm kê (spec #238 §5.5, mục 10)', () => {
  let shopId: string;
  beforeAll(async () => {
    shopId = await channelShop(companyId, false);
  });

  const open = async (id: string, repack: () => Promise<'repacked' | 'not_supported'> = async () => 'not_supported') =>
    packingApp({ repack })
      .post(`/api/v1/fulfillment/packages/${id}/open`)
      .set('Authorization', `Bearer ${kho.token}`)
      .send({ version: (await packageRow(id)).version });

  /** Việc `fulfillment.allocation` đã xếp cho SKU (pg-boss, cùng giao dịch của bên gọi). */
  const allocationJobs = async (variantId: string) => {
    const { rows } = await testPool().query<{ data: { variantIds: string[] } }>(
      `select data from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1 and data->'variantIds' ? $2`,
      [companyId, variantId],
    );
    return rows.map((r) => r.data.variantIds);
  };

  it('AC11: kho mở kiện stocktake: kiện về reserved, cờ gỡ; chạy lượt phân hàng đã xếp thì kiện về backordered vì tồn vẫn thiếu', async () => {
    const p = await sealedHolder({ shopId, platformPackageCode: `FP-${randomUUID().slice(0, 8)}` });
    await stocktake(p.variants);
    const repack = async () => 'repacked' as const;

    const res = await open(p.packageId, repack);

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ status: 'reserved', openPurpose: null, platformPackageCode: null });
    expect(res.body.flags).not.toContain('needs_open');
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false, open_purpose: null });
    expect(await transitionsOf(p.packageId)).toContainEqual(expect.objectContaining({ action: 'open', from_state: 'packed', to_state: 'reserved' }));
    expect(await allocationJobs(p.variants[0]!)).toEqual([p.variants]);

    // Lượt phân hàng đã xếp (worker chạy thay bằng gọi thẳng): tồn thực vẫn 0 nên lấy lại phần giữ.
    const r = await run(p.variants);
    expect(r.reclaimed).toEqual([p.packageId]);
    expect((await packageRow(p.packageId)).status).toBe('backordered');
    expect((await packageLineRows(p.packageId))[0]!.reserved_qty).toBe(0);
  });

  it('mở kiện stocktake khi tồn đã đủ: kiện ở reserved sau lượt phân hàng', async () => {
    const p = await sealedHolder();
    await stocktake(p.variants);
    await receive(companyId, p.variants[0]!, 1, 100000);

    const res = await open(p.packageId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await allocationJobs(p.variants[0]!)).toEqual([p.variants]);

    const r = await run(p.variants);
    expect(r.reclaimed).toEqual([]);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'reserved', needs_open: false, open_purpose: null });
    expect((await packageLineRows(p.packageId))[0]!.reserved_qty).toBe(1);
  });

  it('Review 1: kiện đang chờ mở vì stocktake, sàn huỷ đơn: open_purpose thành cancel, đơn mang cờ cancelling', async () => {
    const v = await createVariant(companyId);
    await receive(companyId, v.variantId, 1, 100000);
    const o = remote(v, { status: 'packed' });
    const { orderId, packageId } = await ingest(companyId, o);
    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: false });
    await setBuckets(companyId, v.variantId, { onHand: 0, invariantBroken: true });
    await stocktake([v.variantId]);
    expect((await packageRow(packageId)).open_purpose).toBe('stocktake');

    await ingest(companyId, withStatus(o, 'cancelled'));

    expect(await packageRow(packageId)).toMatchObject({ status: 'packed', needs_open: true, open_purpose: 'cancel' });
    const { rows } = await testPool().query<{ status: string; cancelling: boolean }>('select status, cancelling from "order".orders where id = $1', [orderId]);
    expect(rows[0]).toEqual({ status: 'processing', cancelling: true });
  });

  it('kiện awaiting_pickup gắn cờ stocktake: open trả 409 invalid_transition (tới PR 3)', async () => {
    const p = await sealedHolder({ status: 'awaiting_pickup' });
    await stocktake(p.variants);
    expect((await packageRow(p.packageId)).open_purpose).toBe('stocktake');
    const { version } = await packageRow(p.packageId);

    const res = await open(p.packageId);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'awaiting_pickup', needs_open: true, open_purpose: 'stocktake', version });
  });

  it('kiện gắn cờ stocktake rời nhóm đã đóng (bàn giao): cờ gỡ, không nằm mãi trong tab Cần mở', async () => {
    const p = await sealedHolder({ status: 'awaiting_pickup' });
    await stocktake(p.variants);
    expect((await packageRow(p.packageId)).open_purpose).toBe('stocktake');

    await withCompany(companyId, () => updatePackage(p.packageId, { status: 'in_transit', handoverSource: 'scan', handedOverAt: new Date() }));

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'in_transit', needs_open: false, open_purpose: null });
  });

  it('kiện chờ mở vì cancel rời nhóm đã đóng: cờ giữ nguyên (hành vi cũ)', async () => {
    const p = await sealedHolder({ status: 'awaiting_pickup', needsOpen: true, openPurpose: 'cancel' });

    await withCompany(companyId, () => updatePackage(p.packageId, { status: 'in_transit', handoverSource: 'scan', handedOverAt: new Date() }));

    expect(await packageRow(p.packageId)).toMatchObject({ status: 'in_transit', needs_open: true, open_purpose: 'cancel' });
  });
});
