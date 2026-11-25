// Migration #434: `*_can-nang-kich-thuoc-du-lieu` (viết tay) xoá trống cân nặng, cạnh vượt trần rồi
// `*_can-nang-kich-thuoc-tran` (sinh từ `schema.ts`) siết CHECK `product_variants_dimensions`. DB test đã chạy mọi migration nên
// không còn ghi được số vượt trần: ca này gỡ CHECK trong một giao dịch, dựng dữ liệu kiểu staging 18/11, chạy hai file rồi rollback.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const sqlOf = (slug: string) => {
  const file = readdirSync(DIR).find((f) => f.endsWith(`_${slug}.sql`));
  expect(file, `chưa có file migration *_${slug}.sql`).toBeDefined();
  return readFileSync(join(DIR, file!), 'utf8').replaceAll('--> statement-breakpoint', '');
};

describe('migration trần cân nặng, kích thước (#434)', () => {
  it('xoá trống đúng ô vượt trần, tăng version dòng bị sửa, giữ dòng hợp lệ; CHECK mới thêm được; chạy lại không đổi gì', async () => {
    const company = randomUUID();
    const big = await createVariant(company);
    const ok = await createVariant(company);
    const client = await testPool().connect();
    try {
      await client.query('begin');
      // CHECK trước #434 (0001_tao-bang.sql): chỉ `> 0`.
      await client.query(`
        alter table product.product_variants drop constraint product_variants_dimensions;
        alter table product.product_variants add constraint product_variants_dimensions
          check (weight_g > 0 and length_mm > 0 and width_mm > 0 and height_mm > 0)`);
      const set = 'update product.product_variants set weight_g = $2, length_mm = $3, width_mm = $4, height_mm = $5 where id = $1';
      await client.query(set, [big.variantId, 999_999_999, 305, 2_001, 30]);
      await client.query(set, [ok.variantId, 50_000, 2_000, 2_000, 2_000]);

      await client.query(sqlOf('can-nang-kich-thuoc-du-lieu'));
      await client.query(sqlOf('can-nang-kich-thuoc-tran'));
      const rows = async () =>
        (
          await client.query(
            'select id, weight_g, length_mm, width_mm, height_mm, version from product.product_variants where id = any($1) order by sku',
            [[big.variantId, ok.variantId]],
          )
        ).rows;
      const after = await rows();
      expect(after.find((r) => r.id === big.variantId)).toMatchObject({
        weight_g: null,
        length_mm: 305,
        width_mm: null,
        height_mm: 30,
        version: 2,
      });
      expect(after.find((r) => r.id === ok.variantId)).toMatchObject({
        weight_g: 50_000,
        length_mm: 2_000,
        width_mm: 2_000,
        height_mm: 2_000,
        version: 1,
      });

      await client.query(sqlOf('can-nang-kich-thuoc-du-lieu'));
      expect(await rows()).toEqual(after);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
