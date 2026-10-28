import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { getOrderLines, getOrdersForFinance } from '#src/modules/order/sales/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { createOrder } from '../../helpers/sales.ts';

// Hàm đọc đơn của sales cho finance (plan #27 A2, Thành duyệt 18/10). Đặt ở test/**/finance/** vì finance là bên gọi
// và ranh giới đợt B chỉ giao cho #27 thư mục test của payment, finance.
describe('sales.getOrderLines, getOrdersForFinance (A2)', () => {
  it('trả dòng đơn đã chép và thông tin đơn theo lô', async () => {
    const { companyId } = await createCompany();
    const v1 = await createVariant(companyId);
    const v2 = await createVariant(companyId);
    const order = await createOrder(companyId, {
      lines: [
        { variantId: v1.variantId, quantity: 2, unitPrice: 50000 },
        { variantId: v2.variantId, quantity: 1, unitPrice: 30000 },
      ],
    });
    const [lines, orders] = await withCompany(companyId, async () => [
      await getOrderLines(order.orderId),
      await getOrdersForFinance([order.orderId, randomUUID(), 'khong-phai-uuid']),
    ]);
    expect(lines.map((l) => [l.variantId, l.sku, l.quantity, l.unitPrice.toFixed(0), l.lineTotal.toFixed(0)])).toEqual(
      expect.arrayContaining([
        [v1.variantId, v1.sku, 2, '50000', '100000'],
        [v2.variantId, v2.sku, 1, '30000', '30000'],
      ]),
    );
    expect(lines[0]!.productName).toBeTruthy();
    expect([...orders.keys()]).toEqual([order.orderId]);
    expect(orders.get(order.orderId)).toMatchObject({
      code: order.code,
      status: 'unpaid',
      source: 'manual',
      paymentMethod: 'prepaid',
      customerName: null,
    });
    expect(orders.get(order.orderId)!.total.toFixed(0)).toBe('130000');
  });

  it('đơn của công ty khác không thấy (RLS)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const { variantId } = await createVariant(a.companyId);
    const order = await createOrder(a.companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }] });
    const [lines, orders] = await withCompany(b.companyId, async () => [
      await getOrderLines(order.orderId),
      await getOrdersForFinance([order.orderId]),
    ]);
    expect(lines).toEqual([]);
    expect(orders.size).toBe(0);
  });
});
