import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../helpers/catalog.ts';
import { registerCompany } from '../helpers/company.ts';
import { createOrder } from '../helpers/sales.ts';
import {
  gatewayTxn,
  invoice,
  issuedOrder,
  receipt,
  refund,
  reverseInvoice,
  reverseReceipt,
  reverseRefund,
  settlementLine,
} from './helpers.ts';
import { getDailyFinanceTotals } from '#src/modules/finance/index.ts';
import { getOrderCogs } from '#src/modules/inventory/index.ts';
import { getDailyPaymentFees } from '#src/modules/payment/index.ts';
import { getOrderChannels } from '#src/modules/sales/index.ts';
import { withCompany } from '#src/shared/db/client.ts';

// Bốn hàm nguồn của báo cáo (plan #29 lát 1, A1–A3), gọi qua index.ts trong withCompany như service của report.
// Giờ biên: 16:30Z = 23:30 ngày 18 giờ VN; 17:30Z = 00:30 ngày 19 giờ VN.

const asText = (rows: readonly object[]) =>
  rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'object' && v ? String(v) : v])));

async function manualOrder(companyId: string, total = 100000) {
  const { variantId } = await createVariant(companyId);
  return createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: total }] });
}

describe('finance.getDailyFinanceTotals', () => {
  it('xếp doanh thu, tiền thu, hoàn tiền vào ngày giờ VN của từng chứng từ; đảo trừ vào ngày đảo', async () => {
    const { companyId } = await registerCompany();
    const order = await manualOrder(companyId);
    const inv = await invoice(companyId, order.orderId, 100000, '2026-10-18T16:30:00Z');
    const rec = await receipt(companyId, order.orderId, 100000, '2026-10-18T17:30:00Z');
    await reverseInvoice(companyId, inv, '2026-10-20T02:00:00Z');
    await reverseReceipt(companyId, rec, '2026-10-20T03:00:00Z');
    const pc = await refund(companyId, order.orderId, 40000, '2026-10-21');
    await reverseRefund(companyId, pc, '2026-10-22');
    await refund(companyId, order.orderId, 99999, '2026-10-21', 'draft');

    const rows = await withCompany(companyId, () => getDailyFinanceTotals({ from: '2026-10-18', to: '2026-10-22' }));
    const base = { orderId: order.orderId, platformFee: '0', shippingCost: '0', settled: false };
    expect(asText(rows)).toEqual([
      { ...base, day: '2026-10-18', revenue: '100000', cashCollected: '0', refunded: '0', invoiceNet: 1 },
      { ...base, day: '2026-10-19', revenue: '0', cashCollected: '100000', refunded: '0', invoiceNet: 0 },
      { ...base, day: '2026-10-20', revenue: '-100000', cashCollected: '-100000', refunded: '0', invoiceNet: -1 },
      { ...base, day: '2026-10-21', revenue: '0', cashCollected: '0', refunded: '40000', invoiceNet: 0 },
      { ...base, day: '2026-10-22', revenue: '0', cashCollected: '0', refunded: '-40000', invoiceNet: 0 },
    ]);
  });

  it('lọc đúng biên khoảng theo giờ VN', async () => {
    const { companyId } = await registerCompany();
    const order = await manualOrder(companyId);
    await invoice(companyId, order.orderId, 100000, '2026-10-18T16:59:59Z');
    await invoice(companyId, (await manualOrder(companyId)).orderId, 50000, '2026-10-18T17:00:00Z');
    const rows = await withCompany(companyId, () => getDailyFinanceTotals({ from: '2026-10-18', to: '2026-10-18' }));
    expect(rows.map((r) => [r.day, r.orderId])).toEqual([['2026-10-18', order.orderId]]);
  });

  it('hệ số hoá đơn đếm theo reversal_of_id, kể cả đơn tổng 0; đảo rồi lập lại cùng ngày cho 1', async () => {
    const { companyId } = await registerCompany();
    const free = await manualOrder(companyId, 0);
    await invoice(companyId, free.orderId, 0, '2026-10-18T03:00:00Z');
    const order = await manualOrder(companyId);
    const first = await invoice(companyId, order.orderId, 100000, '2026-10-18T03:00:00Z');
    await reverseInvoice(companyId, first, '2026-10-18T04:00:00Z');
    await invoice(companyId, order.orderId, 100000, '2026-10-18T05:00:00Z');
    const rows = await withCompany(companyId, () => getDailyFinanceTotals({ from: '2026-10-18', to: '2026-10-18' }));
    const net = new Map(rows.map((r) => [r.orderId, [r.invoiceNet, String(r.revenue)]]));
    expect(net.get(free.orderId)).toEqual([1, '0']);
    expect(net.get(order.orderId)).toEqual([1, '100000']);
  });

  it('phí sàn, vận chuyển sàn là tổng mọi dòng đối soát của đơn (mọi match_status), settled khi có dòng', async () => {
    const { companyId } = await registerCompany();
    const settled = await manualOrder(companyId);
    const pending = await manualOrder(companyId);
    await invoice(companyId, settled.orderId, 100000, '2026-10-18T03:00:00Z');
    await invoice(companyId, pending.orderId, 100000, '2026-10-18T03:00:00Z');
    await settlementLine(companyId, settled.orderId, { fees: { commission: 5000, transactionFee: 1500.5 }, shippingCost: 20000 });
    await settlementLine(companyId, settled.orderId, { fees: { other: 500 }, matchStatus: 'discrepancy' });
    await settlementLine(companyId, null, { fees: { other: 999 } });
    const rows = await withCompany(companyId, () => getDailyFinanceTotals({ from: '2026-10-18', to: '2026-10-18' }));
    const byOrder = new Map(rows.map((r) => [r.orderId, [String(r.platformFee), String(r.shippingCost), r.settled]]));
    expect(byOrder.get(settled.orderId)).toEqual(['7000.5', '20000', true]);
    expect(byOrder.get(pending.orderId)).toEqual(['0', '0', false]);
  });

  it('bỏ phiếu thu không có đơn; không thấy chứng từ công ty khác', async () => {
    const { companyId } = await registerCompany();
    const other = await registerCompany();
    await receipt(companyId, null, 30000, '2026-10-18T03:00:00Z');
    await invoice(other.companyId, (await manualOrder(other.companyId)).orderId, 100000, '2026-10-18T03:00:00Z');
    const rows = await withCompany(companyId, () => getDailyFinanceTotals({ from: '2026-10-18', to: '2026-10-18' }));
    expect(rows).toEqual([]);
  });
});

