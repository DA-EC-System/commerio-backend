import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { HandOverResult, Package } from '#src/modules/order/fulfillment/api/schemas.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, packageDocuments, packageLineRows, packageRow, seedPackage, stockOfVariant } from './helpers.ts';

const app = () => request(testApp());
let company: Awaited<ReturnType<typeof createCompany>>;
let warehouse: Awaited<ReturnType<typeof addMember>>;
let ceoId: string;
let variantId: string;

beforeAll(async () => {
  company = await createCompany();
  warehouse = await addMember(company.companyId, 'warehouse');
  ({ variantId } = await createVariant(company.companyId));
  await receive(company.companyId, variantId, 1000, 100000);
  const { rows } = await testPool().query<{ id: string }>(
    `select a.id from core.accounts a join core.memberships m on m.account_id = a.id where m.company_id = $1 and a.email = $2`,
    [company.companyId, company.ceo.email],
  );
  ceoId = rows[0]!.id;
});

const versionOf = async (id: string) => (await packageRow(id)).version;
const handOver = async (id: string) =>
  HandOverResult.parse(
    (
      await app()
        .post('/api/v1/fulfillment/packages/hand-over')
        .set('Authorization', `Bearer ${warehouse.token}`)
        .send({ packages: [{ id, version: await versionOf(id) }] })
    ).body,
  );
const undo = async (id: string, body: Record<string, unknown>, token = company.ceo.token) =>
  app().post(`/api/v1/fulfillment/packages/${id}/undo-handover`).set('Authorization', `Bearer ${token}`).send(body);

/** Kiện kho vừa quét bàn giao (trừ tồn thật). */
async function scanned(p: { quantity?: number; cancelling?: boolean } = {}) {
  const seeded = await seedPackage(company.companyId, {
    status: 'awaiting_pickup',
    cancelling: p.cancelling,
    lines: [{ variantId, quantity: p.quantity ?? 2, reserved: true }],
  });
  expect((await handOver(seeded.packageId)).handedOver).toHaveLength(1);
  return seeded;
}

