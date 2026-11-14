import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { EVENT_SCHEMAS } from '#src/modules/core/platform/domain/events.ts';
import { Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { outboxOf, packageDocuments, packageRow, seedPackage, stockOfVariant } from './helpers.ts';

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let warehouse: Awaited<ReturnType<typeof addMember>>;
let variantId: string;

beforeAll(async () => {
  company = await createCompany();
  warehouse = await addMember(company.companyId, 'warehouse');
  ({ variantId } = await createVariant(company.companyId));
  await receive(company.companyId, variantId, 100, 100000);
});

const versionOf = async (id: string) => (await packageRow(id)).version;
type Lines = { variantId: string; quantity: unknown }[];
const scan = async (id: string, body: { version?: number; code: string; lines?: Lines | unknown }, token = warehouse.token) =>
  app()
    .post(`/api/v1/fulfillment/packages/${id}/receive-return`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: body.version ?? (await versionOf(id)), code: body.code, ...(body.lines !== undefined && { lines: body.lines }) });
const found = async (id: string, body: { version?: number; lines?: Lines } = {}, token = warehouse.token) =>
  app()
    .post(`/api/v1/fulfillment/packages/${id}/found`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: body.version ?? (await versionOf(id)), ...(body.lines !== undefined && { lines: body.lines }) });

/** Kiện đang hoàn về (đã trừ tồn lúc bàn giao, giá vốn chốt). */
const returning = (p: { status?: 'returning' | 'delivery_failed'; trackingCode?: string } = {}) =>
  seedPackage(company.companyId, {
    status: p.status ?? 'returning',
    trackingCode: p.trackingCode ?? null,
    lines: [{ variantId, quantity: 2, unitCost: '60000.00' }],
  });

const inspections = async (packageId: string) => (await packageDocuments(packageId)).filter((d) => d.kind === 'return_inspection');

const inspectionLines = async (documentId: string) =>
  (
    await testPool().query<{ variant_id: string; expected_qty: number; scanned_qty: number; status: string; created_by: string | null }>(
      `select l.variant_id, l.expected_qty, l.scanned_qty, d.status, d.created_by from product.stock_document_lines l
       join product.stock_documents d on d.id = l.document_id where l.document_id = $1`,
      [documentId],
    )
  ).rows;

/** Dòng phiếu KT theo SKU: số dự kiến, số quét, giá vốn mang theo từ dòng kiện. */
const inspectionByVariant = async (packageId: string) => {
  const kt = await inspections(packageId);
  expect(kt).toHaveLength(1);
  const { rows } = await testPool().query<{ variant_id: string; expected_qty: number; scanned_qty: number; unit_cost: string | null }>(
    'select variant_id, expected_qty, scanned_qty, unit_cost from product.stock_document_lines where document_id = $1',
    [kt[0]!.id],
  );
  return new Map(rows.map((r) => [r.variant_id, { expected: r.expected_qty, scanned: r.scanned_qty, unitCost: r.unit_cost }]));
};

/** Kiện hai SKU (A ×2 giá 60.000, B ×1 giá 15.000) và một SKU lạ C của công ty, không thuộc kiện. */
async function twoSkuPackage(status: 'returning' | 'lost' = 'returning') {
  const b = (await createVariant(company.companyId)).variantId;
  const c = (await createVariant(company.companyId)).variantId;
  const p = await seedPackage(company.companyId, {
    status,
    lines: [
      { variantId, quantity: 2, unitCost: '60000.00' },
      { variantId: b, quantity: 1, unitCost: '15000.00' },
    ],
  });
  return { ...p, b, c };
}

const quarantineOf = async (id: string) => (await stockOfVariant(company.companyId, id))?.quarantine ?? 0;

