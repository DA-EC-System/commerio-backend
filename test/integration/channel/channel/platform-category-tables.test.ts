// Bảng category và attribute của sàn (#400 lát 1, Documents/19 mục 2, 3.3): hai bảng tham chiếu không theo công ty (request
// chỉ đọc), hai bảng theo công ty có RLS, CHECK text đơn của từng cột trạng thái (AC-S3).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { asCompany } from '../../helpers/rls.ts';

const pool = () => testPool();

async function seedShop(companyId: string, platform = 'tiktok'): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, $2, $3, 'Gian hàng thử') returning id`,
    [companyId, platform, `ext-${randomUUID()}`],
  );
  return rows[0]!.id;
}

async function seedSpec(companyId: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const productId = randomUUID();
  const v = { platform: 'lazada', source: 'push', category_status: 'ok', version: 1, ...overrides };
  await pool().query(
    `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source, category_status, version)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [companyId, productId, v.platform, `cat-${randomUUID()}`, v.source, v.category_status, v.version],
  );
  return productId;
}

const errorOf = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; constraint?: string };
  }
};

describe('bảng tham chiếu category, attribute của sàn', () => {
  it('commerio_app chỉ đọc được, ghi bị từ chối (42501)', async () => {
    const { companyId } = await createCompany();
    const externalId = `t-${randomUUID()}`;
    await pool().query(
      `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status)
       values ('lazada', $1, 'Áo thun', true, 'Thời trang > Áo thun', 'thoi trang > ao thun', 'active')`,
      [externalId],
    );
    await asCompany(companyId, async (c) => {
      const read = await c.query('select external_id from channel.platform_categories where external_id = $1', [externalId]);
      expect(read.rows).toHaveLength(1);
    });
    for (const sql of [
      `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status)
       values ('lazada', '${randomUUID()}', 'x', true, 'x', 'x', 'active')`,
      `update channel.platform_categories set name = 'y' where external_id = '${externalId}'`,
      `delete from channel.platform_categories where external_id = '${externalId}'`,
      `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, tier, fetched_at)
       values ('lazada', '${externalId}', 'brand', 'Thương hiệu', 'property', 'select', 'product', now())`,
    ]) {
      const err = await asCompany(companyId, (c) => errorOf(() => c.query(sql)));
      expect(err?.code, sql).toBe('42501');
    }
  });

  it('attribute phải trỏ tới category có thật cùng sàn (khoá ngoại ghép)', async () => {
    const err = await errorOf(() =>
      pool().query(
        `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, tier, fetched_at)
         values ('lazada', $1, 'brand', 'Thương hiệu', 'property', 'select', 'product', now())`,
        [`khong-co-${randomUUID()}`],
      ),
    );
    expect(err?.code).toBe('23503');
  });

  it.each([
    ['status', `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status)
       values ('lazada', '${randomUUID()}', 'x', true, 'x', 'x', 'hidden')`, 'platform_categories_status'],
    ['size_chart_rule', `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status, size_chart_rule)
       values ('lazada', '${randomUUID()}', 'x', true, 'x', 'x', 'active', 'maybe')`, 'platform_categories_size_chart_rule'],
  ])('CHECK %s chặn giá trị lạ', async (_label, sql, constraint) => {
    const err = await errorOf(() => pool().query(sql));
    expect(err).toMatchObject({ code: '23514', constraint });
  });

  it.each([
    ['kind', { kind: 'other' }, 'platform_category_attributes_kind'],
    ['input', { input: 'slider' }, 'platform_category_attributes_input'],
    ['tier', { tier: 'shop' }, 'platform_category_attributes_tier'],
  ])('CHECK %s của attribute chặn giá trị lạ', async (_label, bad, constraint) => {
    const externalId = `t-${randomUUID()}`;
    await pool().query(
      `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status)
       values ('tiktok', $1, 'x', true, 'x', 'x', 'active')`,
      [externalId],
    );
    const v = { kind: 'property', input: 'text', tier: 'category', ...bad };
    const err = await errorOf(() =>
      pool().query(
        `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, tier, fetched_at)
         values ('tiktok', $1, '100149', 'Xuất xứ', $2, $3, $4, now())`,
        [externalId, v.kind, v.input, v.tier],
      ),
    );
    expect(err).toMatchObject({ code: '23514', constraint });
  });
});

