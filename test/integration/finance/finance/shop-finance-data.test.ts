import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type FinanceDataCounts, hasFinanceData, purgeShopFinance, shopFinanceData } from '#src/modules/finance/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

// #398: xoá gian hàng đã ngắt. Gian hàng có dữ liệu tiền (theo `shop_id` hoặc đơn của gian hàng) thì không xoá được;
// đối soát `none` và cấu hình phí của gian hàng thì xoá cùng gian hàng.

const db = testPool();
const ZERO: FinanceDataCounts = {
  ledgerEntries: 0,
  ledgerPackageLines: 0,
  settlementStatements: 0,
  settlementBatches: 0,
  orderSettlements: 0,
  documents: 0,
  payments: 0,
};

type Seed = (c: { companyId: string; shopId: string; orderId: string }) => Promise<unknown>;

const groups: [keyof FinanceDataCounts, Seed][] = [
  [
    'ledgerEntries',
    ({ companyId, shopId, orderId }) =>
      db.query(
        `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, shop_id, order_id)
         values ($1, 'revenue', '110000', true, '2026-11-01', $2, $3)`,
        [companyId, shopId, orderId],
      ),
  ],
  [
    'ledgerPackageLines',
    ({ companyId, shopId, orderId }) =>
      db.query(
        `insert into finance.ledger_package_lines (company_id, package_id, line_no, order_id, shop_id, quantity, unit_price, occurred_on)
         values ($1, $2, 1, $3, $4, 1, '100000', '2026-11-01')`,
        [companyId, randomUUID(), orderId, shopId],
      ),
  ],
  [
    'settlementStatements',
    ({ companyId, shopId }) =>
      db.query(
        `insert into finance.settlement_statements (company_id, shop_id, external_statement_id, statement_time, settlement_amount, payment_status)
         values ($1, $2, $3, now(), '100000', 'PAID')`,
        [companyId, shopId, randomUUID()],
      ),
  ],
  [
    'settlementBatches',
    ({ companyId, shopId }) =>
      db.query(
        `insert into finance.settlement_batches (company_id, shop_id, source, period_from, period_to, status)
         values ($1, $2, 'api', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z', 'done')`,
        [companyId, shopId],
      ),
  ],
  [
    'orderSettlements',
    ({ companyId, shopId, orderId }) =>
      db.query(`insert into finance.order_settlements (order_id, company_id, shop_id, status) values ($1, $2, $3, 'pending')`, [
        orderId,
        companyId,
        shopId,
      ]),
  ],
  [
    'documents',
    ({ companyId, orderId }) =>
      db.query(`insert into finance.sales_invoices (company_id, number, order_id, total) values ($1, $2, $3, '100000')`, [
        companyId,
        `HD-${randomUUID().slice(0, 8)}`,
        orderId,
      ]),
  ],
  [
    'payments',
    ({ companyId, orderId }) =>
      db.query(`insert into finance.order_payments (order_id, company_id, status) values ($1, $2, 'unpaid')`, [orderId, companyId]),
  ],
];

async function scope() {
  const { companyId } = await createCompany();
  return { companyId, shopId: randomUUID(), orderId: randomUUID() };
}

/** Phiên bản cấu hình phí của gian hàng; `supersedes` là bản trước. */
async function feeConfig(companyId: string, shopId: string, supersedes: string | null = null): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, supersedes_id)
     values ($1, 'fee', $2, 'draft', '{}', $3) returning id`,
    [companyId, shopId, supersedes],
  );
  return rows[0]!.id;
}

describe('dữ liệu tiền của gian hàng (#398)', () => {
  it.each(groups)('nhóm %s có một dòng thì đếm được 1, nhóm khác 0', async (group, seed) => {
    const s = await scope();
    await seed(s);

    const counts = await withCompany(s.companyId, () => shopFinanceData(s.shopId, [s.orderId]));

    expect(counts).toEqual({ ...ZERO, [group]: 1 });
    expect(hasFinanceData(counts)).toBe(true);
  });

  it('order_settlements none không tính', async () => {
    const s = await scope();
    await db.query(`insert into finance.order_settlements (order_id, company_id, shop_id, status) values ($1, $2, $3, 'none')`, [
      s.orderId,
      s.companyId,
      s.shopId,
    ]);

    const counts = await withCompany(s.companyId, () => shopFinanceData(s.shopId, [s.orderId]));

    expect(counts).toEqual(ZERO);
    expect(hasFinanceData(counts)).toBe(false);
  });

  it('không tính dữ liệu của gian hàng khác', async () => {
    const s = await scope();
    for (const [, seed] of groups) await seed({ ...s, shopId: randomUUID(), orderId: randomUUID() });

    expect(await withCompany(s.companyId, () => shopFinanceData(s.shopId, [s.orderId]))).toEqual(ZERO);
  });

  it('xoá đối soát none và cấu hình phí của gian hàng', async () => {
    const s = await scope();
    await db.query(`insert into finance.order_settlements (order_id, company_id, shop_id, status) values ($1, $2, $3, 'none')`, [
      s.orderId,
      s.companyId,
      s.shopId,
    ]);
    const first = await feeConfig(s.companyId, s.shopId);
    await feeConfig(s.companyId, s.shopId, first);
    const otherShop = randomUUID();
    const other = await feeConfig(s.companyId, otherShop);

    const result = await withCompany(s.companyId, () => purgeShopFinance(s.shopId, [s.orderId]));

    expect(result).toEqual({ orderSettlements: 1, configVersions: 2 });
    const left = await db.query<{ id: string }>('select id from finance.config_versions where shop_id = any($1)', [[s.shopId, otherShop]]);
    expect(left.rows.map((r) => r.id)).toEqual([other]);
    const settlements = await db.query('select 1 from finance.order_settlements where order_id = $1', [s.orderId]);
    expect(settlements.rowCount).toBe(0);
  });
});
