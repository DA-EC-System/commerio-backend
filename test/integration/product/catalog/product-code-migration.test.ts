// Hai migration của #204 PR 3 (D11, D5, D4, bỏ `products.archived_at`) trên dữ liệu kiểu cũ: chạy đúng SQL của hai file
// lên một schema tạm cùng hình dạng bảng trước PR 3 (cha còn `archived_at`, chưa có `code`), rồi rollback.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

// Tìm theo slug, không theo tên đủ: `db:regen` sinh lại tên theo giờ (có thể gộp hai file thành một tên ghép slug).
const DIR = join(process.cwd(), 'db', 'migrations');
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql') && (f.includes('ma-cha-san-pham') || f.includes('bo-luu-tru-san-pham-cha')))
  .sort()
  .map((f) => join(DIR, f));
const ARCHIVED_AT = '2026-11-01T02:03:04.567Z';

interface Variant {
  sku: string;
  /** Mã giá trị thuộc tính theo `position`. */
  codes?: string[];
  status?: 'selling' | 'paused' | 'discontinued' | 'archived';
  archivedAt?: string;
  /** Có dòng tồn với tồn thực khác 0. */
  onHand?: number;
}

interface Product {
  key: string;
  name: string;
  archived?: boolean;
  variants: Variant[];
}