describe('POST /fulfillment/packages/:id/receive-return (spec 199c §5.5, 21 §19.2)', () => {
  it('D2-24 US-DH-11.1: Kho quét đúng mã kiện → returned, một phiếu KT nháp dự kiến 2 = số quét (chưa gửi lines: coi như quét đủ), người lập là người quét, chờ xử lý +2, tồn thực không đổi, có package_status_changed và package_returned', async () => {
    const p = await returning();
    const before = await stockOfVariant(company.companyId, variantId);

    const res = await scan(p.packageId, { code: p.packageCode });

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('returned');
    expect(pkg.statusHistory.at(-1)).toMatchObject({ from: 'returning', to: 'returned', by: { id: warehouse.accountId }, source: 'user' });
    const kt = await inspections(p.packageId);
    expect(kt).toHaveLength(1);
    expect(kt[0]!.number).toMatch(/^KT-/);
    expect(await inspectionLines(kt[0]!.id)).toEqual([
      { variant_id: variantId, expected_qty: 2, scanned_qty: 2, status: 'draft', created_by: warehouse.accountId },
    ]);
    // Kho cộng chờ xử lý ngay theo số quét (21 §11.1, #208); tồn thực chưa đổi tới khi phiếu ghi sổ.
    expect(await stockOfVariant(company.companyId, variantId)).toEqual({ ...before, quarantine: before.quarantine + 2 });
    expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toEqual([
      { packageId: p.packageId, orderId: p.orderId, from: 'returning', to: 'returned' },
    ]);
    const returned = (await outboxOf(p.orderId, 'fulfillment.package_returned')).map((e) => EVENT_SCHEMAS['fulfillment.package_returned'].parse(e));
    expect(returned).toHaveLength(1);
    expect(returned[0]).toMatchObject({ packageId: p.packageId, orderId: p.orderId });
  });

  it('US-DH-11.1: quét mã vận đơn viết khác hoa thường, có khoảng trắng → được', async () => {
    const p = await returning({ trackingCode: 'SPXVN0123ABC' });
    const res = await scan(p.packageId, { code: '  spxvn0123abc ' });
    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('returned');
  });

  it('US-DH-11.2: mã của kiện khác → 422 package_mismatch, kiện không đổi', async () => {
    const p = await returning();
    const other = await returning();
    const version = await versionOf(p.packageId);

    const res = await scan(p.packageId, { version, code: other.packageCode });

    expect(res.status).toBe(422);
    expect(res.body.type).toBe('/problems/package_mismatch');
    expect(res.body.errors).toEqual({ code: 'Mã quét không phải của kiện này' });
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'returning', version });
    expect(await inspections(p.packageId)).toEqual([]);
  });

  it('D2-24q: Admin, Sale → 403', async () => {
    const p = await returning();
    for (const role of ['admin', 'sale'] as const) {
      const res = await scan(p.packageId, { code: p.packageCode }, (await addMember(company.companyId, role)).token);
      expect(res.status).toBe(403);
    }
    expect((await packageRow(p.packageId)).status).toBe('returning');
  });

  it('kiện returning, version cũ → 409 version_conflict', async () => {
    const p = await returning();
    await testPool().query('update "order".packages set version = version + 1 where id = $1', [p.packageId]);
    const res = await scan(p.packageId, { version: 0, code: p.packageCode });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(Package.parse(res.body.current).status).toBe('returning');
  });

  it('kiện delivery_failed → 409 invalid_transition', async () => {
    const p = await returning({ status: 'delivery_failed' });
    const res = await scan(p.packageId, { code: p.packageCode });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(await inspections(p.packageId)).toEqual([]);
  });

  it('quét lần hai với version máy quét đã tải → 409 invalid_transition, vẫn một phiếu KT, một package_returned', async () => {
    const p = await returning();
    const loaded = await versionOf(p.packageId);
    expect((await scan(p.packageId, { version: loaded, code: p.packageCode })).status).toBe(200);
    // Lần hai gửi lại đúng version máy quét đã tải (lần một đã tăng version).
    const res = await scan(p.packageId, { version: loaded, code: p.packageCode });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(await inspections(p.packageId)).toHaveLength(1);
    expect(await outboxOf(p.orderId, 'fulfillment.package_returned')).toHaveLength(1);
  });

  it('Review Focus 3: kiện mọi dòng chưa ghép SKU → returned, không phiếu KT', async () => {
    const p = await returning();
    await testPool().query('update "order".package_lines set variant_id = null, unit_cost = null, stock_deducted = false where package_id = $1', [
      p.packageId,
    ]);
    const res = await scan(p.packageId, { code: p.packageCode });
    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('returned');
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await outboxOf(p.orderId, 'fulfillment.package_returned')).toHaveLength(1);
  });

  it('kiện công ty khác, id không phải uuid → 404', async () => {
    const p = await returning();
    const other = await createCompany();
    expect((await scan(p.packageId, { version: 0, code: p.packageCode }, other.ceo.token)).status).toBe(404);
    expect((await scan('khong-phai-uuid', { version: 0, code: 'KH-1' })).status).toBe(404);
    expect((await packageRow(p.packageId)).status).toBe('returning');
  });

  it('giá vốn: dòng phiếu KT mang đúng giá vốn đã lưu trên dòng kiện (21 §11.1 meta.unitCosts, 25 §7.1)', async () => {
    const p = await twoSkuPackage();
    expect((await scan(p.packageId, { code: p.packageCode })).status).toBe(200);
    const lines = await inspectionByVariant(p.packageId);
    expect(lines.get(variantId)).toEqual({ expected: 2, scanned: 2, unitCost: '60000.00' });
    expect(lines.get(p.b)).toEqual({ expected: 1, scanned: 1, unitCost: '15000.00' });
  });

  it('giá vốn: một SKU trên hai dòng kiện khác giá → dòng phiếu KT mang giá bình quân theo số lượng', async () => {
    const p = await seedPackage(company.companyId, {
      status: 'returning',
      lines: [
        { variantId, quantity: 1, unitCost: '50000.00' },
        { variantId, quantity: 3, unitCost: '70000.00' },
      ],
    });
    expect((await scan(p.packageId, { code: p.packageCode })).status).toBe(200);
    expect((await inspectionByVariant(p.packageId)).get(variantId)).toEqual({ expected: 4, scanned: 4, unitCost: '65000.00' });
  });

  it('lines: quét thiếu một món, thêm một món lạ → phiếu KT có dòng thiếu và dòng dự kiến 0, chờ xử lý tăng đúng số quét', async () => {
    const p = await twoSkuPackage();
    const before = { a: await quarantineOf(variantId), b: await quarantineOf(p.b), c: await quarantineOf(p.c) };

    const res = await scan(p.packageId, { code: p.packageCode, lines: [{ variantId, quantity: 1 }, { variantId: p.c, quantity: 3 }] });

    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('returned');
    const lines = await inspectionByVariant(p.packageId);
    expect(lines.get(variantId)).toMatchObject({ expected: 2, scanned: 1 });
    expect(lines.get(p.b)).toMatchObject({ expected: 1, scanned: 0 });
    expect(lines.get(p.c)).toMatchObject({ expected: 0, scanned: 3 });
    expect(await quarantineOf(variantId)).toBe(before.a + 1);
    expect(await quarantineOf(p.b)).toBe(before.b);
    expect(await quarantineOf(p.c)).toBe(before.c + 3);
  });

  it('lines rỗng: hợp lệ, mọi dòng kiện tính là thiếu, chờ xử lý không đổi', async () => {
    const p = await twoSkuPackage();
    const before = await quarantineOf(variantId);
    expect((await scan(p.packageId, { code: p.packageCode, lines: [] })).status).toBe(200);
    const lines = await inspectionByVariant(p.packageId);
    expect(lines.get(variantId)).toMatchObject({ expected: 2, scanned: 0 });
    expect(lines.get(p.b)).toMatchObject({ expected: 1, scanned: 0 });
    expect(await quarantineOf(variantId)).toBe(before);
  });

  it('kiện mọi dòng chưa ghép SKU, lines chỉ có món số quét 0 → returned, không phiếu KT (không lỗi 500)', async () => {
    const p = await returning();
    await testPool().query('update "order".package_lines set variant_id = null, unit_cost = null, stock_deducted = false where package_id = $1', [
      p.packageId,
    ]);
    const res = await scan(p.packageId, { code: p.packageCode, lines: [{ variantId, quantity: 0 }] });
    expect(res.status).toBe(200);
    expect(Package.parse(res.body).status).toBe('returned');
    expect(await packageDocuments(p.packageId)).toEqual([]);
  });

  it('lines sai (21 §15.3): không phải mảng, số âm, không nguyên, trùng variantId, SKU công ty khác → 422 validation_failed đúng khoá lỗi, kiện không đổi', async () => {
    const p = await twoSkuPackage();
    const foreign = (await createVariant((await createCompany()).companyId)).variantId;
    const cases: [unknown, string][] = [
      ['khong-phai-mang', 'lines'],
      [[{ variantId, quantity: -1 }], 'lines.0.quantity'],
      [[{ variantId, quantity: 1.5 }], 'lines.0.quantity'],
      [[{ variantId, quantity: 1 }, { variantId, quantity: 1 }], 'lines.1.variantId'],
      [[{ variantId, quantity: 1 }, { variantId: foreign, quantity: 1 }], 'lines.1.variantId'],
    ];
    for (const [lines, key] of cases) {
      const res = await scan(p.packageId, { code: p.packageCode, lines });
      expect(res.status, key).toBe(422);
      expect(res.body.type).toBe('/problems/validation_failed');
      expect(Object.keys(res.body.errors)).toEqual([key]);
    }
    expect((await packageRow(p.packageId)).status).toBe('returning');
    expect(await inspections(p.packageId)).toEqual([]);
  });
});

