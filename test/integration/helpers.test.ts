import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createVariant } from './helpers/catalog.ts';
import { createCompany } from './helpers/company.ts';
import { asCompany } from './helpers/rls.ts';
import { createOrder } from './helpers/sales.ts';

// Helper dùng chung chạy được và tạo dữ liệu đúng như sản phẩm sẽ tạo (AC-13). PR sau thêm phần của mình.
describe('helper test dùng chung', () => {
  it('createVariant tạo danh mục, sản phẩm, biến thể của công ty; công ty khác không thấy', async () => {
    const { companyId } = await createCompany();
    const v = await createVariant(companyId, { sku: 'AO-0001', categoryName: 'Áo thun' });
    expect(v.sku).toBe('AO-0001');

    const seen = await asCompany(companyId, (c) =>
      c.query(
        `select v.sku, p.id as product_id, c.name as category from catalog.product_variants v
         join catalog.products p on p.id = v.product_id join catalog.categories c on c.id = p.category_id
         where v.id = $1`,
        [v.variantId],
      ),
    );
    expect(seen.rows).toEqual([{ sku: 'AO-0001', product_id: v.productId, category: 'Áo thun' }]);

    const other = await createCompany();
    const hidden = await asCompany(other.companyId, (c) =>
      c.query('select 1 from catalog.product_variants where id = $1', [v.variantId]),
    );
    expect(hidden.rowCount).toBe(0);
  });

  it('createVariant gọi nhiều lần trong một công ty không đụng tên, SKU', async () => {
    const { companyId } = await createCompany();
    const a = await createVariant(companyId);
    const b = await createVariant(companyId);
    expect(a.sku).not.toBe(b.sku);
    expect(a.categoryId).not.toBe(b.categoryId);
  });

  it('createOrder tạo đơn tay với dòng đơn chép SKU, tên sản phẩm; tổng tính từ dòng; công ty khác không thấy', async () => {
    const { companyId } = await createCompany();
    const v = await createVariant(companyId, { sku: 'QUAN-0001' });
    const order = await createOrder(companyId, {
      paymentMethod: 'cod',
      lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 150000 }],
    });
    expect(order.total).toBe('300000.00');

    const seen = await asCompany(companyId, (c) =>
      c.query(
        `select o.code, o.source, o.payment_method, o.status, o.total, l.sku, l.quantity, l.line_total
         from sales.orders o join sales.order_lines l on l.order_id = o.id where o.id = $1`,
        [order.orderId],
      ),
    );
    expect(seen.rows).toEqual([
      {
        code: order.code,
        source: 'manual',
        payment_method: 'cod',
        status: 'pending_confirmation',
        total: '300000.00',
        sku: 'QUAN-0001',
        quantity: 2,
        line_total: '300000.00',
      },
    ]);

    const hidden = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from sales.orders where id = $1', [order.orderId]),
    );
    expect(hidden.rowCount).toBe(0);
  });

  it('createOrder đơn sàn: không có phương thức thanh toán, có gian hàng và mã đơn sàn', async () => {
    const { companyId } = await createCompany();
    const v = await createVariant(companyId);
    const order = await createOrder(companyId, {
      source: 'marketplace',
      lines: [{ variantId: v.variantId, quantity: 1, unitPrice: 99000 }],
    });
    const res = await asCompany(companyId, (c) =>
      c.query('select payment_method, shop_id is not null as has_shop from sales.orders where id = $1', [order.orderId]),
    );
    expect(res.rows).toEqual([{ payment_method: null, has_shop: true }]);
  });
});
