// Thông số mặc định (#510, Documents/21 mục 5.5 "Seed"): công ty mới nhận thư viện thông số, trục chuẩn, mẫu 12 nhóm từ
// `seedCompanyDefaults`; migration `*_thong-so-du-lieu` dựng lại đúng như vậy cho công ty có trước. Migration chạy trong
// giao dịch rồi rollback, chỉ cho một công ty (thay `core.companies` bằng đúng công ty đó) để không đụng file test khác.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP_TEMPLATES, DEFAULT_SPEC_FIELDS } from '#src/modules/product/index.ts';
import { registerCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const SQL = readFileSync(join(DIR, readdirSync(DIR).find((f) => f.endsWith('_thong-so-du-lieu.sql'))!), 'utf8');

async function snapshot(db: PoolClient | ReturnType<typeof testPool>, companyId: string) {
  const q = async (sql: string) => (await db.query(sql, [companyId])).rows;
  return {
    fields: await q(`select code, name, input, unit, allow_custom from product.spec_fields where company_id = $1 order by code`),
    options: await q(
      `select f.code, o.value, o.position from product.spec_field_options o join product.spec_fields f on f.id = o.field_id
       where o.company_id = $1 order by f.code, o.position`,
    ),
    axes: await q(
      `select g.name, a1.platform_kind as k1, a2.platform_kind as k2 from product.product_groups g
       left join product.attributes a1 on a1.id = g.axis1_attribute_id left join product.attributes a2 on a2.id = g.axis2_attribute_id
       where g.company_id = $1 order by g.name`,
    ),
    template: await q(
      `select g.name, f.code, t.required, t.position from product.group_spec_fields t
       join product.product_groups g on g.id = t.group_id join product.spec_fields f on f.id = t.field_id
       where t.company_id = $1 order by g.name, t.position`,
    ),
    attributes: await q(
      `select a.name, a.platform_kind, (select json_agg(json_build_array(v.value, v.code) order by v.created_at, v.id)
         from product.attribute_values v where v.attribute_id = a.id) as values
       from product.attributes a where a.company_id = $1 order by a.platform_kind`,
    ),
  };
}

/** Gỡ mọi thứ #510 thêm cho công ty, như công ty lập trước migration. */
async function strip(client: PoolClient, companyId: string) {
  for (const sql of [
    'delete from product.group_spec_fields where company_id = $1',
    'delete from product.spec_field_options where company_id = $1',
    'delete from product.spec_fields where company_id = $1',
    'update product.product_groups set axis2_attribute_id = null, axis1_attribute_id = null where company_id = $1',
    `delete from product.attribute_values where attribute_id in
       (select id from product.attributes where company_id = $1 and platform_kind in ('volume', 'flavor'))`,
    `delete from product.attributes where company_id = $1 and platform_kind in ('volume', 'flavor')`,
  ]) {
    await client.query(sql, [companyId]);
  }
}

/** Chạy file migration chỉ cho một công ty. */
async function migrate(client: PoolClient, companyId: string) {
  const scoped = SQL.replaceAll('"core"."companies" c', `(select * from core.companies where id = '${companyId}') c`);
  for (const stmt of scoped.split('--> statement-breakpoint')) await client.query(stmt);
}

async function inRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('thông số mặc định của công ty (#510)', () => {
  it('công ty mới: thư viện thông số, lựa chọn, trục chuẩn, mẫu 12 nhóm khớp hằng số trong code', async () => {
    const { companyId } = await registerCompany();
    const s = await snapshot(testPool(), companyId);
    expect(s.fields.map((f) => f.code).sort()).toEqual(DEFAULT_SPEC_FIELDS.map((f) => f.code).sort());
    const optionCount = DEFAULT_SPEC_FIELDS.reduce((n, f) => n + (f.options?.length ?? 0), 0);
    expect(s.options).toHaveLength(optionCount);
    expect(s.attributes.map((a) => [a.name, a.platform_kind])).toEqual([
      ['Màu sắc', 'color'],
      ['Hương vị', 'flavor'],
      ['Kích cỡ', 'size'],
      ['Dung tích', 'volume'],
    ]);
    for (const t of DEFAULT_GROUP_TEMPLATES) {
      const axes = s.axes.find((g) => g.name === t.group)!;
      expect([axes.k1, axes.k2].filter(Boolean), t.group).toEqual(t.axes);
      const fields = s.template.filter((r) => r.name === t.group).map((r) => [r.code, r.required]);
      expect(fields, t.group).toEqual(t.fields.map(([code, required]) => [code, required]));
    }
  });

  it('migration dựng lại cho công ty chưa có thông số giống hệt công ty mới, chạy lại không đổi', async () => {
    const { companyId } = await registerCompany();
    const fresh = await snapshot(testPool(), companyId);
    await inRollback(async (client) => {
      await strip(client, companyId);
      expect((await snapshot(client, companyId)).fields).toEqual([]);
      await migrate(client, companyId);
      expect(await snapshot(client, companyId)).toEqual(fresh);
      await migrate(client, companyId);
      expect(await snapshot(client, companyId)).toEqual(fresh);
    });
  });

  it('migration gắn loại vào thuộc tính "dung tích" có sẵn thay vì thêm thuộc tính trùng tên; giữ mẫu nhóm đã tự đặt', async () => {
    const { companyId } = await registerCompany();
    await inRollback(async (client) => {
      await strip(client, companyId);
      await client.query(`insert into product.attributes (company_id, name) values ($1, 'Dung Tích')`, [companyId]);
      const own = await client.query<{ id: string }>(
        `insert into product.spec_fields (company_id, code, name, input) values ($1, 'rieng', 'Riêng', 'text') returning id`,
        [companyId],
      );
      await client.query(
        `insert into product.group_spec_fields (company_id, group_id, field_id, position)
         select $1, id, $2, 0 from product.product_groups where company_id = $1 and name = 'Mỹ phẩm & làm đẹp'`,
        [companyId, own.rows[0]!.id],
      );
      await migrate(client, companyId);
      const s = await snapshot(client, companyId);
      expect(s.attributes.filter((a) => a.platform_kind === 'volume').map((a) => a.name)).toEqual(['Dung Tích']);
      expect(s.template.filter((r) => r.name === 'Mỹ phẩm & làm đẹp').map((r) => r.code)).toEqual(['rieng']);
      expect(s.axes.find((g) => g.name === 'Mỹ phẩm & làm đẹp')).toMatchObject({ k1: 'color', k2: 'volume' });
    });
  });
});
