// Migration chép ghép danh mục cũ sang spec theo sản phẩm (#400 lát 14, AC-S7, A18): chạy đúng câu SQL của file migration
// trong một giao dịch rồi rollback (L025), trên bảng thật đã có dữ liệu (staging: 3 dòng Lazada một công ty, 3 dòng TikTok hai
// công ty). Mỗi dòng `category_maps` → một `product_specs` cho từng sản phẩm của danh mục đó trong cùng công ty: `source = 'push'`,
// `version = 0` (bản chép), attribute giữ nguyên khoá, mọi trục của biến thể `__custom`; spec có sẵn giữ nguyên.
// `size_chart_rule` sang `platform_categories`: một dòng nguồn mỗi category (`distinct on`), dòng có sẵn chỉ điền khi còn null,
// dòng mới là dòng tạm (`synced_at` null, tên và đường dẫn là mã).
import { randomInt, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const migrationSql = () => {
  const file = readdirSync(DIR).find((f) => f.endsWith('_chep-spec-tu-ghep-danh-muc.sql'));
  expect(file, 'chưa có file migration *_chep-spec-tu-ghep-danh-muc.sql').toBeDefined();
  return readFileSync(join(DIR, file!), 'utf8');
};
const num = () => String(randomInt(800_000_000, 900_000_000));

/** Chạy `fn` trong một giao dịch rồi rollback: dữ liệu chèn trong `fn` và kết quả migration không ở lại DB dùng chung. */
async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
const runMigration = (c: PoolClient) => c.query(migrationSql());

async function mapCategory(
  c: PoolClient,
  row: { companyId: string; platform: 'lazada' | 'tiktok'; categoryId: string; externalId: string; attributes?: object; rule?: string | null },
) {
  await c.query(
    `insert into channel.category_maps (company_id, platform, category_id, external_category_id, attributes, size_chart_rule) values ($1, $2, $3, $4, $5, $6)`,
    [row.companyId, row.platform, row.categoryId, row.externalId, JSON.stringify(row.attributes ?? {}), row.rule ?? null],
  );
}
/** Hai trục (Màu, Cỡ) cho biến thể, thêm biến thể thứ hai cùng sản phẩm chỉ mang trục Màu. */
async function addAxes(c: PoolClient, companyId: string, productId: string, variantId: string) {
  const tag = randomUUID().slice(0, 6);
  const attr = async (name: string) =>
    (await c.query<{ id: string }>('insert into product.attributes (company_id, name) values ($1, $2) returning id', [companyId, `${name} ${tag}`])).rows[0]!.id;
  const value = async (attributeId: string, v: string, code: string) =>
    (await c.query<{ id: string }>('insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4) returning id', [companyId, attributeId, v, code]))
      .rows[0]!.id;
  const color = await attr('Màu');
  const size = await attr('Cỡ');
  const link = (vid: string, valueId: string, position: number) =>
    c.query('insert into product.variant_attribute_values (variant_id, attribute_value_id, position, company_id) values ($1, $2, $3, $4)', [vid, valueId, position, companyId]);
  await link(variantId, await value(color, 'Đen', 'DEN'), 0);
  await link(variantId, await value(size, 'M', 'M'), 1);
  const second = (await c.query<{ id: string }>('insert into product.product_variants (company_id, product_id, sku) values ($1, $2, $3) returning id', [companyId, productId, `AX-${tag}`])).rows[0]!.id;
  await link(second, await value(color, 'Trắng', 'TRANG'), 0);
  return { color, size };
}
const specsOf = (c: PoolClient, productId: string) =>
  c.query('select company_id, platform, external_category_id, attributes, axis_map, value_map, source, category_status, version from channel.product_specs where product_id = $1 order by platform', [productId]).then((r) => r.rows);
const categoryRow = (c: PoolClient, platform: string, externalId: string) =>
  c.query('select name, is_leaf, path, path_search, status, synced_at, size_chart_rule from channel.platform_categories where platform = $1 and external_id = $2', [platform, externalId]).then((r) => r.rows[0]);

let a: Awaited<ReturnType<typeof createCompany>>;
let b: Awaited<ReturnType<typeof createCompany>>;
beforeAll(async () => {
  [a, b] = await Promise.all([createCompany({ optionalModules: ['channel'] }), createCompany({ optionalModules: ['channel'] })]);
});

describe('migration chép ghép danh mục sang spec (#400 AC-S7)', () => {
  it('sản phẩm có trục: spec version 0, source push, attribute giữ khoá, mọi trục __custom; Lazada và TikTok mỗi sàn một spec; chạy hai lần như một', async () => {
    const v = await createVariant(a.companyId);
    const lz = num();
    const tt = num();
    await inRollback(async (c) => {
      const { color, size } = await addAxes(c, a.companyId, v.productId, v.variantId);
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: v.categoryId, externalId: lz, attributes: { brand: 'No Brand' } });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: v.categoryId, externalId: tt, attributes: { '100149': 'Việt Nam' } });
      await runMigration(c);
      const first = await specsOf(c, v.productId);
      expect(first).toEqual([
        {
          company_id: a.companyId,
          platform: 'lazada',
          external_category_id: lz,
          attributes: { brand: 'No Brand' },
          axis_map: { [color]: '__custom', [size]: '__custom' },
          value_map: {},
          source: 'push',
          category_status: 'ok',
          version: 0,
        },
        expect.objectContaining({ platform: 'tiktok', external_category_id: tt, attributes: { '100149': 'Việt Nam' }, axis_map: { [color]: '__custom', [size]: '__custom' }, version: 0 }),
      ]);
      await runMigration(c);
      expect(await specsOf(c, v.productId)).toEqual(first);
    });
  });

  it('sản phẩm không trục: axis_map rỗng; spec có sẵn giữ nguyên; sản phẩm công ty khác cùng mã danh mục không bị chép', async () => {
    const plain = await createVariant(a.companyId);
    const owned = await createVariant(a.companyId);
    const other = await createVariant(b.companyId);
    await inRollback(async (c) => {
      const ext = num();
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: plain.categoryId, externalId: ext });
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: owned.categoryId, externalId: ext });
      // Dòng ghép trỏ danh mục của công ty khác (không xảy ra qua route, chặn để câu chép luôn theo công ty).
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: other.categoryId, externalId: ext });
      await c.query(
        `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, source, version) values ($1, $2, 'lazada', 'NGUOI-DUNG', '{"a":"b"}', 'push', 3)`,
        [a.companyId, owned.productId],
      );
      await runMigration(c);
      expect(await specsOf(c, plain.productId)).toEqual([expect.objectContaining({ external_category_id: ext, axis_map: {}, attributes: {}, version: 0 })]);
      expect(await specsOf(c, owned.productId)).toEqual([expect.objectContaining({ external_category_id: 'NGUOI-DUNG', attributes: { a: 'b' }, version: 3 })]);
      expect(await specsOf(c, other.productId)).toEqual([]);
    });
  });

  it('category đã có dòng đồng bộ: chỉ điền size_chart_rule khi còn null, không đổi tên, đường dẫn, trạng thái, synced_at; quy tắc có sẵn giữ', async () => {
    const v = await createVariant(a.companyId);
    const w = await createVariant(a.companyId);
    const synced = num();
    const ruled = num();
    await inRollback(async (c) => {
      await c.query(
        `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status, synced_at, size_chart_rule)
         values ('tiktok', $1, 'Áo thun', true, 'Thời trang > Áo thun', 'thoi trang > ao thun', 'removed', '2026-11-01T00:00:00Z', null),
                ('tiktok', $2, 'Quần', true, 'Thời trang > Quần', 'thoi trang > quan', 'active', '2026-11-01T00:00:00Z', 'optional')`,
        [synced, ruled],
      );
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: v.categoryId, externalId: synced, rule: 'required' });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: w.categoryId, externalId: ruled, rule: 'required' });
      await runMigration(c);
      expect(await categoryRow(c, 'tiktok', synced)).toEqual({
        name: 'Áo thun',
        is_leaf: true,
        path: 'Thời trang > Áo thun',
        path_search: 'thoi trang > ao thun',
        status: 'removed',
        synced_at: new Date('2026-11-01T00:00:00Z'),
        size_chart_rule: 'required',
      });
      expect((await categoryRow(c, 'tiktok', ruled)).size_chart_rule).toBe('optional');
    });
  });

  it('hai công ty cùng category sàn, một có quy tắc một chưa: một dòng tạm có quy tắc; ghép chưa có quy tắc không tạo dòng', async () => {
    const va = await createVariant(a.companyId);
    const vb = await createVariant(b.companyId);
    const vc = await createVariant(b.companyId);
    const shared = num();
    const bare = num();
    await inRollback(async (c) => {
      await mapCategory(c, { companyId: b.companyId, platform: 'tiktok', categoryId: vb.categoryId, externalId: shared, rule: null });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: va.categoryId, externalId: shared, rule: 'required' });
      await mapCategory(c, { companyId: b.companyId, platform: 'tiktok', categoryId: vc.categoryId, externalId: bare, rule: null });
      await runMigration(c);
      await runMigration(c);
      expect(await categoryRow(c, 'tiktok', shared)).toEqual({
        name: shared,
        is_leaf: true,
        path: shared,
        path_search: shared,
        status: 'active',
        synced_at: null,
        size_chart_rule: 'required',
      });
      expect(await categoryRow(c, 'tiktok', bare)).toBeUndefined();
      expect(await specsOf(c, va.productId)).toHaveLength(1);
      expect(await specsOf(c, vb.productId)).toEqual([expect.objectContaining({ company_id: b.companyId, external_category_id: shared })]);
    });
  });
});
