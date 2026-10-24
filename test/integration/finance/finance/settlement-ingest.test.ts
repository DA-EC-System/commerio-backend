import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { mapTikTokStatement, mapTikTokTransaction } from '#src/modules/finance/finance/domain/tiktok-settlement.ts';
import { ingestSettlementStatement } from '#src/modules/finance/finance/service/settlement-ingest.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { ingest, linesOf, marketplaceOrder, orderTx, statement, statementsOf } from './settlement-helpers.ts';

// Nhận một bảng kê: lưu, khớp, gắn nhãn hoàn, chạy lại an toàn (plan #30 lát 4: AC-3, AC-4, AC-5, AC-7, AC-7b).
async function setup() {
  const { companyId } = await createCompany();
  const shopId = randomUUID();
  return { companyId, shopId };
}

describe('nhận bảng kê: khớp (AC-3)', () => {
  it('dòng của đơn sàn có trong hệ thống, số khớp → matched, gắn đơn, lưu phí 7 ô theo dấu kế toán và bản gốc', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 200000);
    const tx = orderTx(o.externalOrderId, 200000);
    const st = statement({ settlement_amount: '168000' });

    const res = await ingest(companyId, shopId, st, [tx]);

    expect(res.created).toBe(true);
    const [s] = await statementsOf(companyId);
    expect(s).toMatchObject({
      id: res.statementId,
      shop_id: shopId,
      external_statement_id: st.id,
      payment_status: 'PAID',
    });
    const [line] = await linesOf(companyId);
    expect(line).toMatchObject({
      tx: tx.id,
      kind: 'order',
      order_id: o.orderId,
      external_order_id: o.externalOrderId,
      match_status: 'matched',
      discrepancy_reason: null,
      revenue: '200000.00',
      shipping_cost: '15000.00',
      adjustment: '0.00',
      settlement: '168000.00',
    });
    expect(line.fees).toEqual({
      commission: '10000.00',
      transactionFee: '6000.00',
      infrastructureFee: '0.00',
      affiliate: '0.00',
      campaign: '0.00',
      tax: '1000.00',
      other: '0.00',
    });
    expect(line.raw).toEqual(tx);
  });
});

describe('nhận bảng kê: lệch (AC-4)', () => {
  it('mỗi dòng lệch đúng lý do, các dòng khác vẫn khớp; đơn cùng mã ở gian hàng khác → order_not_found', async () => {
    const { companyId, shopId } = await setup();
    const ok = await marketplaceOrder(companyId, shopId, 100000);
    const wrongRevenue = await marketplaceOrder(companyId, shopId, 150000);
    const badFormula = await marketplaceOrder(companyId, shopId, 100000);
    const otherShop = await marketplaceOrder(companyId, randomUUID(), 100000);
    const txs = [
      orderTx('SO-khong-co', 100000),
      orderTx(wrongRevenue.externalOrderId, 140000),
      orderTx(badFormula.externalOrderId, 100000, { settlement_amount: '68001' }),
      orderTx(otherShop.externalOrderId, 100000),
      orderTx(ok.externalOrderId, 100000),
    ];

    await ingest(companyId, shopId, statement(), txs);

    const byTx = new Map((await linesOf(companyId)).map((l) => [l.tx, l]));
    expect(txs.map((t) => [byTx.get(t.id)!.match_status, byTx.get(t.id)!.discrepancy_reason])).toEqual([
      ['discrepancy', 'order_not_found'],
      ['discrepancy', 'revenue_mismatch'],
      ['discrepancy', 'formula_mismatch'],
      ['discrepancy', 'order_not_found'],
      ['matched', null],
    ]);
    expect(byTx.get(txs[0]!.id)!.order_id).toBeNull();
    expect(byTx.get(txs[1]!.id)!.order_id).toBe(wrongRevenue.orderId);
  });
});

describe('nhận bảng kê: hoàn tiền (AC-5)', () => {
  it('dòng có hoàn → refund_tagged gắn đơn; không tạo trạng thái tiền của đơn ở payment', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 200000);
    const tx = orderTx(o.externalOrderId, 150000, {
      revenue_breakdown: { refund_subtotal_before_discount_amount: '-50000' },
    });

    await ingest(companyId, shopId, statement(), [tx]);

    const [line] = await linesOf(companyId);
    expect(line).toMatchObject({ match_status: 'refund_tagged', discrepancy_reason: null, order_id: o.orderId });
    const { rowCount } = await testPool().query('select 1 from payment.order_payments where order_id = $1', [
      o.orderId,
    ]);
    expect(rowCount).toBe(0);
  });
});