describe('bảng theo công ty: spec sản phẩm, quyền category của gian hàng', () => {
  it('công ty B không đọc, không sửa được spec của công ty A (RLS)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const productId = await seedSpec(a.companyId);
    await asCompany(a.companyId, async (c) => {
      expect((await c.query('select 1 from channel.product_specs where product_id = $1', [productId])).rows).toHaveLength(1);
    });
    await asCompany(b.companyId, async (c) => {
      expect((await c.query('select 1 from channel.product_specs where product_id = $1', [productId])).rows).toHaveLength(0);
      const upd = await c.query(`update channel.product_specs set category_status = 'removed' where product_id = $1`, [productId]);
      expect(upd.rowCount).toBe(0);
      const err = await errorOf(() =>
        c.query(
          `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source)
           values ($1, $2, 'tiktok', 'x', 'push')`,
          [a.companyId, randomUUID()],
        ),
      );
      expect(err?.code).toBe('42501');
    });
  });

  it('công ty B không đọc được quyền category của gian hàng công ty A (RLS)', async () => {
    const a = await createCompany();
    const b = await createCompany();
    const shopId = await seedShop(a.companyId);
    await pool().query(
      `insert into channel.shop_category_permissions (company_id, shop_id, external_category_id, status, checked_at)
       values ($1, $2, '601226', 'invite_only', now())`,
      [a.companyId, shopId],
    );
    await asCompany(b.companyId, async (c) => {
      expect((await c.query('select 1 from channel.shop_category_permissions where shop_id = $1', [shopId])).rows).toHaveLength(0);
    });
    await asCompany(a.companyId, async (c) => {
      expect((await c.query('select status from channel.shop_category_permissions where shop_id = $1', [shopId])).rows).toEqual([
        { status: 'invite_only' },
      ]);
    });
  });

  it('một spec mỗi (sản phẩm, sàn); bản chép từ ghép danh mục mang version 0', async () => {
    const { companyId } = await createCompany();
    const productId = await seedSpec(companyId, { version: 0 });
    const err = await errorOf(() =>
      pool().query(
        `insert into channel.product_specs (company_id, product_id, platform, external_category_id, source)
         values ($1, $2, 'lazada', 'x', 'push')`,
        [companyId, productId],
      ),
    );
    expect(err?.code).toBe('23505');
    const { rows } = await pool().query(
      'select axis_map, value_map, attributes, version from channel.product_specs where product_id = $1',
      [productId],
    );
    expect(rows).toEqual([{ axis_map: {}, value_map: {}, attributes: {}, version: 0 }]);
  });

  it.each([
    ['source', { source: 'import' }, 'product_specs_source'],
    ['category_status', { category_status: 'gone' }, 'product_specs_category_status'],
    ['version', { version: -1 }, 'product_specs_version'],
  ])('CHECK %s của spec chặn giá trị lạ', async (_label, bad, constraint) => {
    const { companyId } = await createCompany();
    const err = await errorOf(() => seedSpec(companyId, bad));
    expect(err).toMatchObject({ code: '23514', constraint });
  });

  it('CHECK status của quyền category chặn giá trị lạ; một dòng mỗi (gian hàng, category)', async () => {
    const { companyId } = await createCompany();
    const shopId = await seedShop(companyId);
    const insert = (status: string) =>
      pool().query(
        `insert into channel.shop_category_permissions (company_id, shop_id, external_category_id, status, checked_at)
         values ($1, $2, '601226', $3, now())`,
        [companyId, shopId, status],
      );
    expect(await errorOf(() => insert('AVAILABLE'))).toMatchObject({ code: '23514', constraint: 'shop_category_permissions_status' });
    await insert('available');
    expect((await errorOf(() => insert('prohibited')))?.code).toBe('23505');
  });

  it('listing có cột category thật trên sàn, null được', async () => {
    const { rows } = await pool().query<{ is_nullable: string; data_type: string }>(
      `select is_nullable, data_type from information_schema.columns
       where table_schema = 'channel' and table_name = 'listings' and column_name = 'external_category_id'`,
    );
    expect(rows).toEqual([{ is_nullable: 'YES', data_type: 'text' }]);
  });

  it('path_search có chỉ mục trigram GIN', async () => {
    const { rows } = await pool().query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'channel' and tablename = 'platform_categories'`,
    );
    expect(rows.some((r) => /using gin/i.test(r.indexdef) && /gin_trgm_ops/.test(r.indexdef))).toBe(true);
  });
});
