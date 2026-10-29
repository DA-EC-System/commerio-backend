import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { getOrderForPayment } from '#src/modules/order/sales/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';

// sales.getOrderForPayment do #23 viết thân (Documents/21 §11, D17; plan #23 A15, A7 tham số khoá).
describe('sales.getOrderForPayment', () => {
  it('trả đơn kèm tổng tiền Decimal và khách (AC-27)', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const order = await createOrder(companyId, { lines: [{ variantId, quantity: 2, unitPrice: 75000 }] });
    // Khách gắn với đơn là việc của #24; dựng tay bằng SQL (L004).
    const customer = await testPool().query<{ id: string }>(
      "insert into \"order\".customers (company_id, name, phone, email) values ($1, 'Khách Thử', '0900000000', 'khach@test.vn') returning id",
      [companyId],
    );
    await testPool().query('update "order".orders set customer_id = $1 where id = $2', [customer.rows[0]!.id, order.orderId]);

    const found = await withCompany(companyId, () => getOrderForPayment(order.orderId));
    expect(found).toMatchObject({
      id: order.orderId,
      code: order.code,
      status: 'unpaid',
      source: 'manual',
      paymentMethod: 'prepaid',
      customer: { id: customer.rows[0]!.id, name: 'Khách Thử', phone: '0900000000', email: 'khach@test.vn' },
    });
    expect(found!.total).toBeInstanceOf(Decimal);
    expect(found!.total.toString()).toBe('150000');
  });

  it('đơn không có khách trả customer null; đơn sàn trả paymentMethod null', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const order = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }], source: 'marketplace' });
    const found = await withCompany(companyId, () => getOrderForPayment(order.orderId));
    expect(found).toMatchObject({ source: 'marketplace', paymentMethod: null, customer: null });
  });

  it('đơn của công ty khác hoặc không tồn tại trả null (AC-27)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const { variantId } = await createVariant(a.companyId);
    const order = await createOrder(a.companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }] });
    expect(await withCompany(b.companyId, () => getOrderForPayment(order.orderId))).toBeNull();
    expect(await withCompany(a.companyId, () => getOrderForPayment('00000000-0000-4000-8000-000000000000'))).toBeNull();
  });

  it('khoá dòng đơn khi gọi với { lock: "share" }: giao dịch đang sửa đơn làm lần đọc phải chờ', async () => {
    const { companyId } = await createCompany();
    const { variantId } = await createVariant(companyId);
    const order = await createOrder(companyId, { lines: [{ variantId, quantity: 1, unitPrice: 1000 }] });
    const holder = await testPool().connect();
    try {
      await holder.query('begin');
      await holder.query("update \"order\".orders set status = 'cancelled' where id = $1", [order.orderId]);
      let settled = false;
      const read = withCompany(companyId, () => getOrderForPayment(order.orderId, { lock: 'share' })).finally(() => {
        settled = true;
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false);
      await holder.query('commit');
      expect((await read)!.status).toBe('cancelled');
    } finally {
      holder.release();
    }
  });
});
