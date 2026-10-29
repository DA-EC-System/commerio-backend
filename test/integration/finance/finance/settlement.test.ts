import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const number = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

async function insertStatement(companyId: string): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into finance.settlement_statements
       (company_id, shop_id, external_statement_id, statement_time, settlement_amount, payment_status)
     values ($1, $2, $3, now(), 100000, 'PAID') returning id`,
    [companyId, randomUUID(), number('ST')],
  );
  return res.rows[0]!.id;
}

async function insertLine(
  companyId: string,
  statementId: string,
  fields: { txn?: string; matchStatus?: string; reason?: string | null } = {},
): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into finance.settlement_lines
       (company_id, statement_id, kind, external_transaction_id, revenue, fees, settlement, match_status,
        discrepancy_reason, raw)
     values ($1, $2, 'order', $3, 150000, '{}', 120000, $4, $5, '{}') returning id`,
    [
      companyId,
      statementId,
      fields.txn ?? number('TX'),
      fields.matchStatus ?? 'matched',
      fields.reason ?? null,
    ],
  );
  return res.rows[0]!.id;
}

const insertSettlementReceipt = (companyId: string, settlementLineId: string) =>
  testPool().query(
    `insert into finance.receipts (company_id, number, source, settlement_line_id, amount)
     values ($1, $2, 'settlement', $3, 120000)`,
    [companyId, number('PT'), settlementLineId],
  );

async function insertSupplierInvoice(companyId: string): Promise<string> {
  const res = await testPool().query<{ id: string }>(
    `insert into finance.supplier_invoices (company_id, supplier_id, invoice_no, invoice_date, amount, amount_due)
     values ($1, $2, $3, current_date, 500000, 500000) returning id`,
    [companyId, randomUUID(), number('HDNCC')],
  );
  return res.rows[0]!.id;
}

const insertSupplierVoucher = (companyId: string, supplierInvoiceId: string) =>
  testPool().query(
    `insert into finance.payment_vouchers
       (company_id, number, purpose, supplier_invoice_id, amount, paid_on, created_by)
     values ($1, $2, 'supplier_payment', $3, 500000, current_date, $4)`,
    [companyId, number('PC'), supplierInvoiceId, randomUUID()],
  );

// Đối soát sàn và hoá đơn nhà cung cấp (plan chuẩn bị A9, A7 dòng settlement_lines; 4.3 phần CB-4; AC-9).
describe('ràng buộc đối soát và hoá đơn nhà cung cấp (AC-9)', () => {
  it('phiếu thu trỏ dòng đối soát không có bị từ chối; dòng có thật thì được', async () => {
    const company = randomUUID();
    await expect(insertSettlementReceipt(company, randomUUID())).rejects.toThrow(/receipts_settlement_line_id/);
    const line = await insertLine(company, await insertStatement(company));
    await expect(insertSettlementReceipt(company, line)).resolves.toBeDefined();
  });

  it('phiếu chi trỏ hoá đơn nhà cung cấp không có bị từ chối; hoá đơn có thật thì được', async () => {
    const company = randomUUID();
    await expect(insertSupplierVoucher(company, randomUUID())).rejects.toThrow(/payment_vouchers_supplier_invoice_id/);
    await expect(insertSupplierVoucher(company, await insertSupplierInvoice(company))).resolves.toBeDefined();
  });

  it('một mã giao dịch sàn một dòng đối soát mỗi công ty; công ty khác cùng mã thì được (chạy lại đối soát)', async () => {
    const company = randomUUID();
    const txn = number('TX');
    await insertLine(company, await insertStatement(company), { txn });
    await expect(insertLine(company, await insertStatement(company), { txn })).rejects.toThrow(
      /settlement_lines_company_id_external_transaction_id_unique/,
    );
    const other = randomUUID();
    await expect(insertLine(other, await insertStatement(other), { txn })).resolves.toBeDefined();
  });

  it('lý do chênh lệch có khi và chỉ khi dòng ở trạng thái discrepancy', async () => {
    const company = randomUUID();
    const statement = await insertStatement(company);
    await expect(insertLine(company, statement, { matchStatus: 'discrepancy' })).rejects.toThrow(
      /"settlement_lines_discrepancy_reason"/,
    );
    await expect(insertLine(company, statement, { reason: 'revenue_mismatch' })).rejects.toThrow(
      /"settlement_lines_discrepancy_reason"/,
    );
    await expect(
      insertLine(company, statement, { matchStatus: 'discrepancy', reason: 'order_not_found' }),
    ).resolves.toBeDefined();
  });

  it('dòng đối soát chỉ thấy trong công ty của nó (RLS)', async () => {
    const company = randomUUID();
    await insertLine(company, await insertStatement(company));
    const own = await asCompany(company, (c) => c.query('select 1 from finance.settlement_lines'));
    expect(own.rowCount).toBe(1);
    const other = await asCompany(randomUUID(), (c) =>
      c.query('select 1 from finance.settlement_lines where company_id = $1', [company]),
    );
    expect(other.rowCount).toBe(0);
  });
});
