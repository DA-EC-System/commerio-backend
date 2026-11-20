// Migration BE3 gỡ ghép danh mục cũ (#400 lát 16, AC-S7, A18): câu chép chạy lại lần cuối (`*_chep-spec-lan-cuoi`) rồi mới xoá
// `channel.category_maps`, `product.product_channel_specs` (`*_bo-ghep-danh-muc`, sinh từ `schema.ts`).
// DB test đã chạy mọi migration nên bảng cũ không còn: ca chép dựng lại `category_maps` đúng dạng trước BE3 trong một giao dịch,
// chạy SQL của file chép rồi rollback (L025). Dữ liệu cùng dạng staging (3 dòng Lazada một công ty, 3 dòng TikTok hai công ty)
// cộng các trạng thái khe BE2–BE3 tạo ra được: bản chép `version = 0` mà ghép đã sửa sau đó (route cũ), sản phẩm tạo sau BE2
// chưa có spec, spec người dùng lưu (`version ≥ 1`), bản chép bị đồng bộ đánh `changed`.
import { randomInt, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const fileOf = (slug: string) => {
  const file = readdirSync(DIR).find((f) => f.endsWith(`_${slug}.sql`));
  expect(file, `chưa có file migration *_${slug}.sql`).toBeDefined();
  return file!;
};
const COPY = 'chep-spec-lan-cuoi';
const DROP = 'bo-ghep-danh-muc';
const num = () => String(randomInt(800_000_000, 900_000_000));

/** Chạy `fn` trong một giao dịch rồi rollback: bảng dựng lại, dữ liệu, kết quả migration không ở lại DB dùng chung. */
async function inRollback<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    // Dạng bảng trước BE3: 0005_listing-lazada.sql + 20261117011933_bang-kich-co.sql.
    await client.query(`
      create table if not exists channel.category_maps (
        id uuid primary key default gen_random_uuid() not null,
        company_id uuid not null,
        platform channel.marketplace not null,
        category_id uuid not null,
        external_category_id text not null,
        attributes jsonb default '{}'::jsonb not null,
        created_at timestamptz default now() not null,
        updated_at timestamptz default now() not null,
        version integer default 1 not null,
        size_chart_rule text,
        unique (company_id, platform, category_id)
      )`);
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}
const runCopy = (c: PoolClient) => c.query(readFileSync(join(DIR, fileOf(COPY)), 'utf8'));

async function mapCategory(
  c: PoolClient,
  row: { companyId: string; platform: 'lazada' | 'tiktok'; categoryId: string; externalId: string; attributes?: object; rule?: string | null },
) {
  await c.query(
    `insert into channel.category_maps (company_id, platform, category_id, external_category_id, attributes, size_chart_rule) values ($1, $2, $3, $4, $5, $6)`,
    [row.companyId, row.platform, row.categoryId, row.externalId, JSON.stringify(row.attributes ?? {}), row.rule ?? null],
  );
}
async function seedSpec(
  c: PoolClient,
  row: { companyId: string; productId: string; platform: 'lazada' | 'tiktok'; externalId: string; attributes?: object; axisMap?: object; version: number; status?: string },
) {
  await c.query(
    `insert into channel.product_specs (company_id, product_id, platform, external_category_id, attributes, axis_map, source, category_status, version)
     values ($1, $2, $3, $4, $5, $6, 'push', $7, $8)`,
    [row.companyId, row.productId, row.platform, row.externalId, JSON.stringify(row.attributes ?? {}), JSON.stringify(row.axisMap ?? {}), row.status ?? 'ok', row.version],
  );
}
/** Một trục Màu cho biến thể (sản phẩm có phân loại). */
async function addAxis(c: PoolClient, companyId: string, variantId: string) {
  const tag = randomUUID().slice(0, 6);
  const attr = (await c.query<{ id: string }>('insert into product.attributes (company_id, name) values ($1, $2) returning id', [companyId, `Màu ${tag}`])).rows[0]!.id;
  const value = (await c.query<{ id: string }>('insert into product.attribute_values (company_id, attribute_id, value, code) values ($1, $2, $3, $4) returning id', [companyId, attr, 'Đen', 'DEN'])).rows[0]!.id;
  await c.query('insert into product.variant_attribute_values (variant_id, attribute_value_id, position, company_id) values ($1, $2, 0, $3)', [variantId, value, companyId]);
  return attr;
}
const specOf = (c: PoolClient, productId: string, platform: string) =>
  c
    .query('select company_id, external_category_id, attributes, axis_map, source, category_status, version from channel.product_specs where product_id = $1 and platform = $2', [productId, platform])
    .then((r) => r.rows[0]);
