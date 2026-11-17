// Ghi bù khoản trả NCC cho phiếu nhận đã ghi sổ trước #357 (migration `*_ghi-bu-tra-ncc.sql`). Phiếu dựng qua API
// purchasing thật (test không chạy consumer nên sổ chưa có dòng), chạy câu lệnh của migration trong giao dịch rồi
// rollback, như `line-cancel-migration.test.ts`.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { createSupplier, postedReceipt } from '../../product/purchasing/helpers.ts';

const MIGRATIONS = join(import.meta.dirname, '../../../../db/migrations');

const backfill = (): string => {
  const file = readdirSync(MIGRATIONS).find((f) => f.endsWith('_ghi-bu-tra-ncc.sql'));
  if (!file) throw new Error('Không thấy migration *_ghi-bu-tra-ncc.sql');
  return readFileSync(join(MIGRATIONS, file), 'utf8');
};

async function rolledBack(fn: (c: pg.PoolClient) => Promise<void>) {
  const c = await testPool().connect();
  try {
    await c.query('begin');
    await fn(c);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

let team: { companyId: string; ceo: string; requester: string; kho: string; supplierId: string };

beforeAll(async () => {
  const c = await createCompany();
  const t = {
    companyId: c.companyId,
    ceo: c.ceo.token,
    requester: (await addMember(c.companyId, 'warehouse')).token,
    kho: (await addMember(c.companyId, 'warehouse')).token,
  };
  team = { ...t, supplierId: (await createSupplier(t.ceo)).id };
});

describe('ghi bù supplier_payment cho phiếu nhận cũ (#357)', () => {
  it('mỗi phiếu đã ghi sổ một dòng = −round(Σ (đạt + lỗi) × giá); phiếu bù hàng không ghi; chạy lại không thêm', async () => {
    const variant = async () => (await createVariant(team.companyId)).variantId;
    const plain = await postedReceipt(team, team.supplierId, await variant(), { accepted: 55, defectKept: 2 });
    const odd = await postedReceipt(team, team.supplierId, await variant(), { accepted: 3 });
    const replacement = await postedReceipt(team, team.supplierId, await variant(), { accepted: 2 });

    await rolledBack(async (c) => {
      // Biến đề nghị của phiếu thứ ba thành đề nghị bù hàng (CHECK `purchase_requests_replacement` buộc hai cột đi cùng).
      await c.query(
        `update product.purchase_requests set source = 'replacement', source_return_id = gen_random_uuid()
         where id = (select request_id from product.goods_receipts where id = $1)`,
        [replacement.receiptId],
      );
      // Giá lẻ (API chỉ nhận giá nguyên đồng, cột là numeric(18,2)): 3 × 33.333,33 = 99.999,99 → 100.000, làm tròn
      // trên tổng phiếu như `postSupplierPayment`.
      await c.query(
        `update product.purchase_request_lines set unit_price = 33333.33
         where request_id = (select request_id from product.goods_receipts where id = $1)`,
        [odd.receiptId],
      );
      const sql = backfill();
      await c.query(sql);
      await c.query(sql);
      const { rows } = await c.query(
        `select e.source_id, e.kind, e.amount, e.is_estimate, e.shop_id, e.order_id,
                e.occurred_on = (r.posted_at at time zone 'Asia/Ho_Chi_Minh')::date as posted_day
         from finance.ledger_entries e join product.goods_receipts r on r.id = e.source_id
         where e.company_id = $1 and e.source_type = 'goods_receipt' order by e.amount`,
        [team.companyId],
      );
      const line = { kind: 'supplier_payment', is_estimate: false, shop_id: null, order_id: null, posted_day: true };
      expect(rows).toEqual([
        { ...line, source_id: plain.receiptId, amount: '-5700000.00' },
        { ...line, source_id: odd.receiptId, amount: '-100000.00' },
      ]);
    });
  });
});