describe('POST /fulfillment/packages/:id/undo-handover (21 §19.2)', () => {
  it('D2-06 AC5 US-DH-09.1: CEO huỷ có lý do → kiện chờ lấy, phiếu DX, tồn cộng lại, dòng giữ hàng lại, lịch sử có lý do', async () => {
    const before = await stockOfVariant(company.companyId, variantId);
    const p = await scanned({ quantity: 2 });

    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Quét nhầm kiện' });

    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg.status).toBe('awaiting_pickup');
    expect(pkg.statusHistory.at(-1)).toMatchObject({ from: 'in_transit', to: 'awaiting_pickup', reason: 'Quét nhầm kiện' });
    expect((await packageDocuments(p.packageId)).map((d) => d.kind)).toEqual(['shipment', 'shipment_reversal']);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: before.onHand, reserved: before.reserved + 2 });
    expect(await packageLineRows(p.packageId)).toMatchObject([{ reserved_qty: 2, stock_deducted: false, unit_cost: null }]);
    expect(await packageRow(p.packageId)).toMatchObject({ handover_reverted_by: ceoId, handover_source: null, handed_over_at: null });
  });

  it('AC5: bàn giao lại sau khi huỷ → trừ lại đúng một lần, phiếu XK mới', async () => {
    const p = await scanned({ quantity: 3 });
    await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Quét nhầm' });
    const afterUndo = await stockOfVariant(company.companyId, variantId);

    expect((await handOver(p.packageId)).handedOver).toHaveLength(1);

    expect((await packageDocuments(p.packageId)).map((d) => d.kind)).toEqual(['shipment', 'shipment_reversal', 'shipment']);
    expect(await stockOfVariant(company.companyId, variantId)).toMatchObject({ onHand: afterUndo.onHand - 3, reserved: afterUndo.reserved - 3 });
  });

  it('D2-06r: thiếu lý do → 422 reason_required', async () => {
    const p = await scanned();
    for (const body of [{ version: await versionOf(p.packageId), reason: '   ' }, { version: await versionOf(p.packageId) }]) {
      const res = await undo(p.packageId, body);
      expect(res.status).toBe(422);
      expect(res.body.type).toBe('/problems/reason_required');
    }
    expect((await packageRow(p.packageId)).status).toBe('in_transit');
  });

  it('D2-06g: sàn đã xác nhận lấy → 409 handover_confirmed_by_platform', async () => {
    const p = await scanned();
    await testPool().query('update "order".packages set pickup_confirmed_at = now() where id = $1', [p.packageId]);
    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm' });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/handover_confirmed_by_platform');
    expect(await packageDocuments(p.packageId)).toHaveLength(1);
  });

  it('D2-06g: kiện vào in_transit do sàn báo → 409 handover_confirmed_by_platform', async () => {
    const p = await seedPackage(company.companyId, { status: 'in_transit', handoverSource: 'marketplace', lines: [{ variantId, quantity: 1 }] });
    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm' });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/handover_confirmed_by_platform');
  });

  it('D2-06q: Kho, Admin, Sale → 403', async () => {
    const p = await scanned();
    const tokens = [warehouse.token, (await addMember(company.companyId, 'admin')).token, (await addMember(company.companyId, 'sale')).token];
    for (const token of tokens) {
      const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm' }, token);
      expect(res.status).toBe(403);
    }
    expect((await packageRow(p.packageId)).status).toBe('in_transit');
  });

  it('version cũ → 409 version_conflict kèm current', async () => {
    const p = await scanned();
    const res = await undo(p.packageId, { version: (await versionOf(p.packageId)) - 1, reason: 'Nhầm' });
    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/version_conflict');
    expect(Package.parse(res.body.current).status).toBe('in_transit');
  });

  it('gọi huỷ lần hai với version mới → 409 invalid_transition, tồn không đổi, chỉ một phiếu DX', async () => {
    const p = await scanned();
    await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm' });
    const after = await stockOfVariant(company.companyId, variantId);

    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm lần nữa' });

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('/problems/invalid_transition');
    expect(await stockOfVariant(company.companyId, variantId)).toEqual(after);
    expect((await packageDocuments(p.packageId)).filter((d) => d.kind === 'shipment_reversal')).toHaveLength(1);
  });

  it('kiện không có, công ty khác, id sai dạng → 404', async () => {
    const p = await scanned();
    const other = await createCompany();
    expect((await undo(p.packageId, { version: 0, reason: 'Nhầm' }, other.ceo.token)).status).toBe(404);
    expect((await undo('khong-phai-uuid', { version: 0, reason: 'Nhầm' })).status).toBe(404);
  });

  it('Review Focus 4: đơn đang huỷ → kiện về awaiting_pickup, cờ Cần xử lý "Đơn đang huỷ: dỡ kiện về kệ"', async () => {
    const p = await scanned({ cancelling: true });
    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Nhầm' });
    expect(res.status).toBe(200);
    const pkg = Package.parse(res.body);
    expect(pkg).toMatchObject({ status: 'awaiting_pickup', flagNote: 'Đơn đang huỷ: dỡ kiện về kệ' });
    expect(pkg.flags).toContain('needs_attention');
  });
});

describe('huỷ bàn giao kiện đang hoãn trừ (spec 199b §5.7)', () => {
  it('AC15: huỷ bàn giao kiện đang hoãn → awaiting_pickup, không phiếu DX, tồn không đổi, lịch sử có lý do', async () => {
    const own = await createCompany();
    const kho = await addMember(own.companyId, 'warehouse');
    const { variantId: v } = await createVariant(own.companyId);
    await receive(own.companyId, v, 5, 100000);
    const shopId = await channelShop(own.companyId, true);
    const p = await seedPackage(own.companyId, { status: 'awaiting_pickup', shopId, lines: [{ variantId: v, quantity: 1 }] });
    const scan = await app()
      .post('/api/v1/fulfillment/packages/hand-over')
      .set('Authorization', `Bearer ${kho.token}`)
      .send({ packages: [{ id: p.packageId, version: await versionOf(p.packageId) }] });
    expect(HandOverResult.parse(scan.body).handedOver).toHaveLength(1);
    const before = await stockOfVariant(own.companyId, v);

    const res = await undo(p.packageId, { version: await versionOf(p.packageId), reason: 'Quét nhầm' }, own.ceo.token);

    expect(res.status).toBe(200);
    expect(Package.parse(res.body).statusHistory.at(-1)).toMatchObject({ to: 'awaiting_pickup', reason: 'Quét nhầm' });
    expect(await packageDocuments(p.packageId)).toEqual([]);
    expect(await stockOfVariant(own.companyId, v)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    expect((await packageLineRows(p.packageId))[0]).toMatchObject({ reserved_qty: 0, stock_deducted: false });
  });
});
