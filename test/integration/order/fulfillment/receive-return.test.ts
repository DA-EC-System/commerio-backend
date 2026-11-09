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
const scan = async (id: string, body: { version?: number; code: string }, token = warehouse.token) =>
  app()
    .post(`/api/v1/fulfillment/packages/${id}/receive-return`)
    .set('Authorization', `Bearer ${token}`)
    .send({ version: body.version ?? (await versionOf(id)), code: body.code });

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
    await testPool().query<{ variant_id: string; expected_qty: number; status: string }>(
      `select l.variant_id, l.expected_qty, d.status from product.stock_document_lines l
       join product.stock_documents d on d.id = l.document_id where l.document_id = $1`,
      [documentId],
    )
  ).rows;

describe('POST /fulfillment/packages/:id/receive-return (spec 199c §5.5, 21 §19.2)', () => {
  it('D2-24 US-DH-11.1: Kho quét đúng mã kiện → returned, một phiếu KT nháp số dự kiến 2, tồn thực không đổi, có package_status_changed và package_returned', async () => {
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
    expect(await inspectionLines(kt[0]!.id)).toEqual([{ variant_id: variantId, expected_qty: 2, status: 'draft' }]);
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(before);
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

  it('version cũ → 409 version_conflict', async () => {
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

  it('quét lần hai → 409 invalid_transition, vẫn một phiếu KT', async () => {
    const p = await returning();
    expect((await scan(p.packageId, { code: p.packageCode })).status).toBe(200);
    const res = await scan(p.packageId, { code: p.packageCode });
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
});
