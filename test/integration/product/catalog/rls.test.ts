import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';
import { createAttribute, createCategory, createProduct, valueId } from './helpers.ts';

// AC-1 vế RLS (issue #12; Documents/19 D30, Documents/21 C4): dưới công ty A chỉ thấy dòng của A.
// `rls-coverage.test.ts` chỉ kiểm có policy tên `company_isolation`; ở đây kiểm biểu thức và đọc dữ liệu thật.

const SCHEMAS = ['product'];
const ISOLATION = "(company_id = (NULLIF(current_setting('app.company_id'::text, true), ''::text))::uuid)";

async function companyTables(): Promise<string[]> {
  const res = await testPool().query<{ name: string }>(
    `select table_schema || '.' || table_name as name from information_schema.columns
     where table_schema = any($1) and column_name = 'company_id' order by 1`,
    [SCHEMAS],
  );
  return res.rows.map((r) => r.name);
}

/** Một công ty có đủ dòng ở 7 bảng catalog (qua API), một bảng giá chuẩn và một dòng tồn. */
async function seedCompany(prefix: string) {
  const { companyId, ceo } = await createCompany();
  const color = await createAttribute(ceo.token, `${prefix} Màu`, ['Đen']);
  const category = await createCategory(ceo.token, `${prefix} Áo`, `${prefix}-{SEQ}-{VAL}`);
  const product = await createProduct(ceo.token, { name: `${prefix} Áo`, categoryId: category.id, variants: [[valueId(color, 'Đen')]] });
  const variantId = product.variants[0]!.id;
  await testPool().query(
    "insert into product.product_images (company_id, product_id, file_id, position) values ($1, $2, $3, 0)",
    [companyId, product.id, randomUUID()],
  );
  await testPool().query('insert into product.stock_levels (company_id, variant_id) values ($1, $2)', [companyId, variantId]);
  return companyId;
}

describe('RLS schema product (AC-1)', () => {
  it('mọi bảng có company_id của schema product bật RLS và có đúng policy cô lập theo app.company_id', async () => {
    const tables = await companyTables();
    expect(tables).toHaveLength(20);
    const res = await testPool().query<{ name: string; rls: boolean; quals: string[] }>(
      `select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls,
              coalesce((select array_agg(qual) from pg_policies p where p.schemaname = n.nspname and p.tablename = c.relname), '{}') as quals
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname || '.' || c.relname = any($1)`,
      [tables],
    );
    for (const row of res.rows) expect(row, row.name).toEqual({ name: row.name, rls: true, quals: [ISOLATION] });
  });

  it('dưới công ty A chỉ đọc được dòng của A; chưa đặt app.company_id thì không thấy dòng nào', async () => {
    const a = await seedCompany(`RA${randomUUID().slice(0, 4).toUpperCase()}`);
    await seedCompany(`RB${randomUUID().slice(0, 4).toUpperCase()}`);
    const seeded = [
      'product.categories',
      'product.attributes',
      'product.attribute_values',
      'product.products',
      'product.product_images',
      'product.product_variants',
      'product.variant_attribute_values',
      'product.stock_levels',
    ];
    for (const table of await companyTables()) {
      const rows = await asCompany(a, async (c) => (await c.query<{ company_id: string }>(`select company_id from ${table}`)).rows);
      expect(rows.every((r) => r.company_id === a), table).toBe(true);
      if (seeded.includes(table)) expect(rows.length, table).toBeGreaterThan(0);
    }
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('set local role commerio_app');
      const res = await client.query('select count(*)::int as n from product.products');
      expect(res.rows[0]).toEqual({ n: 0 });
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
