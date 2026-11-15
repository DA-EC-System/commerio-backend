import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { Package, PackagePage } from '#src/modules/order/fulfillment/api/schemas.ts';
import { listPackages } from '#src/modules/order/fulfillment/service/packages.ts';
import { orderRefsOf } from '#src/modules/order/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createModuleContext } from '#src/wiring.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { seedPackage } from './helpers.ts';

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let variantId: string;
let warehouseToken: string;
let saleToken: string;

const get = (path: string, token = company.ceo.token) => app().get(`/api/v1/fulfillment${path}`).set('Authorization', `Bearer ${token}`);

const TABS = ['backordered', 'reserved', 'packed', 'awaiting_pickup', 'shipping', 'delivery_failed', 'returning', 'needs_open'] as const;
const hours = (h: number) => new Date(Date.UTC(2026, 10, 20) + h * 3_600_000);

const seeded: Record<string, { packageId: string; packageCode: string; orderCode: string }> = {};

beforeAll(async () => {
  company = await createCompany();
  ({ variantId } = await createVariant(company.companyId));
  warehouseToken = (await addMember(company.companyId, 'warehouse')).token;
  saleToken = (await addMember(company.companyId, 'sale')).token;
  const seed = async (key: string, p: Parameters<typeof seedPackage>[1]) => {
    seeded[key] = await seedPackage(company.companyId, p);
  };
  const line = [{ variantId, quantity: 1 }];
  await seed('backordered', { status: 'backordered', lines: line });
  await seed('reservedLate', { status: 'reserved', lines: line, shipBy: hours(5) });
  await seed('reservedNoDeadline', { status: 'reserved', lines: line, shipBy: null });
  await seed('reservedEarly', { status: 'reserved', lines: line, shipBy: hours(1), trackingCode: `VD-${randomUUID().slice(0, 6)}` });
  await seed('reservedUnpaid', { status: 'reserved', lines: line, orderStatus: 'unpaid' });
  await seed('packed', { status: 'packed', lines: line, needsOpen: true });
  await seed('awaitingPickup', { status: 'awaiting_pickup', lines: line });
  await seed('inTransit', { status: 'in_transit', lines: line });
  await seed('selfDelivering', { status: 'self_delivering', lines: line });
  await seed('failed', { status: 'delivery_failed', lines: line });
  await seed('returning', { status: 'returning', lines: line });
  await seed('delivered', { status: 'delivered', lines: line });
});

const codes = (items: { code: string }[]) => items.map((i) => i.code);

it('chi tiết kiện trả nhà vận chuyển đã chọn và cờ Lỗi lấy vận đơn', async () => {
  const { companyId, ceo } = await createCompany();
  const variant = await createVariant(companyId);
  const { packageId } = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: variant.variantId, quantity: 1 }] });
  await testPool().query(`update "order".packages set carrier_code = 'GHN', carrier_name = 'Giao Hàng Nhanh', label_error = true where id = $1`, [packageId]);
  const res = await get(`/packages/${packageId}`, ceo.token);
  expect(res.status).toBe(200);
  const pkg = Package.parse(res.body);
  expect(pkg.carrier).toEqual({ code: 'GHN', name: 'Giao Hàng Nhanh' });
  expect(pkg.flags).toContain('label_error');
});

