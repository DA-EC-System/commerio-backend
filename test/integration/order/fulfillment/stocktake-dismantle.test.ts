// Phiếu kiểm kê (thường và đầu kỳ) đếm thấp hơn đang giữ: lấy lại hết kiện `reserved` mà vẫn thiếu thì kiện đã đóng đang
// giữ SKU đó bật Cần xử lý "Dỡ kiện về kệ" (Documents/25 §7.4 gạch cuối; review #298; chưa có khung việc #209).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { awaitingStocktakeShops } from '#src/modules/channel/index.ts';
import { DISMANTLE_NOTE, onStocktakePosted, runAllocation } from '#src/modules/order/fulfillment/service/allocation.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { receive, setBuckets } from '../../product/inventory/helpers.ts';
import { packageRow, seedPackage, stockOfVariant } from './helpers.ts';

const ctx = { stockHoldOf: awaitingStocktakeShops };

/** Sự kiện `inventory.stocktake_posted` như Documents/21 §11.2: mặc định phiếu thường (không nguồn). */
function posted(variantIds: string[], source: { type: 'shop_setup'; shopId: string } | null = null) {
  const now = new Date().toISOString();
  return {
    payload: {
      documentId: randomUUID(),
      number: 'KK-000002',
      source,
      postedAt: now,
      countedAt: now,
      lines: variantIds.map((variantId) => ({ variantId, countedQty: 0, delta: -1 })),
    },
  };
}

/** Một SKU, một kiện `reserved` đơn `unpaid` và hai kiện đã đóng cùng giữ mỗi kiện 1; kiểm kê đếm còn `onHand`. */
async function threeHolders(onHand: number) {
  const { companyId } = await createCompany();
  const { variantId: A } = await createVariant(companyId);
  await receive(companyId, A, 3, 100000);
  const line = [{ variantId: A, quantity: 1, reserved: true }];
  const reserved = await seedPackage(companyId, { status: 'reserved', orderStatus: 'unpaid', lines: line });
  const packed = await seedPackage(companyId, { status: 'packed', lines: line });
  const awaiting = await seedPackage(companyId, { status: 'awaiting_pickup', lines: line });
  await setBuckets(companyId, A, { onHand, invariantBroken: true });
  return { companyId, A, reserved, packed, awaiting };
}

describe('phiếu kiểm kê đếm thấp hơn đang giữ: kiện đã đóng bật Cần xử lý (25 §7.4)', () => {
  it('phiếu thường: lấy lại hết kiện reserved mà vẫn thiếu → kiện packed, awaiting_pickup giữ SKU bật cờ, trạng thái giữ nguyên', async () => {
    const { companyId, A, reserved, packed, awaiting } = await threeHolders(1);

    await withCompany(companyId, () => onStocktakePosted(ctx)(posted([A])));

    expect((await packageRow(reserved.packageId)).status).toBe('backordered');
    for (const p of [packed, awaiting]) {
      expect(await packageRow(p.packageId)).toMatchObject({ needs_attention: true, flag_note: DISMANTLE_NOTE });
    }
    expect((await packageRow(packed.packageId)).status).toBe('packed');
    expect((await packageRow(awaiting.packageId)).status).toBe('awaiting_pickup');
    expect((await stockOfVariant(companyId, A)).reserved).toBe(2);
  });

  it('lấy lại kiện reserved là đủ thì không bật cờ kiện đã đóng', async () => {
    const { companyId, A, reserved, packed, awaiting } = await threeHolders(2);

    const r = await withCompany(companyId, () => runAllocation(ctx, { variantIds: [A] }, { stocktake: true }));

    expect(r).toMatchObject({ reclaimed: [reserved.packageId], flagged: [] });
    expect((await packageRow(packed.packageId)).needs_attention).toBe(false);
    expect((await packageRow(awaiting.packageId)).needs_attention).toBe(false);
  });

  it('lượt không do kiểm kê (tồn đổi vì lý do khác) thì không bật cờ kiện đã đóng', async () => {
    const { companyId, A, packed } = await threeHolders(1);

    const r = await withCompany(companyId, () => runAllocation(ctx, { variantIds: [A] }));

    expect(r.flagged).toEqual([]);
    expect((await packageRow(packed.packageId)).needs_attention).toBe(false);
  });

  it('kiện đã đóng chỉ giữ SKU khác không bị bật cờ', async () => {
    const { companyId, A } = await threeHolders(1);
    const { variantId: B } = await createVariant(companyId);
    await receive(companyId, B, 1, 100000);
    const other = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: B, quantity: 1, reserved: true }] });

    await withCompany(companyId, () => onStocktakePosted(ctx)(posted([A, B])));

    expect((await packageRow(other.packageId)).needs_attention).toBe(false);
  });

  it('kiện đã có Cần xử lý vì lý do khác giữ nguyên ghi chú', async () => {
    const { companyId, A, packed } = await threeHolders(1);
    await testPool().query(`update "order".packages set needs_attention = true, flag_note = 'Ghi chú khác' where id = $1`, [packed.packageId]);

    const r = await withCompany(companyId, () => runAllocation(ctx, { variantIds: [A] }, { stocktake: true }));

    expect(r.flagged).not.toContain(packed.packageId);
    expect(await packageRow(packed.packageId)).toMatchObject({ needs_attention: true, flag_note: 'Ghi chú khác' });
  });

  it('nhận lại sự kiện: lượt sau không bật thêm, không lấy lại thêm', async () => {
    const { companyId, A } = await threeHolders(1);
    await withCompany(companyId, () => onStocktakePosted(ctx)(posted([A])));

    const again = await withCompany(companyId, () => runAllocation(ctx, { variantIds: [A] }, { stocktake: true }));

    expect(again).toMatchObject({ reclaimed: [], flagged: [] });
    expect((await stockOfVariant(companyId, A)).reserved).toBe(2);
  });

  it('phiếu đầu kỳ (nguồn shop_setup): consumer của fulfillment bỏ qua, channel gọi settleOpeningStocktake', async () => {
    const { companyId, A, reserved, packed } = await threeHolders(1);

    await withCompany(companyId, () => onStocktakePosted(ctx)(posted([A], { type: 'shop_setup', shopId: randomUUID() })));

    expect((await packageRow(reserved.packageId)).status).toBe('reserved');
    expect((await packageRow(packed.packageId)).needs_attention).toBe(false);
  });

  it('lượt phiếu đầu kỳ ({ all: true }) thấy cả SKU chỉ còn kiện đã đóng giữ: kiện đó bật cờ', async () => {
    const { companyId } = await createCompany();
    const { variantId: A } = await createVariant(companyId);
    await receive(companyId, A, 1, 100000);
    const packed = await seedPackage(companyId, { status: 'packed', lines: [{ variantId: A, quantity: 1, reserved: true }] });
    await setBuckets(companyId, A, { onHand: 0, invariantBroken: true });

    const r = await withCompany(companyId, () =>
      runAllocation({}, { all: true }, { opening: true, cause: { type: 'stocktake', documentId: randomUUID() } }),
    );

    expect(r.flagged).toEqual([packed.packageId]);
    expect(await packageRow(packed.packageId)).toMatchObject({ status: 'packed', needs_attention: true, flag_note: DISMANTLE_NOTE });
  });
});
