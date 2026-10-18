import { describe, expect, it } from 'vitest';
import { testPool } from '../helpers/db.ts';

/** Bảng theo ERD của từng schema (plan chuẩn bị 4.2, AC-7). PR sau thêm schema của mình vào đây. */
const EXPECTED_TABLES: Record<string, readonly string[]> = {
  catalog: [
    'attribute_values',
    'attributes',
    'categories',
    'product_images',
    'product_variants',
    'products',
    'variant_attribute_values',
  ],
  pricing: ['pricelist_items', 'pricelists'],
  inventory: [
    'doc_counters',
    'reorder_rules',
    'reservations',
    'stock_issue_lines',
    'stock_issues',
    'stock_levels',
    'stock_moves',
    'stock_receipt_lines',
    'stock_receipts',
  ],
};

// Hình dạng schema sau khi chạy đủ migration trên DB trống (AC-7).
describe('schema sau migration', () => {
  it.each(Object.entries(EXPECTED_TABLES))('schema %s có đủ bảng theo ERD', async (schema, expected) => {
    const res = await testPool().query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = $1 and table_type = 'BASE TABLE' order by 1`,
      [schema],
    );
    expect(res.rows.map((r) => r.table_name)).toEqual(expected);
  });

  it('mọi cột numeric là numeric(18,2)', async () => {
    const res = await testPool().query<{ col: string; p: number | null; s: number | null }>(
      `select table_schema || '.' || table_name || '.' || column_name as col,
              numeric_precision as p, numeric_scale as s
       from information_schema.columns
       where data_type = 'numeric' and table_schema not in ('pg_catalog', 'information_schema')`,
    );
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.filter((r) => r.p !== 18 || r.s !== 2).map((r) => r.col)).toEqual([]);
  });

  it('không có khoá ngoại chéo schema (19-D1)', async () => {
    const res = await testPool().query<{ name: string }>(
      `select conname as name from pg_constraint c
       join pg_class src on src.oid = c.conrelid
       join pg_class dst on dst.oid = c.confrelid
       where c.contype = 'f' and src.relnamespace <> dst.relnamespace`,
    );
    expect(res.rows.map((r) => r.name)).toEqual([]);
  });
});