describe('inventory.getOrderCogs', () => {
  it('giá vốn = Σ số lượng × giá vốn lúc xuất của phiếu xuất đã ghi sổ; đơn chưa xuất vắng mặt', async () => {
    const { companyId } = await registerCompany();
    const issued = await issuedOrder(companyId, { unitCost: '33333.33', unitPrice: 50000, quantity: 3 });
    const notIssued = await manualOrder(companyId);
    const cogs = await withCompany(companyId, () => getOrderCogs([issued.orderId, notIssued.orderId]));
    expect([...cogs].map(([k, v]) => [k, String(v)])).toEqual([[issued.orderId, '99999.99']]);
  });

  it('không thấy đơn của công ty khác; danh sách rỗng trả Map rỗng', async () => {
    const a = await registerCompany();
    const b = await registerCompany();
    const issued = await issuedOrder(b.companyId, { unitCost: 1000, unitPrice: 2000 });
    expect((await withCompany(a.companyId, () => getOrderCogs([issued.orderId]))).size).toBe(0);
    expect((await withCompany(a.companyId, () => getOrderCogs([]))).size).toBe(0);
  });
});

describe('payment.getDailyPaymentFees', () => {
  it('phí cổng của giao dịch thành công có phí, theo ngày giờ VN của giao dịch', async () => {
    const { companyId } = await registerCompany();
    const order = await manualOrder(companyId);
    await gatewayTxn(companyId, order.orderId, { fee: 1100, occurredAt: '2026-10-18T16:30:00Z' });
    await gatewayTxn(companyId, order.orderId, { fee: 900, occurredAt: '2026-10-18T17:30:00Z' });
    await gatewayTxn(companyId, order.orderId, { fee: null, occurredAt: '2026-10-18T03:00:00Z' });
    await gatewayTxn(companyId, order.orderId, { fee: 500, occurredAt: '2026-10-18T03:00:00Z', status: 'failed' });
    const rows = await withCompany(companyId, () => getDailyPaymentFees({ from: '2026-10-18', to: '2026-10-19' }));
    expect(asText(rows)).toEqual([
      { day: '2026-10-18', orderId: order.orderId, fee: '1100' },
      { day: '2026-10-19', orderId: order.orderId, fee: '900' },
    ]);
  });
});

describe('sales.getOrderChannels', () => {
  it('nguồn và gian hàng của từng đơn; đơn không phải sàn luôn không có gian hàng; id lạ bị bỏ', async () => {
    const { companyId } = await registerCompany();
    const { variantId } = await createVariant(companyId);
    const lines = [{ variantId, quantity: 1, unitPrice: 1000 }];
    const market = await createOrder(companyId, { lines, source: 'marketplace' });
    const manual = await createOrder(companyId, { lines });
    const channels = await withCompany(companyId, () => getOrderChannels([market.orderId, manual.orderId, randomUUID()]));
    expect(channels.get(manual.orderId)).toEqual({ source: 'manual', shopId: null });
    expect(channels.get(market.orderId)).toMatchObject({ source: 'marketplace', shopId: expect.any(String) });
    expect(channels.size).toBe(2);
  });
});
