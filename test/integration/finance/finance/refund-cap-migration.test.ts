// Migration `*_tran-hoan-tien-du-lieu` (#355) trên dữ liệu kiểu cũ, so với code: cùng kịch bản chạy hai đường. Đường code
// ghi bằng `recordReturnRefunded` (có trần); đường cũ ghi `customer_refund` bằng đúng số sàn báo như trước #355, rồi chạy
// file migration. Số hoàn còn hiệu lực của mỗi yêu cầu (`customer_refund` + dòng đảo) và câu cờ phải bằng nhau.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { insertEntries } from '#src/modules/finance/finance/repository/ledger.ts';
import { recordPackageDelivered, recordReturnRefunded } from '#src/modules/finance/finance/service/ledger.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createOrder } from '../../helpers/sales.ts';
import { createReturnRequest } from './return-helpers.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const FILE = join(DIR, readdirSync(DIR).find((f) => f.endsWith('_tran-hoan-tien-du-lieu.sql'))!);

/** Một bước hoàn: yêu cầu `qty` món của kiện đã giao (`delivered`) hay kiện chưa giao, sàn báo `amount`. */
type Step = { delivered: boolean; qty: number; amount: string };

/** Dựng đơn 2 × 100.000 của một công ty, giao một kiện nếu kịch bản cần, rồi hoàn theo từng bước bằng `write`. */
async function build(steps: readonly Step[], write: (companyId: string, e: Parameters<typeof recordReturnRefunded>[1]) => Promise<unknown>) {
  const c = await createCompany();
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 100000 }], source: 'marketplace' });
  const shopId = randomUUID();
  const pkg = randomUUID();
  if (steps.some((s) => s.delivered)) {
    await recordPackageDelivered(c.companyId, {
      packageId: pkg,
      orderId: order.orderId,
      shopId,
      deliveredAt: '2026-11-04T08:00:00Z',
      lines: [{ variantId: v.variantId, quantity: 2, unitPrice: '100000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
  }
  const ids: string[] = [];
  for (const s of steps) {
    const { returnRequestId } = await createReturnRequest(c.companyId, {
      orderId: order.orderId,
      packageId: s.delivered ? pkg : randomUUID(),
      quantity: s.qty,
      unitPrice: 100000,
    });
    // Mỗi bước một giao dịch: `created_at` (now() của giao dịch) tăng theo thứ tự ghi như dữ liệu thật.
    await write(c.companyId, { returnRequestId, orderId: order.orderId, shopId, refundAmount: s.amount, refundedAt: '2026-11-05T02:00:00Z' });
    ids.push(returnRequestId);
  }
  return ids;
}

/** Ghi kiểu cũ (trước #355): `customer_refund` ước tính bằng đúng số sàn báo. */
const legacyWrite = (companyId: string, e: Parameters<typeof recordReturnRefunded>[1]) =>
  withCompany(companyId, () =>
    insertEntries([
      {
        companyId,
        kind: 'customer_refund',
        amount: (-Number(e.refundAmount)).toFixed(2),
        isEstimate: true,
        occurredOn: '2026-11-05',
        orderId: e.orderId,
        shopId: e.shopId,
        returnRequestId: e.returnRequestId,
        sourceType: 'return_refund',
        sourceId: e.returnRequestId,
        configVersionId: null,
      },
    ]),
  );

type Outcome = { net: string; note: string | null }[];

const outcomeSql = `
  select coalesce((select sum(amount) from finance.ledger_entries
                   where source_type = 'return_refund' and source_id = r.id and kind in ('customer_refund', 'adjustment')), 0)::numeric(14, 2)::text as net,
         r.attention_note as note
  from "order".return_requests r where r.id = any($1) order by array_position($1, r.id)`;

async function codeOutcome(ids: string[]): Promise<Outcome> {
  return (await testPool().query(outcomeSql, [ids])).rows;
}

/** Chạy file migration hai lần trong một giao dịch rồi rollback; trả kết quả sau lần đầu và số dòng mỗi lần báo. */
async function migrate(ids: string[]): Promise<{ outcome: Outcome; notices: string[]; adjustments: number }> {
  const client = await testPool().connect();
  const notices: string[] = [];
  const onNotice = (n: { message?: string }) => notices.push(n.message ?? '');
  client.on('notice', onNotice);
  try {
    await client.query('begin');
    const sql = readFileSync(FILE, 'utf8');
    await client.query(sql);
    const outcome = (await client.query(outcomeSql, [ids])).rows as Outcome;
    await client.query(sql);
    const { rowCount } = await client.query(`select 1 from finance.ledger_entries where kind = 'adjustment' and source_id = any($1)`, [ids]);
    await client.query('rollback');
    return { outcome, notices, adjustments: rowCount ?? 0 };
  } finally {
    client.off('notice', onNotice);
    client.release();
  }
}

const scenarios: [string, Step[]][] = [
  ['COD hoàn về, chưa có doanh thu', [{ delivered: false, qty: 1, amount: '110000' }]],
  ['trả một món sau giao (không vượt)', [{ delivered: true, qty: 1, amount: '100000' }]],
  [
    'hai yêu cầu cùng đơn vượt tổng doanh thu',
    [
      { delivered: true, qty: 2, amount: '150000' },
      { delivered: true, qty: 1, amount: '100000' },
    ],
  ],
  ['sàn báo hoàn lẻ đồng vượt doanh thu', [{ delivered: true, qty: 1, amount: '100000.5' }]],
];

describe('migration trần hoàn tiền trên dữ liệu cũ (#355)', () => {
  it.each(scenarios)('%s: kết quả bằng đường code; chạy lại không thêm dòng đảo', async (_label, steps) => {
    const code = await codeOutcome(await build(steps, recordReturnRefunded));
    const legacyIds = await build(steps, legacyWrite);
    const { outcome, notices, adjustments } = await migrate(legacyIds);
    expect(outcome).toEqual(code);
    const expected = code.filter((c, i) => c.net !== (-Number(steps[i]!.amount)).toFixed(2)).length;
    expect(adjustments).toBe(expected);
    // Lần chạy thứ hai không đảo thêm dòng nào (số dòng đảo khoá theo nguồn).
    expect(notices.at(-1)).toBe('#355: đảo 0 dòng hoàn tiền vượt doanh thu đã ghi');
  });

  it('dòng hoàn tiền ước tính đã được quyết toán thực tế thay: không đảo', async () => {
    const [id] = await build([{ delivered: false, qty: 1, amount: '110000' }], legacyWrite);
    const c = await testPool().query<{ id: string; company_id: string; order_id: string; shop_id: string }>(
      `select id, company_id, order_id, shop_id from finance.ledger_entries where source_id = $1`,
      [id],
    );
    const e = c.rows[0]!;
    const actual = await testPool().query<{ id: string }>(
      `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, order_id, shop_id)
       values ($1, 'customer_refund', -110000, false, '2026-11-06', $2, $3) returning id`,
      [e.company_id, e.order_id, e.shop_id],
    );
    await testPool().query(`insert into finance.ledger_replacements (company_id, actual_id, estimate_id) values ($1, $2, $3)`, [
      e.company_id,
      actual.rows[0]!.id,
      e.id,
    ]);
    const { outcome, adjustments } = await migrate([id!]);
    expect(adjustments).toBe(0);
    expect(outcome).toEqual([{ net: '-110000.00', note: null }]);
  });
});
