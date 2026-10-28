import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { settlementByOrder } from '#src/modules/finance/finance/repository/daily-totals.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import {
  ingest,
  linesOf,
  marketplaceOrder,
  orderTx,
  receiptEvents,
  receiptsOf,
  statement,
  statementsOf,
} from './settlement-helpers.ts';

// Phiếu thu khi bảng kê PAID (plan #30 lát 5: AC-6, AC-7, AC-7b, AC-15; D19, A4).
async function setup() {
  const { companyId } = await createCompany();
  return { companyId, shopId: randomUUID() };
}

describe('phiếu thu theo dòng (AC-6)', () => {
  it('bảng kê PAID: một phiếu cho mỗi dòng matched/refund_tagged dương, kể cả điều chỉnh dương; không cho dòng lệch, dòng âm', async () => {
    const { companyId, shopId } = await setup();
    const ok = await marketplaceOrder(companyId, shopId, 100000);
    const refunded = await marketplaceOrder(companyId, shopId, 200000);
    const wrong = await marketplaceOrder(companyId, shopId, 150000);
    const txOk = orderTx(ok.externalOrderId, 100000);
    const txRefund = orderTx(refunded.externalOrderId, 150000, {
      revenue_breakdown: { refund_subtotal_before_discount_amount: '-50000' },
    });
    const txWrong = orderTx(wrong.externalOrderId, 140000);
    const txPenalty = {
      id: `TX-${randomUUID()}`,
      type: 'PLATFORM_PENALTY',
      adjustment_amount: '-5000',
      settlement_amount: '-5000',
    };
    const txBonus = {
      id: `TX-${randomUUID()}`,
      type: 'PLATFORM_COMPENSATION',
      adjustment_order_id: ok.externalOrderId,
      adjustment_amount: '7000',
      settlement_amount: '7000',
    };

    await ingest(companyId, shopId, statement(), [txOk, txRefund, txWrong, txPenalty, txBonus]);

    const receipts = await receiptsOf(companyId);
    // Các dòng của một bảng kê tạo cùng giao dịch nên thứ tự cấp số giữa chúng không theo thứ tự gửi lên.
    const rows = receipts.map((r) => [r.tx, r.order_id, r.amount, r.source, r.status]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        [txOk.id, ok.orderId, '68000.00', 'settlement', 'posted'],
        [txRefund.id, refunded.orderId, '118000.00', 'settlement', 'posted'],
        [txBonus.id, ok.orderId, '7000.00', 'settlement', 'posted'],
      ]),
    );
    expect(receipts.map((r) => r.number)).toEqual(['PT-000001', 'PT-000002', 'PT-000003']);
    const events = await receiptEvents(companyId);
    expect(events).toHaveLength(3);
    expect(events).toContainEqual(
      expect.objectContaining({ source: 'settlement', orderId: ok.orderId, amount: '68000.00', reversalOf: null }),
    );
  });

  it('bảng kê chưa PAID không sinh phiếu; nhận lại khi PAID thì sinh phiếu còn thiếu (AC-7)', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 100000);
    const st = statement({ payment_status: 'PROCESSING' });
    const txs = [orderTx(o.externalOrderId, 100000)];

    await ingest(companyId, shopId, st, txs);
    expect(await receiptsOf(companyId)).toHaveLength(0);

    await ingest(companyId, shopId, { ...st, payment_status: 'PAID' }, txs);
    await ingest(companyId, shopId, { ...st, payment_status: 'PAID' }, txs);
    expect(await receiptsOf(companyId)).toHaveLength(1);
    expect(await receiptEvents(companyId)).toHaveLength(1);
  });

  it('dòng khớp lại sau khi đơn về (AC-7b) có phiếu ngay nếu bảng kê đã PAID', async () => {
    const { companyId, shopId } = await setup();
    const code = `SO-${randomUUID().slice(0, 8)}`;
    const late = orderTx(code, 100000);
    await ingest(companyId, shopId, statement(), [late]);
    expect(await receiptsOf(companyId)).toHaveLength(0);

    const o = await marketplaceOrder(companyId, shopId, 100000);
    await testPool().query('update "order".orders set external_order_id = $2 where id = $1', [o.orderId, code]);
    await ingest(companyId, shopId, statement(), []);

    expect((await receiptsOf(companyId)).map((r) => [r.tx, r.order_id])).toEqual([[late.id, o.orderId]]);
  });
});

describe('chạy song song (AC-7)', () => {
  it('hai lần nhận cùng bảng kê cùng lúc → một bảng kê, đủ dòng, mỗi dòng một phiếu, số liền nhau', async () => {
    const { companyId, shopId } = await setup();
    const a = await marketplaceOrder(companyId, shopId, 100000);
    const b = await marketplaceOrder(companyId, shopId, 120000);
    const st = statement();
    const txs = [orderTx(a.externalOrderId, 100000), orderTx(b.externalOrderId, 120000)];

    const results = await Promise.all([ingest(companyId, shopId, st, txs), ingest(companyId, shopId, st, txs)]);

    expect(results.map((r) => r.created).sort()).toEqual([false, true]);
    expect(await statementsOf(companyId)).toHaveLength(1);
    expect(await linesOf(companyId)).toHaveLength(2);
    expect((await receiptsOf(companyId)).map((r) => r.number)).toEqual(['PT-000001', 'PT-000002']);
    expect(await receiptEvents(companyId)).toHaveLength(2);
  });
});

describe('phí lưu cho báo cáo #29 (AC-15)', () => {
  it('fees là chuỗi theo dấu kế toán; báo cáo cộng ra đúng phí sàn và vận chuyển dương của đơn', async () => {
    const { companyId, shopId } = await setup();
    const o = await marketplaceOrder(companyId, shopId, 100000);
    await ingest(companyId, shopId, statement(), [orderTx(o.externalOrderId, 100000)]);

    const [line] = await linesOf(companyId);
    expect(Object.values(line.fees).every((v) => typeof v === 'string')).toBe(true);
    const [row] = await withCompany(companyId, () => settlementByOrder([o.orderId]));
    expect(row).toMatchObject({ order_id: o.orderId, platform_fee: '17000.00', shipping_cost: '15000.00' });
  });
});