/** Dựng bảng kiểu cũ trong schema tạm, chạy hai migration, trả sản phẩm và SKU sau khi chạy (đã rollback). */
async function migrate(products: Product[], companyId = randomUUID()) {
  const schema = `mig204_${randomUUID().replaceAll('-', '')}`;
  const s = `"${schema}"`;
  const client: PoolClient = await testPool().connect();
  try {
    await client.query('begin');
    await client.query(`
      create schema ${s};
      create table ${s}.products (
        id uuid primary key, company_id uuid not null, name text not null, archived_at timestamptz,
        version integer not null default 1, created_at timestamptz not null, updated_at timestamptz not null default now()
      );
      create unique index products_company_lower_name_uq on ${s}.products (company_id, lower(name)) where archived_at is null;
      create table ${s}.product_variants (
        id uuid primary key, product_id uuid not null, sku text not null,
        business_status "product"."business_status" not null default 'selling', archived_at timestamptz,
        version integer not null default 1, created_at timestamptz not null, updated_at timestamptz not null default now()
      );
      create table ${s}.attribute_values (id uuid primary key, code text not null);
      create table ${s}.variant_attribute_values (variant_id uuid not null, attribute_value_id uuid not null, position integer not null);
      create table ${s}.stock_levels (
        variant_id uuid primary key, on_hand integer not null default 0, reserved integer not null default 0,
        quarantine integer not null default 0
      );`);
    const ids = new Map<string, string>();
    const skuIds = new Map<string, string>();
    for (const [i, p] of products.entries()) {
      const id = randomUUID();
      ids.set(p.key, id);
      const created = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      await client.query(`insert into ${s}.products (id, company_id, name, archived_at, created_at) values ($1, $2, $3, $4, $5)`, [
        id,
        companyId,
        p.name,
        p.archived ? ARCHIVED_AT : null,
        created,
      ]);
      for (const [j, v] of p.variants.entries()) {
        const vid = randomUUID();
        skuIds.set(v.sku, vid);
        await client.query(
          `insert into ${s}.product_variants (id, product_id, sku, business_status, archived_at, created_at) values ($1, $2, $3, $4, $5, $6)`,
          [vid, id, v.sku, v.status ?? 'selling', v.archivedAt ?? null, new Date(Date.UTC(2026, 0, 1, 0, 0, i, j)).toISOString()],
        );
        for (const [k, code] of (v.codes ?? []).entries()) {
          const avid = randomUUID();
          await client.query(`insert into ${s}.attribute_values (id, code) values ($1, $2)`, [avid, code]);
          await client.query(`insert into ${s}.variant_attribute_values values ($1, $2, $3)`, [vid, avid, k]);
        }
        if (v.onHand !== undefined) await client.query(`insert into ${s}.stock_levels (variant_id, on_hand) values ($1, $2)`, [vid, v.onHand]);
      }
    }
    for (const file of FILES) {
      const sql = readFileSync(file, 'utf8')
        .replaceAll('"product"."business_status"', '@@status@@')
        .replaceAll('"product".', `${s}.`)
        .replaceAll('@@status@@', '"product"."business_status"');
      expect(sql.replaceAll('"product"."business_status"', '')).not.toContain('"product"');
      await client.query(sql);
    }
    const { rows: productRows } = await client.query<{ id: string; name: string; code: string; version: number }>(
      `select id, name, code, version from ${s}.products`,
    );
    const { rows: variantRows } = await client.query<{ id: string; business_status: string; archived_at: Date | null }>(
      `select id, business_status, archived_at from ${s}.product_variants`,
    );
    const { rows: columns } = await client.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns where table_schema = $1 and table_name = 'products'`,
      [schema],
    );
    const { rows: indexes } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = $1 and tablename = 'products'`,
      [schema],
    );
    await client.query('rollback');
    const byProduct = new Map(productRows.map((r) => [r.id, r]));
    const byVariant = new Map(variantRows.map((r) => [r.id, r]));
    return {
      product: (key: string) => byProduct.get(ids.get(key)!)!,
      variant: (sku: string) => byVariant.get(skuIds.get(sku)!)!,
      columns,
      indexes,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

describe('migration mã cha, bỏ lưu trữ sản phẩm cha (#204 PR 3)', () => {
  it('tìm thấy migration của PR 3 (sinh lại bằng db:regen thì slug giữ nguyên)', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES.map((f) => readFileSync(f, 'utf8')).join('\n')).toContain('DROP COLUMN "archived_at"');
  });

  describe('mã cha của sản phẩm đã có (D5)', () => {
    it('chỉ cắt mã giá trị ở cuối SKU kèm dấu nối, kể cả mã 1 ký tự hay mã số trùng chuỗi khác trong SKU', async () => {
      const r = await migrate([
        { key: 'dam', name: 'Đầm', variants: [{ sku: 'DAM-0001-M', codes: ['M'] }] },
        { key: 'somi', name: 'Sơ mi', variants: [{ sku: 'SOMI-0003-S', codes: ['S'] }] },
        { key: 'giay', name: 'Giày', variants: [{ sku: 'GIAY-0040-40', codes: ['40'] }] },
        { key: 'pk', name: 'Phụ kiện', variants: [{ sku: 'PK-0001-1', codes: ['1'] }] },
        { key: 'dongho', name: 'Đồng hồ', variants: [{ sku: 'DONGHO-0002-DO', codes: ['DO'] }] },
        { key: 'gach', name: 'Gạch dưới', variants: [{ sku: 'TUI-0005_DEN', codes: ['DEN'] }] },
      ]);
      expect(['dam', 'somi', 'giay', 'pk', 'dongho', 'gach'].map((k) => r.product(k).code)).toEqual([
        'DAM-0001',
        'SOMI-0003',
        'GIAY-0040',
        'PK-0001',
        'DONGHO-0002',
        'TUI-0005',
      ]);
    });

    it('hai trục: cắt cả phần "<giá trị 1>-<giá trị 2>" theo position; biến thể tạo sớm nhất quyết định', async () => {
      const r = await migrate([
        {
          key: 'ao',
          name: 'Áo',
          variants: [
            { sku: 'AO-0001-DEN-M', codes: ['DEN', 'M'] },
            { sku: 'AO-0002-TRANG-L', codes: ['TRANG', 'L'] },
          ],
        },
      ]);
      expect(r.product('ao').code).toBe('AO-0001');
    });

    it('SKU không kết thúc bằng mã giá trị ({VAL} đứng trước, mã giá trị đã đổi) hoặc không có thuộc tính: lấy nguyên SKU', async () => {
      const r = await migrate([
        { key: 'truoc', name: 'Mũ', variants: [{ sku: 'M-0007', codes: ['M'] }] },
        { key: 'doi', name: 'Khăn', variants: [{ sku: 'KHAN-0008-XANH', codes: ['XANHNA'] }] },
        { key: 'khong', name: 'Ví', variants: [{ sku: 'VI-0009' }] },
      ]);
      expect([r.product('truoc').code, r.product('doi').code, r.product('khong').code]).toEqual(['M-0007', 'KHAN-0008-XANH', 'VI-0009']);
    });

    it('mã trùng trong công ty thì thêm -2, -3 theo thứ tự tạo; sản phẩm không có biến thể lấy SP-<8 ký tự đầu id>', async () => {
      const r = await migrate([
        { key: 'a', name: 'A', variants: [{ sku: 'X-0001-DO', codes: ['DO'] }] },
        { key: 'b', name: 'B', variants: [{ sku: 'X-0001-XANH', codes: ['XANH'] }] },
        { key: 'c', name: 'C', variants: [{ sku: 'X-0001' }] },
        { key: 'rong', name: 'Rỗng', variants: [] },
      ]);
      expect([r.product('a').code, r.product('b').code, r.product('c').code]).toEqual(['X-0001', 'X-0001-2', 'X-0001-3']);
      expect(r.product('rong').code).toMatch(/^SP-[0-9A-F]{8}$/);
    });
  });

  it('SKU của cha lưu trữ (D11): còn tồn thì Ngừng nhập, hết tồn thì lưu trữ theo giờ của cha; SKU đã lưu trữ giữ nguyên', async () => {
    const r = await migrate([
      {
        key: 'cu',
        name: 'Cũ',
        archived: true,
        variants: [
          { sku: 'CU-0001-DO', codes: ['DO'], onHand: 3 },
          { sku: 'CU-0002-XANH', codes: ['XANH'], onHand: 0 },
          { sku: 'CU-0003-VANG', codes: ['VANG'], status: 'archived', archivedAt: '2026-10-01T00:00:00.000Z' },
        ],
      },
      { key: 'moi', name: 'Mới', variants: [{ sku: 'MOI-0001', onHand: 0 }] },
    ]);
    expect(r.variant('CU-0001-DO')).toMatchObject({ business_status: 'discontinued', archived_at: null });
    expect(r.variant('CU-0002-XANH').business_status).toBe('archived');
    expect(r.variant('CU-0002-XANH').archived_at!.toISOString()).toBe(ARCHIVED_AT);
    expect(r.variant('CU-0003-VANG').archived_at!.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(r.variant('MOI-0001')).toMatchObject({ business_status: 'selling', archived_at: null });
  });

  it('tên trùng (D4): sản phẩm lưu trữ trùng tên (chữ thường) thêm " (<mã cha>)", sản phẩm đang bán giữ tên', async () => {
    const r = await migrate([
      { key: 'ban', name: 'Cốc sứ', variants: [{ sku: 'COC-0001' }] },
      { key: 'luu1', name: 'cốc sứ', archived: true, variants: [{ sku: 'COC-0002' }] },
      // Hai sản phẩm lưu trữ trùng tên nhau (không có sản phẩm đang bán): cả hai thêm hậu tố. Chữ ASCII để `lower()` không
      // phụ thuộc collation của DB test.
      { key: 'luu2', name: 'Binh nuoc', archived: true, variants: [{ sku: 'BINH-0001' }] },
      { key: 'luu3', name: 'BINH NUOC', archived: true, variants: [{ sku: 'BINH-0002' }] },
      { key: 'rieng', name: 'Đĩa', archived: true, variants: [{ sku: 'DIA-0001' }] },
    ]);
    expect(r.product('ban')).toMatchObject({ name: 'Cốc sứ', version: 1 });
    expect(r.product('luu1')).toMatchObject({ name: 'cốc sứ (COC-0002)', version: 2 });
    expect(r.product('luu2').name).toBe('Binh nuoc (BINH-0001)');
    expect(r.product('luu3').name).toBe('BINH NUOC (BINH-0002)');
    expect(r.product('rieng')).toMatchObject({ name: 'Đĩa', version: 1 });
  });

  it('sau hai migration: code NOT NULL, không còn archived_at, unique (công ty, code) và (công ty, lower(name)) không điều kiện', async () => {
    const r = await migrate([{ key: 'p', name: 'P', variants: [{ sku: 'P-0001' }] }]);
    expect(r.columns.find((c) => c.column_name === 'code')?.is_nullable).toBe('NO');
    expect(r.columns.some((c) => c.column_name === 'archived_at')).toBe(false);
    const defs = Object.fromEntries(r.indexes.map((i) => [i.indexname, i.indexdef]));
    expect(defs.products_company_code_uq).toMatch(/UNIQUE INDEX .* \(company_id, code\)$/);
    expect(defs.products_company_lower_name_uq).toMatch(/UNIQUE INDEX .* \(company_id, lower\(name\)\)$/);
  });
});
