import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { stockArchiveBlockers } from '#src/modules/product/inventory/index.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { testPool } from '../../helpers/db.ts';
import { companyWithVariants, receive, setBuckets } from './helpers.ts';

// Lý do chặn lưu trữ SKU phần kho (#204, Documents/21 §17.3, spec 204 D10): catalog gọi trong giao dịch lưu trữ.
const blockersOf = (companyId: string, ids: string[]) => withCompany(companyId, () => stockArchiveBlockers(ids));

/** Phiếu kiểm kê ở `status`, một dòng mang SKU. */
async function stockDocument(companyId: string, variantId: string, status: 'draft' | 'pending' | 'posted') {
  const doc = await testPool().query<{ id: string }>(
    `insert into product.stock_documents (company_id, number, kind, status, counted_at, posted_at)
     values ($1, $2, 'stocktake', $3::product.stock_document_status, now(), case when $3::text = 'posted' then now() end)
     returning id`,
    [companyId, `KK-T${randomUUID().slice(0, 8)}`, status],
  );
  await testPool().query(
    'insert into product.stock_document_lines (company_id, document_id, variant_id, book_qty, counted_qty) values ($1, $2, $3, 0, 1)',
    [companyId, doc.rows[0]!.id, variantId],
  );
}

describe('stockArchiveBlockers (#204)', () => {
  it('SKU không có tồn, không có phiếu mở thì không có trong kết quả', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    expect(await blockersOf(companyId, variants)).toEqual(new Map());
  });

  it('liệt kê tồn thực, đang giữ, chờ xử lý theo thứ tự, mỗi câu khi số khác 0', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    await receive(companyId, v, 3, 100000);
    await setBuckets(companyId, v, { reserved: 1, quarantine: 2 });
    expect(await blockersOf(companyId, [v])).toEqual(new Map([[v, ['Còn 3 tồn thực', 'Đang giữ 1 cho đơn', 'Còn 2 chờ xử lý']]]));
  });

  it('đếm phiếu kho nháp, chờ duyệt có SKU; phiếu đã ghi sổ không tính', async () => {
    const { companyId, variants } = await companyWithVariants(2);
    const [draft, posted] = variants as [string, string];
    await stockDocument(companyId, draft, 'draft');
    await stockDocument(companyId, draft, 'pending');
    await stockDocument(companyId, posted, 'posted');
    expect(await blockersOf(companyId, [draft, posted])).toEqual(new Map([[draft, ['Còn 2 phiếu kho chưa ghi sổ']]]));
  });

  it('khoá dòng tồn tới hết giao dịch, kể cả SKU chưa có dòng tồn (spec 204 D10)', async () => {
    const { companyId, variants } = await companyWithVariants(1);
    const v = variants[0]!;
    const other = await testPool().connect();
    try {
      await withCompany(companyId, async () => {
        await stockArchiveBlockers([v]);
        // Ghi sổ kho khoá dòng tồn như `lockLevel`: chèn nếu chưa có rồi `for update`. Phải chờ tới khi lưu trữ xong.
        await other.query('begin');
        await other.query("set local lock_timeout = '300ms'");
        await expect(
          other.query(
            'insert into product.stock_levels (company_id, variant_id) values ($1, $2) on conflict do nothing',
            [companyId, v],
          ),
        ).rejects.toMatchObject({ code: '55P03' });
        await other.query('rollback');
      });
      const after = await other.query('select 1 from product.stock_levels where variant_id = $1 for update nowait', [v]);
      expect(after.rowCount).toBe(1);
    } finally {
      other.release();
    }
  });
});
