import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';
import { asCompany } from '../helpers/rls.ts';

const number = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function insertInvoice(
  companyId: string,
  orderId: string,
  fields: { status?: string; total?: number; reversalOfId?: string; reason?: string } = {},
): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into finance.sales_invoices (company_id, number, order_id, status, total, reversal_of_id, reversal_reason)
     values ($1, $2, $3, coalesce($4, 'posted')::finance.invoice_status, $5, $6, $7) returning id`,
    [
      companyId,
      number('HD'),
      orderId,
      fields.status ?? null,
      fields.total ?? 150000,
      fields.reversalOfId ?? null,
      fields.reason ?? null,
    ],
  );
  return res.rows[0]!.id;
}

async function insertVoucher(
  companyId: string,
  amount: number,
  reversal: { of?: string; reason?: string } = {},
): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into finance.payment_vouchers
       (company_id, number, purpose, order_id, amount, paid_on, created_by, reversal_of_id, reversal_reason)
     values ($1, $2, 'customer_refund', $3, $4, current_date, $5, $6, $7) returning id`,
    [companyId, number('PC'), randomUUID(), amount, randomUUID(), reversal.of ?? null, reversal.reason ?? null],
  );
  return res.rows[0]!.id;
}

const insertReceipt = (companyId: string, amount: number, reversal: { of?: string; reason?: string } = {}) =>
  testPool().query<{ id: string }>(
    `insert into finance.receipts (company_id, number, order_id, source, amount, reversal_of_id, reversal_reason)
     values ($1, $2, $3, 'cod', $4, $5, $6) returning id`,
    [companyId, number('PT'), randomUUID(), amount, reversal.of ?? null, reversal.reason ?? null],
  );

// Ràng buộc chứng từ của finance (plan chuẩn bị 4.2, 4.3, A7; D14; 19-D20; AC-9).
describe('ràng buộc bảng finance (AC-9)', () => {
  it('một đơn tối đa một hoá đơn posted chưa đảo; hoá đơn đảo cùng đơn thì được', async () => {
    const company = randomUUID();
    const order = randomUUID();
    const original = await insertInvoice(company, order);
    await expect(insertInvoice(company, order)).rejects.toThrow(/sales_invoices_one_posted_per_order/);
    await expect(
      insertInvoice(company, order, { total: -150000, reversalOfId: original, reason: 'Sai đơn giá' }),
    ).resolves.toBeDefined();
  });

  it('gốc đã đảo (reversed) thì lập hoá đơn mới cho đơn được', async () => {
    const company = randomUUID();
    const order = randomUUID();
    await insertInvoice(company, order, { status: 'reversed' });
    await expect(insertInvoice(company, order)).resolves.toBeDefined();
  });

  it('mỗi chứng từ chỉ bị đảo một lần (19-D20)', async () => {
    const company = randomUUID();
    const original = await insertVoucher(company, 50000);
    await insertVoucher(company, -50000, { of: original, reason: 'Ghi nhầm' });
    await expect(insertVoucher(company, -50000, { of: original, reason: 'Lần hai' })).rejects.toThrow(
      /payment_vouchers_reversal_of_id_unique/,
    );
  });

  it('phiếu chi thường số âm hoặc 0 bị từ chối; phiếu chi đảo số âm được, số dương bị từ chối (D14)', async () => {
    const company = randomUUID();
    await expect(insertVoucher(company, -1)).rejects.toThrow(/"payment_vouchers_amount_sign"/);
    await expect(insertVoucher(company, 0)).rejects.toThrow(/"payment_vouchers_amount_sign"/);
    const original = await insertVoucher(company, 50000);
    await expect(insertVoucher(company, 50000, { of: original, reason: 'Sai' })).rejects.toThrow(
      /"payment_vouchers_amount_sign"/,
    );
    await expect(insertVoucher(company, -50000, { of: original, reason: 'Sai' })).resolves.toBeDefined();
  });

  it('phiếu thu cùng luật dấu tiền: phiếu thường số âm bị từ chối, phiếu đảo số âm được', async () => {
    const company = randomUUID();
    await expect(insertReceipt(company, -1)).rejects.toThrow(/"receipts_amount_sign"/);
    const original = await insertReceipt(company, 150000);
    await expect(
      insertReceipt(company, -150000, { of: original.rows[0]!.id, reason: 'Đảo phiếu thu' }),
    ).resolves.toBeDefined();
  });

  it('phiếu thu không có nháp', async () => {
    await expect(
      testPool().query(
        `insert into finance.receipts (company_id, number, source, amount, status) values ($1, $2, 'cod', 1000, 'draft')`,
        [randomUUID(), number('PT')],
      ),
    ).rejects.toThrow(/"receipts_not_draft"/);
  });

  it('chứng từ đảo bắt buộc có lý do; chứng từ thường không có lý do đảo', async () => {
    const company = randomUUID();
    const original = await insertVoucher(company, 50000);
    await expect(insertVoucher(company, -50000, { of: original })).rejects.toThrow(/"payment_vouchers_reversal_reason"/);
    await expect(insertVoucher(company, 50000, { reason: 'thừa' })).rejects.toThrow(/"payment_vouchers_reversal_reason"/);
    await expect(
      insertInvoice(company, randomUUID(), { reversalOfId: await insertInvoice(company, randomUUID()) }),
    ).rejects.toThrow(/"sales_invoices_reversal_reason"/);
  });

  it('bộ đếm số chứng từ cấp số dưới role ứng dụng, chỉ thấy của công ty mình', async () => {
    const company = randomUUID();
    await testPool().query(
      "insert into finance.doc_counters (company_id, doc_type, period) values ($1, 'receipt', '202610')",
      [company],
    );
    const next = await asCompany(company, (c) =>
      c.query<{ issued: number }>(
        `update finance.doc_counters set next_number = next_number + 1
         where doc_type = 'receipt' and period = '202610' returning next_number - 1 as issued`,
      ),
    );
    expect(next.rows).toEqual([{ issued: 1 }]);
    const other = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from finance.doc_counters where company_id = $1', [company]),
    );
    expect(other.rowCount).toBe(0);
  });
});
