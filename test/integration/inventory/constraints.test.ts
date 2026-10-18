import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';
import { asCompany } from '../helpers/rls.ts';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
const docNumber = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function insertReceipt(
  db: Queryable,
  companyId: string,
  fields: { kind: string; purchaseOrderId?: string | null; orderId?: string | null; status?: string },
): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into inventory.stock_receipts (company_id, number, kind, purchase_order_id, order_id, status)
     values ($1, $2, $3, $4, $5, coalesce($6, 'draft')::inventory.doc_status) returning id`,
    [companyId, docNumber('PN'), fields.kind, fields.purchaseOrderId ?? null, fields.orderId ?? null, fields.status ?? null],
  );
  return res.rows[0]!.id;
}

const insertIssue = (companyId: string, orderId: string | null, status = 'draft', kind = 'order') =>
  testPool().query(
    `insert into inventory.stock_issues (company_id, number, kind, order_id, status) values ($1, $2, $3, $4, $5)`,
    [companyId, docNumber('PX'), kind, orderId, status],
  );

const insertLevel = (companyId: string, onHand: number, reserved: number) =>
  testPool().query('insert into inventory.stock_levels (company_id, variant_id, on_hand, reserved) values ($1, $2, $3, $4)', [
    companyId,
    randomUUID(),
    onHand,
    reserved,
  ]);

/** Một dòng thẻ kho của phiếu nhập đã có, trong giao dịch `c` của công ty. */
async function insertMove(c: pg.PoolClient, companyId: string): Promise<void> {
  const receipt = await insertReceipt(c, companyId, { kind: 'manual' });
  const variant = randomUUID();
  const line = await c.query<{ id: string }>(
    `insert into inventory.stock_receipt_lines (company_id, receipt_id, variant_id, quantity, unit_cost)
     values ($1, $2, $3, 5, 100000) returning id`,
    [companyId, receipt, variant],
  );
  await c.query(
    `insert into inventory.stock_moves (company_id, variant_id, qty_change, on_hand_after, receipt_line_id, unit_cost)
     values ($1, $2, 5, 5, $3, 100000)`,
    [companyId, variant, line.rows[0]!.id],
  );
}

// Ràng buộc của inventory (plan chuẩn bị 4.2, 4.3; 19-D34, D35; AC-9).
describe('ràng buộc bảng inventory (AC-9)', () => {
  it('tồn mới mặc định 0, giá vốn 0', async () => {
    const company = randomUUID();
    const variant = randomUUID();
    await testPool().query('insert into inventory.stock_levels (company_id, variant_id) values ($1, $2)', [company, variant]);
    const res = await testPool().query('select on_hand, reserved, avg_cost from inventory.stock_levels where variant_id = $1', [
      variant,
    ]);
    expect(res.rows[0]).toEqual({ on_hand: 0, reserved: 0, avg_cost: '0.00' });
  });

  it('tồn âm bị từ chối', async () => {
    await expect(insertLevel(randomUUID(), -1, -1)).rejects.toThrow(/"stock_levels_on_hand"/);
  });

  it('số giữ chỗ lớn hơn tồn bị từ chối', async () => {
    await expect(insertLevel(randomUUID(), 2, 3)).rejects.toThrow(/"stock_levels_reserved_le_on_hand"/);
  });

  it('phiếu nhập mua thiếu purchase_order_id bị từ chối; phiếu lập tay mang order_id bị từ chối', async () => {
    const company = randomUUID();
    await expect(insertReceipt(testPool(), company, { kind: 'purchase' })).rejects.toThrow(/check constraint/);
    await expect(insertReceipt(testPool(), company, { kind: 'manual', orderId: randomUUID() })).rejects.toThrow(
      /check constraint/,
    );
    await expect(insertReceipt(testPool(), company, { kind: 'purchase', purchaseOrderId: randomUUID() })).resolves.toBeDefined();
  });

  it('mỗi đơn tối đa một phiếu nhập hoàn chưa huỷ', async () => {
    const company = randomUUID();
    const order = randomUUID();
    await insertReceipt(testPool(), company, { kind: 'delivery_return', orderId: order, status: 'cancelled' });
    await insertReceipt(testPool(), company, { kind: 'delivery_return', orderId: order });
    await expect(insertReceipt(testPool(), company, { kind: 'delivery_return', orderId: order })).rejects.toThrow(
      /stock_receipts_one_return_per_order/,
    );
  });

  it('mỗi đơn tối đa một phiếu xuất chưa huỷ; huỷ rồi thì lập lại được', async () => {
    const company = randomUUID();
    const order = randomUUID();
    await insertIssue(company, order, 'cancelled');
    await insertIssue(company, order);
    await expect(insertIssue(company, order)).rejects.toThrow(/stock_issues_one_per_order/);
  });

  it('phiếu xuất theo đơn phải có order_id, phiếu xuất tay thì không', async () => {
    const company = randomUUID();
    await expect(insertIssue(company, null, 'draft', 'order')).rejects.toThrow(/check constraint/);
    await expect(insertIssue(company, randomUUID(), 'draft', 'manual')).rejects.toThrow(/check constraint/);
  });

  it('số phiếu không trùng trong một công ty', async () => {
    const company = randomUUID();
    const insert = () =>
      testPool().query(
        "insert into inventory.stock_issues (company_id, number, kind, status) values ($1, 'PX-000001', 'manual', 'draft')",
        [company],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });

  it('thẻ kho chỉ thêm: role ứng dụng ghi được, không sửa, không xoá', async () => {
    const company = randomUUID();
    await expect(asCompany(company, (c) => insertMove(c, company))).resolves.toBeUndefined();
    await expect(
      asCompany(company, async (c) => {
        await insertMove(c, company);
        await c.query('update inventory.stock_moves set qty_change = 6');
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asCompany(company, async (c) => {
        await insertMove(c, company);
        await c.query('delete from inventory.stock_moves');
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it('dòng thẻ kho trỏ đúng một dòng phiếu', async () => {
    const company = randomUUID();
    await expect(
      testPool().query(
        `insert into inventory.stock_moves (company_id, variant_id, qty_change, on_hand_after) values ($1, $2, 1, 1)`,
        [company, randomUUID()],
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('bộ đếm số chứng từ cấp số bằng UPDATE … RETURNING dưới role ứng dụng, chỉ thấy của công ty mình', async () => {
    const company = randomUUID();
    await testPool().query("insert into inventory.doc_counters (company_id, doc_type) values ($1, 'receipt')", [company]);
    const next = await asCompany(company, (c) =>
      c.query<{ issued: number }>(
        `update inventory.doc_counters set next_number = next_number + 1
         where company_id = $1 and doc_type = 'receipt' and period = '' returning next_number - 1 as issued`,
        [company],
      ),
    );
    expect(next.rows).toEqual([{ issued: 1 }]);
    const other = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from inventory.doc_counters where company_id = $1', [company]),
    );
    expect(other.rowCount).toBe(0);
  });
});