describe('GET /fulfillment/packages (21 §19.2)', () => {
  it('AC12: mỗi tab đúng kiện; counts đủ 8 tab, không đổi theo tab', async () => {
    const pages = await Promise.all(TABS.map(async (tab) => [tab, PackagePage.parse((await get(`/packages?tab=${tab}`)).body)] as const));
    const byTab = Object.fromEntries(pages);
    const c = (k: string) => seeded[k]!.packageCode;

    expect(codes(byTab.reserved!.items)).toEqual([c('reservedEarly'), c('reservedLate'), c('reservedNoDeadline')]);
    expect(codes(byTab.shipping!.items).sort()).toEqual([c('inTransit'), c('selfDelivering')].sort());
    expect(codes(byTab.needs_open!.items)).toEqual([c('packed')]);
    expect(codes(byTab.backordered!.items)).toEqual([c('backordered')]);
    expect(codes(byTab.awaiting_pickup!.items)).toEqual([c('awaitingPickup')]);
    expect(byTab.reserved!.counts).toEqual({
      backordered: 1,
      reserved: 3,
      packed: 1,
      awaiting_pickup: 1,
      shipping: 2,
      delivery_failed: 1,
      returning: 1,
      needs_open: 1,
    });
    for (const [, page] of pages) expect(page.counts).toEqual(byTab.reserved!.counts);
  });

  it('AC12: mặc định tab reserved, phân trang, sắp ship_by tăng dần, null cuối', async () => {
    const res = await get('/packages?pageSize=2');
    expect(res.status).toBe(200);
    const page = PackagePage.parse(res.body);
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 2 });
    expect(codes(page.items)).toEqual([seeded.reservedEarly!.packageCode, seeded.reservedLate!.packageCode]);
    const second = PackagePage.parse((await get('/packages?pageSize=2&page=2')).body);
    expect(codes(second.items)).toEqual([seeded.reservedNoDeadline!.packageCode]);
  });

  it('AC12: tìm theo mã kiện, mã đơn, mã vận đơn; counts theo search', async () => {
    const k = seeded.reservedEarly!;
    const tracking = (await testPool().query<{ tracking_code: string }>('select tracking_code from "order".packages where id = $1', [k.packageId])).rows[0]!.tracking_code;
    for (const term of [k.packageCode.toLowerCase(), k.orderCode, tracking]) {
      const page = PackagePage.parse((await get(`/packages?search=${encodeURIComponent(term)}`)).body);
      expect(codes(page.items), term).toEqual([k.packageCode]);
      expect(page.counts.reserved).toBe(1);
      expect(page.counts.shipping).toBe(0);
    }
  });

  it('AC12: lọc shopId', async () => {
    const shopId = randomUUID();
    const own = await seedPackage(company.companyId, { status: 'reserved', lines: [{ variantId, quantity: 1 }], shopId });
    const page = PackagePage.parse((await get(`/packages?shopId=${shopId}`)).body);
    expect(codes(page.items)).toEqual([own.packageCode]);
  });

  it('Review Focus 5: search "%" hoặc "_" không khớp kiện không chứa ký tự đó', async () => {
    for (const term of ['%', '_']) {
      const page = PackagePage.parse((await get(`/packages?search=${encodeURIComponent(term)}`)).body);
      expect(page.total, term).toBe(0);
    }
  });

  it('Kho xem được; Sale → 403; tham số sai 422', async () => {
    expect((await get('/packages', warehouseToken)).status).toBe(200);
    const denied = await get('/packages', saleToken);
    expect(denied.status).toBe(403);
    expect((await get('/packages?tab=khac')).status).toBe(422);
    expect((await get('/packages?pageSize=101')).status).toBe(422);
  });

  it('số câu SQL của trang 2 kiện và trang 10 kiện bằng nhau', async () => {
    const ctx = { ...createModuleContext(), orderRefsOf };
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const run = async (pageSize: number) => {
      queries.mockClear();
      const page = await withCompany(company.companyId, () => listPackages(ctx, { tab: 'shipping', page: 1, pageSize }));
      return { items: page.items.length, queries: queries.mock.calls.length };
    };
    try {
      const other = await createCompany();
      const v = (await createVariant(other.companyId)).variantId;
      for (let i = 0; i < 10; i++) await seedPackage(other.companyId, { status: 'in_transit', lines: [{ variantId: v, quantity: 1 }] });
      const small = await run(2);
      queries.mockClear();
      const big = await withCompany(other.companyId, () => listPackages(ctx, { tab: 'shipping', page: 1, pageSize: 10 }));
      expect(big.items).toHaveLength(10);
      expect(queries.mock.calls.length).toBe(small.queries);
    } finally {
      queries.mockRestore();
    }
  });
});

describe('GET /fulfillment/packages/:id', () => {
  it('AC12: trả Package có statusHistory; công ty khác và id không phải uuid → 404', async () => {
    const { packageId, packageCode } = seeded.inTransit!;
    await testPool().query(
      `insert into core.state_transitions (company_id, entity_type, entity_id, from_state, to_state, action, source)
       values ($1, 'packages', $2, 'awaiting_pickup', 'in_transit', 'hand_over', 'user')`,
      [company.companyId, packageId],
    );
    const res = await get(`/packages/${packageId}`);
    expect(res.status).toBe(200);
    const p = Package.parse(res.body);
    expect(p).toMatchObject({ code: packageCode, status: 'in_transit', order: { code: seeded.inTransit!.orderCode, status: 'processing' } });
    expect(p.lines).toMatchObject([{ variantId, quantity: 1 }]);
    expect(p.statusHistory.map((h) => [h.from, h.to])).toEqual([['awaiting_pickup', 'in_transit']]);

    const other = await createCompany();
    expect((await get(`/packages/${packageId}`, other.ceo.token)).status).toBe(404);
    expect((await get('/packages/khong-phai-uuid')).status).toBe(404);
  });
});
