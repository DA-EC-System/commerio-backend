import { describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { onAllocationJob, onStockChanged, requestAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { outboxOf, packageRow, seedPackage } from './helpers.ts';
import { ingest, remote, setup, withStatus } from './platform-fixtures.ts';

const ctx = { stockHoldOf: awaitingStocktakeShops };

async function jobsOf(companyId: string) {
  const { rows } = await testPool().query<{ data: { companyId: string; variantIds: string[] } }>(
    `select data from pgboss.job where name = 'fulfillment.allocation' and data->>'companyId' = $1 order by created_on`,
    [companyId],
  );
  return rows.map((r) => r.data);
}

// Bốn đường vào của phân hàng (spec 199b §5.4).
describe('kích hoạt lượt phân hàng', () => {
  it('AC7: handler stock_changed chạy một lượt cho SKU đó và phát allocation_done', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: A, quantity: 1 }] });
    await receive(companyId, A, 1, 100000);

    await withCompany(companyId, () => onStockChanged(ctx)({ payload: { variantId: A } }));

    expect((await packageRow(p.packageId)).status).toBe('reserved');
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toEqual([{ variantIds: [A] }]);
  });

  it('Review Focus 5: nhận trùng stock_changed → lần hai không giữ thêm, không lấy lại thêm, vẫn phát allocation_done', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    const p = await seedPackage(companyId, { status: 'backordered', lines: [{ variantId: A, quantity: 1 }] });
    await receive(companyId, A, 1, 100000);
    const handle = onStockChanged(ctx);
    await withCompany(companyId, () => handle({ payload: { variantId: A } }));
    const before = await packageRow(p.packageId);

    await withCompany(companyId, () => handle({ payload: { variantId: A } }));

    const after = await packageRow(p.packageId);
    expect(after).toMatchObject({ status: 'reserved', version: before.version });
    expect(await outboxOf(companyId, 'fulfillment.allocation_done')).toHaveLength(2);
  });

  it('AC8: kiện sàn mới giữ được hàng → allocation_done với SKU của kiện; không giữ được thì không có', async () => {
    const held = await setup(10);
    await ingest(held.companyId, remote(held));
    expect(await outboxOf(held.companyId, 'fulfillment.allocation_done')).toEqual([{ variantIds: [held.variantId] }]);

    const short = await setup(null);
    await ingest(short.companyId, remote(short));
    expect(await outboxOf(short.companyId, 'fulfillment.allocation_done')).toEqual([]);
  });

  it('AC9: sàn huỷ kiện reserved → có việc fulfillment.allocation mang SKU; chạy việc → kiện backordered khác được giữ', async () => {
    const s = await setup(1);
    const o = remote(s);
    await ingest(s.companyId, o);
    const waiting = await seedPackage(s.companyId, { status: 'backordered', lines: [{ variantId: s.variantId, quantity: 1 }] });

    await ingest(s.companyId, withStatus(o, 'cancelled'));

    const jobs = await jobsOf(s.companyId);
    expect(jobs).toEqual([{ companyId: s.companyId, variantIds: [s.variantId] }]);
    await onAllocationJob(ctx)(jobs[0]!);
    expect((await packageRow(waiting.packageId)).status).toBe('reserved');
  });

  it('requestAllocation rỗng không xếp việc', async () => {
    const { companyId } = await createCompany();
    await withCompany(companyId, () => requestAllocation([]));
    expect(await jobsOf(companyId)).toEqual([]);
  });
});
