import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueInvoiceForOrder } from '#src/modules/finance/finance/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// Hoá đơn bán tự sinh khi xuất kho (T17, QT-39; plan #27 AC-5, A20). #25 gọi trong giao dịch ghi sổ phiếu xuất.
async function orderOfTwoLines() {
  const { companyId } = await createCompany();
  const v1 = await createVariant(companyId);
  const v2 = await createVariant(companyId);
  const order = await createOrder(companyId, {
    lines: [
      { variantId: v1.variantId, quantity: 2, unitPrice: 50000 },
      { variantId: v2.variantId, quantity: 1, unitPrice: 30000 },
    ],
  });
  return { companyId, order, v1, v2 };
}

const invoicesOf = async (orderId: string) =>
  (
    await testPool().query(
      'select id, number, status, total, reversal_of_id from finance.sales_invoices where order_id = $1 order by created_at',
      [orderId],
    )
  ).rows;

const linesOf = async (invoiceId: string) =>
  (
    await testPool().query(
      'select variant_id, quantity, unit_price, order_line_id from finance.sales_invoice_lines where invoice_id = $1 order by quantity desc',
      [invoiceId],
    )
  ).rows;

const invoiceEvents = async (companyId: string) =>
  (
    await testPool().query(
      "select payload from core.outbox_messages where company_id = $1 and type = 'finance.invoice_posted'",
      [companyId],
    )
  ).rows.map((r) => r.payload);

describe('issueInvoiceForOrder (AC-5)', () => {
  it('lập hoá đơn posted HD-000001, dòng = dòng đơn, tổng = tổng đơn, ghi sự kiện cùng giao dịch', async () => {
    const { companyId, order, v1, v2 } = await orderOfTwoLines();
    const result = await withCompany(companyId, () => issueInvoiceForOrder(order.orderId));
    expect(result).toMatchObject({ number: 'HD-000001', created: true });
    expect(result.total.toFixed(0)).toBe('130000');

    const [invoice] = await invoicesOf(order.orderId);
    expect(invoice).toMatchObject({ id: result.invoiceId, number: 'HD-000001', status: 'posted', total: '130000.00' });
    const lines = await linesOf(result.invoiceId);
    expect(lines.map((l) => [l.variant_id, l.quantity, l.unit_price])).toEqual([
      [v1.variantId, 2, '50000.00'],
      [v2.variantId, 1, '30000.00'],
    ]);
    expect(lines.every((l) => l.order_line_id)).toBe(true);
    expect(await invoiceEvents(companyId)).toEqual([
      expect.objectContaining({ invoiceId: result.invoiceId, orderId: order.orderId, total: '130000.00', reversalOf: null }),
    ]);
  });

  it('gọi lại trả hoá đơn cũ, created: false, không ghi thêm', async () => {
    const { companyId, order } = await orderOfTwoLines();
    const first = await withCompany(companyId, () => issueInvoiceForOrder(order.orderId));
    const again = await withCompany(companyId, () => issueInvoiceForOrder(order.orderId));
    expect(again).toMatchObject({ invoiceId: first.invoiceId, number: first.number, created: false });
    expect(await invoicesOf(order.orderId)).toHaveLength(1);
    expect(await invoiceEvents(companyId)).toHaveLength(1);
  });

  it('hai giao dịch gọi song song cho cùng đơn: một hoá đơn, không lỗi trùng', async () => {
    const { companyId, order } = await orderOfTwoLines();
    const results = await Promise.all([
      withCompany(companyId, () => issueInvoiceForOrder(order.orderId)),
      withCompany(companyId, () => issueInvoiceForOrder(order.orderId)),
    ]);
    expect(results.map((r) => r.created).toSorted()).toEqual([false, true]);
    expect(new Set(results.map((r) => r.invoiceId)).size).toBe(1);
    expect(await invoicesOf(order.orderId)).toHaveLength(1);
  });

  it('bên gọi rollback: không còn hoá đơn và số HD-000001 được dùng lại', async () => {
    const { companyId, order } = await orderOfTwoLines();
    await expect(
      withCompany(companyId, async () => {
        await issueInvoiceForOrder(order.orderId);
        throw new Error('xuất kho lỗi');
      }),
    ).rejects.toThrow('xuất kho lỗi');
    expect(await invoicesOf(order.orderId)).toHaveLength(0);
    expect(await withCompany(companyId, () => issueInvoiceForOrder(order.orderId))).toMatchObject({ number: 'HD-000001' });
  });

  it('đơn không thấy (không có hoặc của công ty khác) → 404 not_found', async () => {
    const { order } = await orderOfTwoLines();
    const other = await createCompany();
    await expect(withCompany(other.companyId, () => issueInvoiceForOrder(order.orderId))).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    for (const id of [randomUUID(), 'khong-phai-uuid']) {
      await expect(withCompany(other.companyId, () => issueInvoiceForOrder(id))).rejects.toMatchObject({ status: 404 });
    }
  });

  it('đơn không có dòng hàng nào → 409 order_has_no_lines, không lập hoá đơn, không tốn số (#63 B16)', async () => {
    const { companyId, order, v1 } = await orderOfTwoLines();
    // Dựng tay: chưa đường ghi nào tạo đơn rỗng (sales #24 chưa có), DB cũng không cấm.
    await testPool().query('delete from "order".order_lines where order_id = $1', [order.orderId]);
    await expect(withCompany(companyId, () => issueInvoiceForOrder(order.orderId))).rejects.toMatchObject({
      status: 409,
      code: 'order_has_no_lines',
    });
    expect(await invoicesOf(order.orderId)).toHaveLength(0);
    const other = await createOrder(companyId, { lines: [{ variantId: v1.variantId, quantity: 1, unitPrice: 1000 }] });
    expect(await withCompany(companyId, () => issueInvoiceForOrder(other.orderId))).toMatchObject({ number: 'HD-000001' });
  });
});