const ruleOf = (c: PoolClient, platform: string, externalId: string) =>
  c.query('select size_chart_rule, synced_at from channel.platform_categories where platform = $1 and external_id = $2', [platform, externalId]).then((r) => r.rows[0]);

let a: Awaited<ReturnType<typeof createCompany>>;
let b: Awaited<ReturnType<typeof createCompany>>;
beforeAll(async () => {
  [a, b] = await Promise.all([createCompany({ optionalModules: [] }), createCompany({ optionalModules: [] })]);
});

describe('migration BE3: chép lần cuối rồi xoá ghép danh mục (#400 AC-S7)', () => {
  it('dữ liệu dạng staging: chèn spec còn thiếu, cập nhật bản chép version 0 theo ghép hiện tại, không đụng spec đã lưu; chạy hai lần như một', async () => {
    // Lazada, công ty A, 3 danh mục: (1) bản chép cũ, ghép sửa trong khe; (2) sản phẩm tạo sau BE2, chưa spec, có trục;
    // (3) spec người dùng đã lưu qua route mới.
    const [l1, l2, l3] = await Promise.all([createVariant(a.companyId), createVariant(a.companyId), createVariant(a.companyId)]);
    // TikTok, hai công ty: A (4) bản chép bị đồng bộ đánh `changed`, ghép không đổi; A (5) bản chép đúng; B (6) cùng category
    // sàn với (5), chưa spec, có quy tắc bảng kích cỡ.
    const [t4, t5, t6] = await Promise.all([createVariant(a.companyId), createVariant(a.companyId), createVariant(b.companyId)]);
    const [lz1, lz1New, lz2, lz3, tt4, tt5] = [num(), num(), num(), num(), num(), num()];
    await inRollback(async (c) => {
      const axis = await addAxis(c, a.companyId, l2.variantId);
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: l1.categoryId, externalId: lz1New, attributes: { brand: 'Acme', material: 'Cotton' } });
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: l2.categoryId, externalId: lz2, attributes: { brand: 'No Brand' } });
      await mapCategory(c, { companyId: a.companyId, platform: 'lazada', categoryId: l3.categoryId, externalId: lz3, attributes: { brand: 'Cũ' } });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: t4.categoryId, externalId: tt4, attributes: { '100149': 'Việt Nam' } });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: t5.categoryId, externalId: tt5, attributes: { '100149': 'Việt Nam' }, rule: null });
      await mapCategory(c, { companyId: b.companyId, platform: 'tiktok', categoryId: t6.categoryId, externalId: tt5, attributes: { '100149': 'Hàn Quốc' }, rule: 'required' });
      await seedSpec(c, { companyId: a.companyId, productId: l1.productId, platform: 'lazada', externalId: lz1, attributes: { brand: 'Acme' }, version: 0 });
      await seedSpec(c, { companyId: a.companyId, productId: l3.productId, platform: 'lazada', externalId: 'NGUOI-DUNG', attributes: { brand: 'Mới' }, version: 2 });
      await seedSpec(c, { companyId: a.companyId, productId: t4.productId, platform: 'tiktok', externalId: tt4, attributes: { '100149': 'Việt Nam' }, version: 0, status: 'changed' });
      await seedSpec(c, { companyId: a.companyId, productId: t5.productId, platform: 'tiktok', externalId: tt5, attributes: { '100149': 'Việt Nam' }, version: 0 });

      await runCopy(c);
      const after = {
        l1: await specOf(c, l1.productId, 'lazada'),
        l2: await specOf(c, l2.productId, 'lazada'),
        l3: await specOf(c, l3.productId, 'lazada'),
        t4: await specOf(c, t4.productId, 'tiktok'),
        t5: await specOf(c, t5.productId, 'tiktok'),
        t6: await specOf(c, t6.productId, 'tiktok'),
      };
      expect(after.l1).toEqual({
        company_id: a.companyId,
        external_category_id: lz1New,
        attributes: { brand: 'Acme', material: 'Cotton' },
        axis_map: {},
        source: 'push',
        category_status: 'ok',
        version: 0,
      });
      expect(after.l2).toEqual(expect.objectContaining({ external_category_id: lz2, attributes: { brand: 'No Brand' }, axis_map: { [axis]: '__custom' }, version: 0 }));
      expect(after.l3).toEqual(expect.objectContaining({ external_category_id: 'NGUOI-DUNG', attributes: { brand: 'Mới' }, version: 2 }));
      // Ghép không đổi thì không đặt lại trạng thái đồng bộ đã ghi.
      expect(after.t4).toEqual(expect.objectContaining({ external_category_id: tt4, category_status: 'changed', version: 0 }));
      expect(after.t5).toEqual(expect.objectContaining({ external_category_id: tt5, attributes: { '100149': 'Việt Nam' }, version: 0 }));
      expect(after.t6).toEqual(expect.objectContaining({ company_id: b.companyId, external_category_id: tt5, attributes: { '100149': 'Hàn Quốc' }, version: 0 }));
      expect(await ruleOf(c, 'tiktok', tt5)).toEqual({ size_chart_rule: 'required', synced_at: null });
      expect(await ruleOf(c, 'lazada', lz2)).toBeUndefined();

      await runCopy(c);
      for (const [key, v, platform] of [
        ['l1', l1, 'lazada'],
        ['l2', l2, 'lazada'],
        ['l3', l3, 'lazada'],
        ['t4', t4, 'tiktok'],
        ['t5', t5, 'tiktok'],
        ['t6', t6, 'tiktok'],
      ] as const) {
        expect(await specOf(c, v.productId, platform)).toEqual(after[key]);
      }
    });
  });

  it('category đã đồng bộ có quy tắc: giữ quy tắc có sẵn; chưa có quy tắc thì lấy của ghép', async () => {
    const [v, w] = await Promise.all([createVariant(a.companyId), createVariant(a.companyId)]);
    const [bare, ruled] = [num(), num()];
    await inRollback(async (c) => {
      await c.query(
        `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, status, synced_at, size_chart_rule)
         values ('tiktok', $1, 'Áo', true, 'Áo', 'ao', 'active', '2026-11-01T00:00:00Z', null),
                ('tiktok', $2, 'Quần', true, 'Quần', 'quan', 'active', '2026-11-01T00:00:00Z', 'optional')`,
        [bare, ruled],
      );
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: v.categoryId, externalId: bare, rule: 'required' });
      await mapCategory(c, { companyId: a.companyId, platform: 'tiktok', categoryId: w.categoryId, externalId: ruled, rule: 'required' });
      await runCopy(c);
      expect(await ruleOf(c, 'tiktok', bare)).toEqual({ size_chart_rule: 'required', synced_at: new Date('2026-11-01T00:00:00Z') });
      expect((await ruleOf(c, 'tiktok', ruled)).size_chart_rule).toBe('optional');
    });
  });

  it('câu chép đứng trước câu xoá trong journal; sau mọi migration hai bảng cũ không còn', async () => {
    const copy = fileOf(COPY).replace(/\.sql$/, '');
    const drop = fileOf(DROP).replace(/\.sql$/, '');
    const journal = JSON.parse(readFileSync(join(DIR, 'meta', '_journal.json'), 'utf8')) as { entries: { idx: number; tag: string }[] };
    const idx = (tag: string) => journal.entries.find((e) => e.tag === tag)?.idx ?? -1;
    expect(idx(copy)).toBeGreaterThanOrEqual(0);
    expect(idx(drop)).toBe(idx(copy) + 1);
    const dropSql = readFileSync(join(DIR, `${drop}.sql`), 'utf8');
    expect(dropSql).toMatch(/DROP TABLE "channel"\."category_maps"/);
    expect(dropSql).toMatch(/DROP TABLE "product"\."product_channel_specs"/);
    expect(readFileSync(join(DIR, `${copy}.sql`), 'utf8')).not.toMatch(/DROP TABLE/i);
    const { rows } = await testPool().query<{ maps: string | null; specs: string | null }>(
      `select to_regclass('channel.category_maps')::text as maps, to_regclass('product.product_channel_specs')::text as specs`,
    );
    expect(rows[0]).toEqual({ maps: null, specs: null });
  });
});
