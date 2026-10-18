import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

const insertOrder = (companyId: string, status: string, supplierId: string | null = null) =>
  testPool().query<{ id: string }>(
    `insert into purchasing.purchase_orders (company_id, code, supplier_id, status, created_by)
     values ($1, $2, $3, $4, $5) returning id`,
    [companyId, `PO-${randomUUID().slice(0, 8)}`, supplierId, status, randomUUID()],
  );

// Đơn đặt hàng nhà cung cấp (ERD mở rộng, plan chuẩn bị A9; AC-9).
describe('ràng buộc bảng purchasing (AC-9)', () => {
  it('đơn nháp chưa cần nhà cung cấp; đơn chờ duyệt thiếu nhà cung cấp bị từ chối', async () => {
    const company = randomUUID();
    await expect(insertOrder(company, 'draft')).resolves.toBeDefined();
    await expect(insertOrder(company, 'pending_approval')).rejects.toThrow(/"purchase_orders_supplier_required"/);
  });

  it('dòng đơn đặt số lượng 0 hoặc giá âm bị từ chối', async () => {
    const company = randomUUID();
    const po = (await insertOrder(company, 'draft')).rows[0]!.id;
    const insertLine = (qty: number, price: number) =>
      testPool().query(
        `insert into purchasing.purchase_order_lines (company_id, po_id, variant_id, ordered_qty, unit_price)
         values ($1, $2, $3, $4, $5)`,
        [company, po, randomUUID(), qty, price],
      );
    await expect(insertLine(0, 1000)).rejects.toThrow(/"purchase_order_lines_ordered_qty"/);
    await expect(insertLine(1, -1)).rejects.toThrow(/"purchase_order_lines_unit_price"/);
    await expect(insertLine(5, 1000)).resolves.toBeDefined();
  });
});
