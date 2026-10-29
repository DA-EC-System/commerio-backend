import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const insertOrder = (
  companyId: string,
  fields: { source: string; paymentMethod?: string | null; shopId?: string | null; externalOrderId?: string | null },
) =>
  testPool().query(
    `insert into "order".orders (company_id, code, source, payment_method, shop_id, external_order_id, subtotal, total)
     values ($1, $2, $3, $4, $5, $6, 100000, 100000)`,
    [
      companyId,
      `DH-${randomUUID().slice(0, 8)}`,
      fields.source,
      fields.paymentMethod ?? null,
      fields.shopId ?? null,
      fields.externalOrderId ?? null,
    ],
  );

// Ràng buộc của sales (plan chuẩn bị 4.2, 4.3; 19-D11, D32; AC-9).
describe('ràng buộc bảng sales (AC-9)', () => {
  it('đơn sàn thiếu gian hàng hoặc mã đơn sàn bị từ chối', async () => {
    const company = randomUUID();
    await expect(insertOrder(company, { source: 'marketplace', externalOrderId: 'TT-1' })).rejects.toThrow(
      /"orders_marketplace_ref"/,
    );
    await expect(insertOrder(company, { source: 'marketplace', shopId: randomUUID() })).rejects.toThrow(
      /"orders_marketplace_ref"/,
    );
    await expect(
      insertOrder(company, { source: 'marketplace', shopId: randomUUID(), externalOrderId: 'TT-2' }),
    ).resolves.toBeDefined();
  });

  it('đơn tay, đơn hộp thư thiếu phương thức thanh toán bị từ chối; đơn sàn có phương thức bị từ chối (19-D11)', async () => {
    const company = randomUUID();
    await expect(insertOrder(company, { source: 'manual' })).rejects.toThrow(/"orders_payment_method"/);
    await expect(insertOrder(company, { source: 'inbox' })).rejects.toThrow(/"orders_payment_method"/);
    await expect(
      insertOrder(company, { source: 'marketplace', paymentMethod: 'cod', shopId: randomUUID(), externalOrderId: 'TT-3' }),
    ).rejects.toThrow(/"orders_payment_method"/);
    await expect(insertOrder(company, { source: 'manual', paymentMethod: 'cod' })).resolves.toBeDefined();
  });

  it('một đơn sàn chỉ vào hệ thống một lần (19-D32)', async () => {
    const company = randomUUID();
    const shop = randomUUID();
    await insertOrder(company, { source: 'marketplace', shopId: shop, externalOrderId: 'TT-9' });
    await expect(insertOrder(company, { source: 'marketplace', shopId: shop, externalOrderId: 'TT-9' })).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('đơn mới mặc định chờ thanh toán (unpaid)', async () => {
    const company = randomUUID();
    await insertOrder(company, { source: 'manual', paymentMethod: 'prepaid' });
    const res = await testPool().query('select status, shipping_fee from "order".orders where company_id = $1', [company]);
    expect(res.rows).toEqual([{ status: 'unpaid', shipping_fee: '0.00' }]);
  });

  it('bộ đếm mã đơn chỉ thấy của công ty mình', async () => {
    const company = randomUUID();
    await testPool().query("insert into \"order\".doc_counters (company_id, doc_type) values ($1, 'order')", [company]);
    const own = await asCompany(company, (c) => c.query('select next_number from "order".doc_counters'));
    expect(own.rows).toEqual([{ next_number: 1 }]);
    const other = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from "order".doc_counters where company_id = $1', [company]),
    );
    expect(other.rowCount).toBe(0);
  });
});
