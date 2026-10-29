import { describe, expect, it } from 'vitest';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { invoice, issuedOrder, receipt, reverseInvoice, settlementLine } from './helpers.ts';
import { recompute } from '#src/modules/insight/report/service/recompute.ts';

// Tính lại bảng insight.daily_channel_summary (plan #29 lát 3, A4; AC-8, AC-13, AC-16, AC-17).

async function tableOf(companyId: string) {
  const { rows } = await testPool().query(
    `select to_char(day, 'YYYY-MM-DD') as day, source, shop_id, revenue, cash_collected, platform_fee, payment_fee,
            shipping_fee, cogs, profit, fees_pending
       from insight.daily_channel_summary where company_id = $1 order by day, source, shop_id` /* enum: marketplace, inbox, manual */,
    [companyId],
  );
  return rows;
}

/** Đơn sàn đã đối soát, đơn sàn chưa đối soát, đơn tay có phiếu thu, cùng ngày 18/10; ngày 20/10 đảo đơn tay. */
async function sample() {
  const { companyId } = await registerCompany();
  const settled = await issuedOrder(companyId, { unitCost: 120000, unitPrice: 200000, source: 'marketplace' });
  const pending = await issuedOrder(companyId, { unitCost: 50000, unitPrice: 80000, source: 'marketplace' });
  const manual = await issuedOrder(companyId, { unitCost: '33333.33', unitPrice: 100000 });
  await invoice(companyId, settled.orderId, 200000, '2026-10-18T03:00:00Z');
  await invoice(companyId, pending.orderId, 80000, '2026-10-18T04:00:00Z');
  const manualInvoice = await invoice(companyId, manual.orderId, 100000, '2026-10-18T05:00:00Z');
  await receipt(companyId, manual.orderId, 100000, '2026-10-18T05:00:00Z');
  await settlementLine(companyId, settled.orderId, { fees: { commission: 10000, transactionFee: 2000 }, shippingCost: 15000 });
  await reverseInvoice(companyId, manualInvoice, '2026-10-20T02:00:00Z');
  return { companyId, settled, pending, manual };
}

const row = (day: string, source: string, money: Record<string, string>, feesPending = false) => ({
  day,
  source,
  revenue: '0.00',
  cash_collected: '0.00',
  platform_fee: '0.00',
  payment_fee: '0.00',
  shipping_fee: '0.00',
  cogs: '0.00',
  profit: '0.00',
  fees_pending: feesPending,
  ...money,
});

describe('recompute (lát 3)', () => {
  it('dựng một dòng mỗi (ngày, nguồn, gian hàng) đúng số tính tay; đảo trừ vào ngày đảo', async () => {
    const { companyId, settled, pending } = await sample();
    await recompute(companyId, '2026-10-17', '2026-10-21');
    const rows = await tableOf(companyId);
    expect(rows).toEqual([
      expect.objectContaining({ shop_id: expect.any(String) }),
      expect.objectContaining({ shop_id: expect.any(String) }),
      { ...row('2026-10-18', 'manual', { revenue: '100000.00', cash_collected: '100000.00', cogs: '33333.00', profit: '66667.00' }), shop_id: null },
      { ...row('2026-10-20', 'manual', { revenue: '-100000.00', cogs: '-33333.00', profit: '-66667.00' }), shop_id: null },
    ]);
    const byShop = new Map(rows.filter((r) => r.source === 'marketplace').map((r) => [r.shop_id, r]));
    const shopOf = async (orderId: string) =>
      (await testPool().query('select shop_id from "order".orders where id = $1', [orderId])).rows[0].shop_id as string;
    expect(byShop.get(await shopOf(settled.orderId))).toMatchObject(
      row('2026-10-18', 'marketplace', {
        revenue: '200000.00',
        platform_fee: '12000.00',
        shipping_fee: '15000.00',
        cogs: '120000.00',
        profit: '53000.00',
      }),
    );
    expect(byShop.get(await shopOf(pending.orderId))).toMatchObject(
      row('2026-10-18', 'marketplace', { revenue: '80000.00', cogs: '50000.00', profit: '30000.00' }, true),
    );
  });

  it('tính lại lần hai, hay xoá dòng rồi tính lại, cho đúng bảng cũ', async () => {
    const { companyId } = await sample();
    await recompute(companyId, '2026-10-17', '2026-10-21');
    const before = await tableOf(companyId);
    await recompute(companyId, '2026-10-17', '2026-10-21');
    expect(await tableOf(companyId)).toEqual(before);
    await testPool().query('delete from insight.daily_channel_summary where company_id = $1', [companyId]);
    await recompute(companyId, '2026-10-17', '2026-10-21');
    expect(await tableOf(companyId)).toEqual(before);
  });

  it('chỉ thay dòng trong khoảng: ngày ngoài khoảng và công ty khác giữ nguyên; ngày hết số thì mất dòng', async () => {
    const { companyId } = await sample();
    const other = await sample();
    await recompute(companyId, '2026-10-17', '2026-10-21');
    await recompute(other.companyId, '2026-10-17', '2026-10-21');
    const otherBefore = await tableOf(other.companyId);
    await testPool().query(
      "update insight.daily_channel_summary set revenue = 1 where company_id = $1 and day = '2026-10-20'",
      [companyId],
    );
    await testPool().query(
      "insert into insight.daily_channel_summary (company_id, day, source, revenue) values ($1, '2026-10-19', 'inbox', 5)",
      [companyId],
    );
    await recompute(companyId, '2026-10-19', '2026-10-19');
    const rows = await tableOf(companyId);
    expect(rows.find((r) => r.day === '2026-10-19')).toBeUndefined();
    expect(rows.find((r) => r.day === '2026-10-20')?.revenue).toBe('1.00');
    expect(await tableOf(other.companyId)).toEqual(otherBefore);
  });

  it('hai lần tính lại song song cùng công ty không đâm nhau, kết quả như chạy một lần', async () => {
    const { companyId } = await sample();
    await Promise.all(Array.from({ length: 6 }, (_, i) => recompute(companyId, i % 2 ? '2026-10-18' : '2026-10-17', '2026-10-21')));
    const rows = await tableOf(companyId);
    expect(rows).toHaveLength(4);
  });

  it('RLS: trong công ty A không thấy dòng của công ty B', async () => {
    const a = await sample();
    const b = await sample();
    await recompute(a.companyId, '2026-10-18', '2026-10-18');
    await recompute(b.companyId, '2026-10-18', '2026-10-18');
    const seen = await asCompany(a.companyId, (c) => c.query('select distinct company_id from insight.daily_channel_summary'));
    expect(seen.rows).toEqual([{ company_id: a.companyId }]);
  });
});
