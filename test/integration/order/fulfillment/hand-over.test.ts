import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { HandOverResult } from '#src/modules/order/fulfillment/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { outboxOf, packageDocuments, packageLineRows, packageRow, seedPackage, stockOfVariant } from './helpers.ts';

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let warehouse: Awaited<ReturnType<typeof addMember>>;
let variantId: string;

beforeAll(async () => {
  company = await createCompany();
  warehouse = await addMember(company.companyId, 'warehouse');
  ({ variantId } = await createVariant(company.companyId));
  await receive(company.companyId, variantId, 1000, 100000);
});

const handOver = (packages: { id: string; version: number }[], token = warehouse.token) =>
  app().post('/api/v1/fulfillment/packages/hand-over').set('Authorization', `Bearer ${token}`).send({ packages });

const awaiting = (quantity = 1) =>
  seedPackage(company.companyId, { status: 'awaiting_pickup', lines: [{ variantId, quantity, reserved: true }] });
const versionOf = async (id: string) => (await packageRow(id)).version;

describe('POST /fulfillment/packages/hand-over (21 §19.2)', () => {
  it('D2-05 AC1: quét 3 kiện awaiting_pickup → in_transit, phiếu XK, tồn giảm đúng số món, có sự kiện', async () => {
    const pkgs = [await awaiting(1), await awaiting(2), await awaiting(3)];
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await handOver(await Promise.all(pkgs.map(async (p) => ({ id: p.packageId, version: await versionOf(p.packageId) }))));

    expect(res.status).toBe(200);
    const body = HandOverResult.parse(res.body);
    expect(body.failed).toEqual([]);
    expect(body.handedOver.map((h) => h.id)).toEqual(pkgs.map((p) => p.packageId));
    for (const h of body.handedOver) expect(h.issue?.number).toMatch(/^XK-/);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 6, reserved: before.reserved - 6 });
    for (const p of pkgs) {
      expect(await packageRow(p.packageId)).toMatchObject({ status: 'in_transit', handover_source: 'scan', handed_over_by: warehouse.accountId });
      expect((await packageLineRows(p.packageId))[0]).toMatchObject({ stock_deducted: true, unit_cost: '100000.00', reserved_qty: 0 });
      expect(await outboxOf(p.orderId, 'fulfillment.package_shipped')).toHaveLength(1);
      expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toContainEqual({
        packageId: p.packageId,
        orderId: p.orderId,
        from: 'awaiting_pickup',
        to: 'in_transit',
      });
    }
  });

  it('AC2 US-DH-08.2: lô có kiện sai version, kiện reserved, kiện của công ty khác → failed đúng mã, kiện còn lại bàn giao', async () => {
    const ok = await awaiting();
    const stale = await awaiting();
    const reserved = await seedPackage(company.companyId, { status: 'reserved', lines: [{ variantId, quantity: 1, reserved: true }] });
    const other = await createCompany();
    const foreign = await seedPackage(other.companyId, {
      status: 'awaiting_pickup',
      lines: [{ variantId: (await createVariant(other.companyId)).variantId, quantity: 1 }],
    });

    const body = HandOverResult.parse(
      (
        await handOver([
          { id: ok.packageId, version: await versionOf(ok.packageId) },
          { id: stale.packageId, version: (await versionOf(stale.packageId)) + 7 },
          { id: reserved.packageId, version: await versionOf(reserved.packageId) },
          { id: foreign.packageId, version: 0 },
        ])
      ).body,
    );

    expect(body.handedOver.map((h) => h.id)).toEqual([ok.packageId]);
    expect(body.failed.map((f) => [f.packageId, f.code])).toEqual([
      [stale.packageId, 'version_conflict'],
      [reserved.packageId, 'invalid_transition'],
      [foreign.packageId, 'not_found'],
    ]);
    expect((await packageRow(stale.packageId)).status).toBe('awaiting_pickup');
  });

  it('AC3 US-DH-08.3: quét lại kiện đã bàn giao → already_handed_over; tồn không đổi', async () => {
    const p = await awaiting(2);
    const version = await versionOf(p.packageId);
    await handOver([{ id: p.packageId, version }]);
    const after = await stockOfVariant(company.companyId, variantId);

    const body = HandOverResult.parse((await handOver([{ id: p.packageId, version }])).body);

    expect(body.failed).toMatchObject([{ packageId: p.packageId, code: 'already_handed_over' }]);
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(after);
    expect(await packageDocuments(p.packageId)).toHaveLength(1);
  });

  it('AC3: hai người quét cùng kiện đua nhau → một thành công, một already_handed_over, tồn trừ một lần', async () => {
    const p = await awaiting(2);
    const version = await versionOf(p.packageId);
    const before = await stockOfVariant(company.companyId, variantId);
    const second = await addMember(company.companyId, 'warehouse');

    const [a, b] = await raceBehindLock(
      (holder) => holder.query('select id from "order".packages where id = $1 for update', [p.packageId]),
      2,
      () => Promise.all([handOver([{ id: p.packageId, version }]), handOver([{ id: p.packageId, version }], second.token)]),
    );

    const results = [HandOverResult.parse(a.body), HandOverResult.parse(b.body)];
    expect(results.map((r) => r.handedOver.length).sort()).toEqual([0, 1]);
    expect(results.flatMap((r) => r.failed.map((f) => f.code))).toEqual(['already_handed_over']);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand - 2 });
    expect(await packageDocuments(p.packageId)).toHaveLength(1);
  });

  it('AC3: kiện sàn đã báo in_transit rồi kho quét → already_handed_over', async () => {
    const p = await seedPackage(company.companyId, { status: 'in_transit', handoverSource: 'marketplace', lines: [{ variantId, quantity: 1 }] });
    const body = HandOverResult.parse((await handOver([{ id: p.packageId, version: await versionOf(p.packageId) }])).body);
    expect(body.failed).toMatchObject([{ packageId: p.packageId, code: 'already_handed_over' }]);
    expect(await packageDocuments(p.packageId)).toEqual([]);
  });

  it('review cuối #2: kiện sàn chờ lấy chưa ghép SKU → vẫn bàn giao, issue null, không phiếu, dòng chờ ghép muộn', async () => {
    const p = await seedPackage(company.companyId, { status: 'awaiting_pickup', lines: [{ variantId, quantity: 1 }] });
    await testPool().query('update "order".package_lines set variant_id = null where package_id = $1', [p.packageId]);

    const body = HandOverResult.parse((await handOver([{ id: p.packageId, version: await versionOf(p.packageId) }])).body);

    expect(body.failed).toEqual([]);
    expect(body.handedOver).toEqual([{ id: p.packageId, code: p.packageCode, issue: null }]);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'in_transit', handover_source: 'scan' });
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await packageLineRows(p.packageId)).toMatchObject([{ stock_deducted: false }]);
  });

  it('D2-05q: Admin, Sale → 403', async () => {
    const p = await awaiting();
    for (const role of ['admin', 'sale'] as const) {
      const res = await handOver([{ id: p.packageId, version: 0 }], (await addMember(company.companyId, role)).token);
      expect(res.status, role).toBe(403);
    }
    expect((await packageRow(p.packageId)).status).toBe('awaiting_pickup');
  });

  it('Review Focus 3: cùng một kiện hai lần trong body → 422, không kiện nào bàn giao', async () => {
    const p = await awaiting();
    const q = await awaiting();
    const res = await handOver([
      { id: p.packageId, version: await versionOf(p.packageId) },
      { id: q.packageId, version: await versionOf(q.packageId) },
      { id: p.packageId, version: await versionOf(p.packageId) },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/validation_failed');
    expect(res.body.errors).toHaveProperty('packages');
    expect((await packageRow(p.packageId)).status).toBe('awaiting_pickup');
    expect((await packageRow(q.packageId)).status).toBe('awaiting_pickup');
  });

  it('body rỗng, quá 50 kiện, id không phải uuid → 422', async () => {
    expect((await handOver([])).status).toBe(422);
    expect((await handOver([{ id: 'abc', version: 0 }])).status).toBe(422);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, version: 0 }));
    expect((await handOver(many)).status).toBe(422);
  });
});

describe('dữ liệu test', () => {
  it('tồn của công ty test đủ cho các ca (bảo đảm test không chạy vào bàn giao bắt buộc)', async () => {
    const { rows } = await testPool().query('select invariant_broken from product.stock_levels where variant_id = $1', [variantId]);
    expect(rows[0]).toEqual({ invariant_broken: false });
  });
});
