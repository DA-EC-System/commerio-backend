import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';
import { updatePackage } from '#src/modules/order/fulfillment/repository/packages.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { packageRow, seedPackage } from './helpers.ts';

// Cột thất lạc và luật xoá cột `lost_*` trong `updatePackage` (spec #238 §5.1, §5.3, D14, D21).

let companyId: string;
let variantId: string;

beforeAll(async () => {
  ({ companyId } = await createCompany());
  ({ variantId } = await createVariant(companyId));
});

const seed = async (status: PackageStatus, extra: { needsOpen?: boolean } = {}) =>
  (await seedPackage(companyId, { status, lines: [{ variantId, quantity: 1 }], ...extra })).packageId;

/** Ghi thẳng các cột `lost_*` bằng role chủ bảng (`seedPackage` không nhận các cột này). */
async function setColumns(packageId: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  await testPool().query(
    `update "order".packages set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`,
    [packageId, ...Object.values(cols)],
  );
}

const report = (by = randomUUID()) => ({ lost_reported_by: by, lost_reported_at: new Date(), lost_claim_code: 'KN-001' });
const reportCleared = { lost_reported_by: null, lost_reported_at: null, lost_claim_code: null };
const confirmCleared = { lost_confirmed_by: null, lost_source: null, lost_self_approved: false };

const update = (id: string, patch: Parameters<typeof updatePackage>[1]) => withCompany(companyId, () => updatePackage(id, patch));

describe('luật xoá cột lost_* trong updatePackage (D14, D21)', () => {
  it('ghi status khác lost thì xoá nguồn và người xác nhận', async () => {
    const id = await seed('lost');
    const by = randomUUID();
    await setColumns(id, { ...report(by), lost_confirmed_by: by, lost_self_approved: true, lost_source: 'user' });

    await update(id, { status: 'returned' });

    expect(await packageRow(id)).toMatchObject({ status: 'returned', ...confirmCleared, ...reportCleared });
  });

  it('rời lost sang trạng thái còn báo mất được thì vẫn xoá mọi cột lost_* (D14: sàn kéo lại)', async () => {
    const id = await seed('lost');
    await setColumns(id, { ...report(), lost_confirmed_by: randomUUID(), lost_source: 'user' });

    await update(id, { status: 'in_transit' });

    expect(await packageRow(id)).toMatchObject({ status: 'in_transit', ...confirmCleared, ...reportCleared });
  });

  it('ghi status không còn báo mất được thì xoá báo cáo treo', async () => {
    const id = await seed('in_transit');
    await setColumns(id, report());

    await update(id, { status: 'delivered', deliveredAt: new Date() });

    expect(await packageRow(id)).toMatchObject({ status: 'delivered', ...reportCleared });
  });

  it('ghi status vẫn báo mất được thì giữ báo cáo', async () => {
    const id = await seed('in_transit');
    const by = randomUUID();
    await setColumns(id, report(by));

    await update(id, { status: 'delivery_failed' });

    expect(await packageRow(id)).toMatchObject({ status: 'delivery_failed', lost_reported_by: by, lost_claim_code: 'KN-001' });
    expect((await packageRow(id)).lost_reported_at).not.toBeNull();
  });

  it('gỡ needs_open không đổi trạng thái thì xoá báo cáo treo', async () => {
    const id = await seed('packed', { needsOpen: true });
    await setColumns(id, report());

    await update(id, { needsOpen: false, openPurpose: null });

    expect(await packageRow(id)).toMatchObject({ status: 'packed', needs_open: false, ...reportCleared });
  });

  it('ghi cột khác không đụng báo cáo treo', async () => {
    const id = await seed('packed', { needsOpen: true });
    const by = randomUUID();
    await setColumns(id, report(by));

    await update(id, { needsAttention: true, flagNote: 'Ghi chú' });

    expect(await packageRow(id)).toMatchObject({ status: 'packed', needs_open: true, lost_reported_by: by });
  });

  it('giá trị truyền tường minh thắng luật', async () => {
    const id = await seed('in_transit');
    const reporter = randomUUID();
    const confirmer = randomUUID();
    await setColumns(id, report(reporter));

    await update(id, { status: 'lost', lostSource: 'user', lostConfirmedBy: confirmer });
    expect(await packageRow(id)).toMatchObject({
      status: 'lost', lost_source: 'user', lost_confirmed_by: confirmer, lost_reported_by: reporter, lost_claim_code: 'KN-001',
    });

    const other = await seed('in_transit');
    const at = new Date('2026-11-15T01:00:00Z');
    await update(other, { status: 'delivered', deliveredAt: new Date(), lostReportedBy: reporter, lostReportedAt: at, lostClaimCode: 'KN-002' });
    expect(await packageRow(other)).toMatchObject({ status: 'delivered', lost_reported_by: reporter, lost_reported_at: at, lost_claim_code: 'KN-002' });
  });
});

describe('ràng buộc thất lạc trong DB (spec #238 §5.1)', () => {
  it('AC10: DB chặn kiện lost thiếu nguồn', async () => {
    const id = await seed('in_transit');

    await expect(testPool().query(`update "order".packages set status = 'lost' where id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'packages_lost_confirmed',
    });
    await expect(
      testPool().query(`update "order".packages set status = 'lost', lost_source = 'marketplace' where id = $1`, [id]),
    ).resolves.toBeDefined();
  });

  it('AC10: kiện lost do người có người xác nhận khác người báo thì qua', async () => {
    const id = await seed('in_transit');
    await setColumns(id, report());

    await expect(
      testPool().query(`update "order".packages set status = 'lost', lost_source = 'user', lost_confirmed_by = $2 where id = $1`, [
        id,
        randomUUID(),
      ]),
    ).resolves.toBeDefined();
  });

  it('DB cho tự xác nhận khi lost_self_approved', async () => {
    const id = await seed('in_transit');
    const by = randomUUID();
    await setColumns(id, report(by));

    await expect(testPool().query('update "order".packages set lost_confirmed_by = $2 where id = $1', [id, by])).rejects.toMatchObject({
      code: '23514',
      constraint: 'packages_lost_second_person',
    });
    await expect(
      testPool().query('update "order".packages set lost_confirmed_by = $2, lost_self_approved = true where id = $1', [id, by]),
    ).resolves.toBeDefined();
  });

  it('lost_source chỉ nhận user hoặc marketplace', async () => {
    const id = await seed('in_transit');

    await expect(testPool().query(`update "order".packages set lost_source = 'system' where id = $1`, [id])).rejects.toMatchObject({
      code: '23514',
      constraint: 'packages_lost_source',
    });
  });
});
