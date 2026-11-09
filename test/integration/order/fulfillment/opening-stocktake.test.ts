import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { settleOpeningStocktake } from '#src/modules/order/index.ts';
import { DISMANTLE_NOTE } from '#src/modules/order/fulfillment/service/allocation.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { receive } from '../../product/inventory/helpers.ts';
import { channelShop, invariantBroken, outboxOf, packageDocuments, packageLineRows, packageRow, seedPackage } from './helpers.ts';

const HOUR = 3_600_000;

async function setup(stock: number) {
  const { companyId } = await createCompany();
  const { variantId: A } = await createVariant(companyId);
  const shopId = await channelShop(companyId, true);
  if (stock > 0) await receive(companyId, A, stock, 100000);
  return { companyId, A, shopId, countedAt: new Date(Date.now() - 2 * HOUR), documentId: randomUUID() };
}

/** Giao dịch thoát chờ kiểm kê của channel (#289): bỏ phiếu khỏi gian hàng rồi gọi fulfillment, cùng giao dịch. */
const exitAwaiting = (s: { companyId: string; shopId: string; documentId: string; countedAt: Date }) =>
  withCompany(s.companyId, async () => {
    await getDb().execute(
      sql`update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null, order_cutoff_at = ${s.countedAt} where id = ${s.shopId}`,
    );
    return settleOpeningStocktake({ shopId: s.shopId, documentId: s.documentId, countedAt: s.countedAt });
  });

describe('settleOpeningStocktake: phiếu kiểm kê đầu kỳ ghi sổ (spec 199b §5.5)', () => {
  it('AC11: bù kiện rời kho trước rồi mới phân hàng: kiện rời kho trừ thường, kiện awaiting_pickup chưa giữ được giữ, kiện backordered ở lại; có cause', async () => {
    const s = await setup(3);
    const k1 = await seedPackage(s.companyId, {
      status: 'in_transit',
      shopId: s.shopId,
      handoverSource: 'marketplace',
      handedOverAt: new Date(s.countedAt.valueOf() + HOUR),
      lines: [{ variantId: s.A, quantity: 2 }],
    });
    const k2 = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
    const k3 = await seedPackage(s.companyId, { status: 'backordered', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });

    expect(await exitAwaiting(s)).toEqual({ deducted: 1, storedOnly: 0, held: 1 });

    expect(await packageDocuments(k1.packageId)).toHaveLength(1);
    expect((await packageRow(k1.packageId)).handover_source).toBe('marketplace');
    expect(await invariantBroken(s.companyId, s.A)).toBe(false);
    expect((await packageRow(k2.packageId)).status).toBe('awaiting_pickup');
    expect((await packageLineRows(k2.packageId))[0]!.reserved_qty).toBe(1);
    expect((await packageRow(k3.packageId)).status).toBe('backordered');
    expect((await outboxOf(s.companyId, 'fulfillment.allocation_done')).at(-1)).toEqual({
      variantIds: [s.A],
      cause: { type: 'stocktake', documentId: s.documentId },
    });
  });

  it('AC12: kiện đã đóng không giữ được → Cần xử lý với DISMANTLE_NOTE', async () => {
    const s = await setup(1);
    const p = await seedPackage(s.companyId, { status: 'packed', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 2 }] });
    await exitAwaiting(s);
    expect(await packageRow(p.packageId)).toMatchObject({ status: 'packed', needs_attention: true, flag_note: DISMANTLE_NOTE });
  });

  it('AC13: không có gì để làm vẫn phát cause, variantIds rỗng; gọi lần hai không phiếu XK mới, không giữ thêm, phát lại cause', async () => {
    const s = await setup(0);
    const cause = { type: 'stocktake', documentId: s.documentId };
    expect(await exitAwaiting(s)).toEqual({ deducted: 0, storedOnly: 0, held: 0 });
    expect(await exitAwaiting(s)).toEqual({ deducted: 0, storedOnly: 0, held: 0 });
    expect(await outboxOf(s.companyId, 'fulfillment.allocation_done')).toEqual([
      { variantIds: [], cause },
      { variantIds: [], cause },
    ]);
  });
});