describe('nhận lại, khớp lại (AC-7, AC-7b)', () => {
  it('nhận lại cùng bảng kê không thêm gì; đổi trạng thái thì cập nhật', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 100000);
    const st = statement({ payment_status: 'PROCESSING' });
    const txs = [orderTx(o.externalOrderId, 100000)];

    const first = await ingest(companyId, shopId, st, txs);
    const again = await ingest(companyId, shopId, st, txs);
    expect(again).toEqual({ statementId: first.statementId, created: false });
    expect(await linesOf(companyId)).toHaveLength(1);

    await ingest(companyId, shopId, { ...st, payment_status: 'PAID' }, txs);
    const [s] = await statementsOf(companyId);
    expect(s).toMatchObject({ payment_status: 'PAID', version: 2 });
    expect(await statementsOf(companyId)).toHaveLength(1);
  });

  it('giao dịch đã có ở bảng kê khác thì bỏ qua', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 100000);
    const tx = orderTx(o.externalOrderId, 100000);
    await ingest(companyId, shopId, statement(), [tx]);
    await ingest(companyId, shopId, statement(), [tx]);
    const lines = await linesOf(companyId);
    expect(lines).toHaveLength(1);
    expect(await statementsOf(companyId)).toHaveLength(2);
  });

  it('bảng kê đã có mà gửi gian hàng khác → 422 errors.shopId, không đổi gì', async () => {
    const { companyId, shopId } = await setup();
    const st = statement();
    await ingest(companyId, shopId, st, []);
    await expect(ingest(companyId, randomUUID(), st, [])).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
      extensions: { errors: { shopId: expect.any(String) } },
    });
    const [s] = await statementsOf(companyId);
    expect(s.shop_id).toBe(shopId);
  });

  it('dòng order_not_found của bảng kê đã PAID được khớp lại khi nhận bảng kê khác, sau khi đơn về (AC-7b)', async () => {
    const { companyId, shopId } = await setup();
    const code = `SO-${randomUUID().slice(0, 8)}`;
    const late = orderTx(code, 100000);
    await ingest(companyId, shopId, statement(), [late]);
    expect((await linesOf(companyId))[0]).toMatchObject({
      match_status: 'discrepancy',
      discrepancy_reason: 'order_not_found',
    });

    const o = await marketplaceOrder(companyId, shopId, 100000);
    await testPool().query('update sales.orders set external_order_id = $2 where id = $1', [o.orderId, code]);
    await ingest(companyId, shopId, statement(), []);

    const line = (await linesOf(companyId)).find((l) => l.tx === late.id)!;
    expect(line).toMatchObject({ match_status: 'matched', discrepancy_reason: null, order_id: o.orderId });
  });
});

describe('giao dịch và RLS', () => {
  it('lỗi DB ở dòng sau (vượt numeric(18,2), ánh xạ đã chặn nên dựng thẳng) → không còn bảng kê, dòng nào', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 100000);
    const ok = mapTikTokTransaction(orderTx(o.externalOrderId, 100000));
    const bad = { ...mapTikTokTransaction(orderTx('SO-x', 0)), settlement: new Decimal('1e20') };
    await expect(
      withCompany(companyId, () => ingestSettlementStatement(shopId, mapTikTokStatement(statement()), [ok, bad])),
    ).rejects.toThrow();
    expect(await statementsOf(companyId)).toHaveLength(0);
    expect(await linesOf(companyId)).toHaveLength(0);
  });

  it('đơn của công ty khác không được khớp, dòng của công ty khác không đọc được', async () => {
    const a = await setup();
    const b = await createCompany();
    const o = await marketplaceOrder(a.companyId, a.shopId, 100000);
    await ingest(b.companyId, a.shopId, statement(), [orderTx(o.externalOrderId, 100000)]);
    const [line] = await linesOf(b.companyId);
    expect(line).toMatchObject({ match_status: 'discrepancy', discrepancy_reason: 'order_not_found', order_id: null });
    expect(await linesOf(a.companyId)).toHaveLength(0);
  });
});
