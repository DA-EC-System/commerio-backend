import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { settleOpeningStocktake } from '#src/modules/order/index.ts';
import { DISMANTLE_NOTE } from '#src/modules/order/fulfillment/service/allocation.ts';
import { getDb, withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { raceBehindLock } from '../../helpers/locks.ts';
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

  describe('kho quét lúc chờ kiểm kê (spec 199b D7)', () => {
    const scan = async (token: string, id: string) =>
      request(testApp())
        .post('/api/v1/fulfillment/packages/hand-over')
        .set('Authorization', `Bearer ${token}`)
        .send({ packages: [{ id, version: (await packageRow(id)).version }] });

    it('AC14: kiện quét sau countedAt được trừ đúng một lần khi phiếu đầu kỳ ghi sổ; quét trước countedAt thành before_cutoff', async () => {
      const s = await setup(5);
      const kho = await addMember(s.companyId, 'warehouse');
      const after = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
      const before = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });
      expect((await scan(kho.token, after.packageId)).status).toBe(200);
      expect((await scan(kho.token, before.packageId)).status).toBe(200);
      await testPool().query('update "order".packages set handed_over_at = $2 where id = $1', [before.packageId, new Date(s.countedAt.valueOf() - HOUR)]);

      expect(await exitAwaiting(s)).toMatchObject({ deducted: 1, storedOnly: 1 });

      expect(await packageDocuments(after.packageId)).toHaveLength(1);
      expect(await packageRow(before.packageId)).toMatchObject({ handover_source: 'before_cutoff' });
      expect(await packageDocuments(before.packageId)).toEqual([]);
      expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 0 });
      expect(await packageDocuments(after.packageId)).toHaveLength(1);
    });

    it('AC16: lần quét đua thoát chờ: thoát chờ giữ khoá gian hàng, lần quét đợi, commit xong thì kiện trừ ngay một lần, không còn kiện hoãn chưa bù', async () => {
      const s = await setup(5);
      const kho = await addMember(s.companyId, 'warehouse');
      const p = await seedPackage(s.companyId, { status: 'awaiting_pickup', shopId: s.shopId, lines: [{ variantId: s.A, quantity: 1 }] });

      const res = await raceBehindLock(
        (holder) =>
          holder.query('update channel.shops set opening_stocktake_id = null, opening_stocktake_number = null where id = $1', [s.shopId]),
        1,
        () => scan(kho.token, p.packageId),
      );

      expect(res.status).toBe(200);
      expect(res.body.handedOver[0].issue.number).toMatch(/^XK-/);
      expect(await exitAwaiting(s)).toMatchObject({ deducted: 0, storedOnly: 0 });
      expect(await packageDocuments(p.packageId)).toHaveLength(1);
    });
  });
});