describe('POST /fulfillment/packages/:id/found (21 §19.2, 25 §8.3 E61)', () => {
  it('kiện lost, không gửi lines → returned, phiếu KT coi như quét đủ kèm giá vốn dòng kiện, chờ xử lý cộng, có package_returned', async () => {
    const p = await twoSkuPackage('lost');
    const before = await quarantineOf(variantId);

    const res = await found(p.packageId);

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('returned');
    expect(pkg.statusHistory.at(-1)).toMatchObject({ from: 'lost', to: 'returned', by: { id: warehouse.accountId }, source: 'user' });
    const lines = await inspectionByVariant(p.packageId);
    expect(lines.get(variantId)).toEqual({ expected: 2, scanned: 2, unitCost: '60000.00' });
    expect(lines.get(p.b)).toEqual({ expected: 1, scanned: 1, unitCost: '15000.00' });
    expect(await quarantineOf(variantId)).toBe(before + 2);
    expect(await outboxOf(p.orderId, 'fulfillment.package_status_changed')).toEqual([
      { packageId: p.packageId, orderId: p.orderId, from: 'lost', to: 'returned' },
    ]);
    expect(await outboxOf(p.orderId, 'fulfillment.package_returned')).toHaveLength(1);
  });

  it('gửi lines: quét thiếu một món, thêm một món lạ → phiếu KT như receive-return, chờ xử lý tăng đúng số quét', async () => {
    const p = await twoSkuPackage('lost');
    const before = { a: await quarantineOf(variantId), c: await quarantineOf(p.c) };

    const res = await found(p.packageId, { lines: [{ variantId, quantity: 1 }, { variantId: p.c, quantity: 2 }] });

    expect(res.status).toBe(200);
    const lines = await inspectionByVariant(p.packageId);
    expect(lines.get(variantId)).toMatchObject({ expected: 2, scanned: 1 });
    expect(lines.get(p.b)).toMatchObject({ expected: 1, scanned: 0 });
    expect(lines.get(p.c)).toMatchObject({ expected: 0, scanned: 2 });
    expect(await quarantineOf(variantId)).toBe(before.a + 1);
    expect(await quarantineOf(p.c)).toBe(before.c + 2);
  });

  it('kiện không ở lost (returning), gửi lần hai → 409 invalid_transition, vẫn một phiếu KT', async () => {
    const other = await twoSkuPackage('returning');
    const wrong = await found(other.packageId);
    expect(wrong.status).toBe(409);
    expect(wrong.body.type).toBe('/problems/invalid_transition');

    const p = await twoSkuPackage('lost');
    const loaded = await versionOf(p.packageId);
    expect((await found(p.packageId, { version: loaded })).status).toBe(200);
    const again = await found(p.packageId, { version: loaded });
    expect(again.status).toBe(409);
    expect(again.body.type).toBe('/problems/invalid_transition');
    expect(await inspections(p.packageId)).toHaveLength(1);
  });

  it('version cũ → 409 version_conflict; lines trùng variantId → 422; Admin, Sale → 403; công ty khác → 404', async () => {
    const p = await twoSkuPackage('lost');
    await testPool().query('update "order".packages set version = version + 1 where id = $1', [p.packageId]);
    const stale = await found(p.packageId, { version: 0 });
    expect(stale.status).toBe(409);
    expect(stale.body.type).toBe('/problems/version_conflict');

    const dup = await found(p.packageId, { lines: [{ variantId, quantity: 1 }, { variantId, quantity: 1 }] });
    expect(dup.status).toBe(422);
    expect(Object.keys(dup.body.errors)).toEqual(['lines.1.variantId']);

    for (const role of ['admin', 'sale'] as const) {
      expect((await found(p.packageId, {}, (await addMember(company.companyId, role)).token)).status).toBe(403);
    }
    expect((await found(p.packageId, { version: 0 }, (await createCompany()).ceo.token)).status).toBe(404);
    expect((await packageRow(p.packageId)).status).toBe('lost');
    expect(await inspections(p.packageId)).toEqual([]);
  });
});
