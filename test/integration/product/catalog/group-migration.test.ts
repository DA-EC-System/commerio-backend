// Hai migration dữ liệu của Nhóm hàng (#447): `*_nhom-hang-cat-ten` (cắt tên thuộc tính > 15, giá trị > 20 trước khi thêm
// CHECK) và `*_nhom-hang-du-lieu` (cài đặt sản phẩm, thuộc tính chuẩn sàn, 12 nhóm cho công ty đã có; plan A2). Chạy đúng
// SQL của file lên một schema tạm cùng hình dạng bảng, rồi rollback, để không đụng dữ liệu của file test khác.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

// Tìm theo slug: `db:regen` sinh lại tên theo giờ.
const DIR = join(process.cwd(), 'db', 'migrations');
const fileOf = (slug: string) => readdirSync(DIR).find((f) => f.endsWith(`_${slug}.sql`));
const TRUNCATE = fileOf('nhom-hang-cat-ten');
const DATA = fileOf('nhom-hang-du-lieu');

const GROUPS = [
  'Thời trang nam',
  'Thời trang nữ',
  'Giày dép',
  'Túi ví',
  'Phụ kiện',
  'Mỹ phẩm & làm đẹp',
  'Nhà cửa & đời sống',
  'Điện tử',
  'Thực phẩm',
  'Mẹ & bé',
  'Thể thao',
  'Khác',
];
const COLORS = [
  ['Đen', 'DEN'],
  ['Trắng', 'TRANG'],
  ['Đỏ', 'DO'],
  ['Xanh dương', 'XANHDU'],
  ['Vàng', 'VANG'],
  ['Hồng', 'HONG'],
  ['Xám', 'XAM'],
  ['Be', 'BE'],
];
const SIZES = ['S', 'M', 'L', 'XL', 'XXL'].map((s) => [s, s]);

interface Seed {
  companies: string[];
  /** `[công ty, tên]` theo thứ tự tạo. */
  attributes?: [string, string, ('color' | 'size')?][];
  /** `[công ty, tên thuộc tính, giá trị]` theo thứ tự tạo. */
  values?: [string, string, string][];
  groups?: [string, string][];
  variants?: [string, number][];
  settings?: [string, number][];
}

async function run(seed: Seed, files: string[], runs = 1) {
  const schema = `mig447_${randomUUID().replaceAll('-', '')}`;
  const s = `"${schema}"`;
  const client: PoolClient = await testPool().connect();
  try {
    await client.query('begin');
    await client.query(`
      create schema ${s};
      create table ${s}.companies (id uuid primary key);
      create table ${s}.product_variants (id uuid primary key default gen_random_uuid(), company_id uuid not null);
      create table ${s}.attributes (
        id uuid primary key default gen_random_uuid(), company_id uuid not null, name text not null, platform_kind text,
        version integer not null default 1, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create unique index on ${s}.attributes (company_id, lower(name));
      create unique index on ${s}.attributes (company_id, platform_kind) where platform_kind is not null;
      create table ${s}.attribute_values (
        id uuid primary key default gen_random_uuid(), company_id uuid not null, attribute_id uuid not null, value text not null,
        code text not null, version integer not null default 1, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create unique index on ${s}.attribute_values (attribute_id, lower(value));
      create table ${s}.product_groups (
        id uuid primary key default gen_random_uuid(), company_id uuid not null, name text not null,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now()
      );
      create unique index on ${s}.product_groups (company_id, lower(name));
      create table ${s}.company_product_settings (company_id uuid primary key, sku_next_seq integer not null default 1);`);
    const ids = new Map(seed.companies.map((c) => [c, randomUUID()]));
    const attrIds = new Map<string, string>();
    for (const c of seed.companies) await client.query(`insert into ${s}.companies values ($1)`, [ids.get(c)]);
    let tick = 0;
    for (const [c, name, kind] of seed.attributes ?? []) {
      const { rows } = await client.query<{ id: string }>(
        `insert into ${s}.attributes (company_id, name, platform_kind, created_at) values ($1, $2, $3, now() - make_interval(mins => 100 - $4::int)) returning id`,
        [ids.get(c), name, kind ?? null, tick++],
      );
      attrIds.set(`${c}/${name}`, rows[0]!.id);
    }
    for (const [c, attr, value] of seed.values ?? []) {
      await client.query(
        `insert into ${s}.attribute_values (company_id, attribute_id, value, code, created_at) values ($1, $2, $3, 'X', now() - make_interval(mins => 100 - $4::int))`,
        [ids.get(c), attrIds.get(`${c}/${attr}`), value, tick++],
      );
    }
    for (const [c, name] of seed.groups ?? []) await client.query(`insert into ${s}.product_groups (company_id, name) values ($1, $2)`, [ids.get(c), name]);
    for (const [c, n] of seed.variants ?? []) {
      await client.query(`insert into ${s}.product_variants (company_id) select $1 from generate_series(1, $2)`, [ids.get(c), n]);
    }
    for (const [c, n] of seed.settings ?? []) await client.query(`insert into ${s}.company_product_settings values ($1, $2)`, [ids.get(c), n]);

    for (const f of files) {
      const sql = readFileSync(join(DIR, f), 'utf8').replaceAll('"product".', `${s}.`).replaceAll('"core".', `${s}.`);
      expect(sql).not.toMatch(/"product"|"core"/);
      for (let i = 0; i < runs; i++) await client.query(sql);
    }

    const attrs = await client.query<{ id: string; company_id: string; name: string; platform_kind: string | null; version: number }>(
      `select id, company_id, name, platform_kind, version from ${s}.attributes order by created_at, id`,
    );
    const values = await client.query<{ attribute_id: string; value: string; code: string; version: number }>(
      `select attribute_id, value, code, version from ${s}.attribute_values order by created_at, id`,
    );
    const groups = await client.query<{ company_id: string; name: string }>(`select company_id, name from ${s}.product_groups order by created_at, name`);
    const settings = await client.query<{ company_id: string; sku_next_seq: number }>(`select * from ${s}.company_product_settings`);
    await client.query('rollback');

    return Object.fromEntries(
      seed.companies.map((c) => {
        const id = ids.get(c)!;
        return [
          c,
          {
            attributes: attrs.rows
              .filter((a) => a.company_id === id)
              .map((a) => ({
                name: a.name,
                kind: a.platform_kind,
                version: a.version,
                values: values.rows.filter((v) => v.attribute_id === a.id).map((v) => [v.value, v.code, v.version]),
              })),
            groups: groups.rows.filter((g) => g.company_id === id).map((g) => g.name),
            nextSeq: settings.rows.find((r) => r.company_id === id)?.sku_next_seq ?? null,
          },
        ];
      }),
    ) as Record<string, { attributes: { name: string; kind: string | null; version: number; values: unknown[][] }[]; groups: string[]; nextSeq: number | null }>;
  } finally {
    client.release();
  }
}

describe('migration cắt tên thuộc tính, giá trị trước CHECK (#447)', () => {
  it('có file', () => {
    expect(TRUNCATE).toBeDefined();
  });

  const seed: Seed = {
    companies: ['a', 'b'],
    attributes: [
      ['a', 'Material Composition A'],
      ['a', 'Material Composition B'],
      ['a', 'Kich co ao nam  rat dai'],
      ['a', 'Màu sắc'],
      ['b', 'Material Composition A'],
      ['b', 'Material Compos'],
      ['b', 'Material Composition'],
    ],
    values: [
      ['a', 'Màu sắc', 'Navy blue with white'],
      ['a', 'Màu sắc', 'Navy blue with white stripes'],
      ['a', 'Màu sắc', 'Đen'],
    ],
  };

  it('cắt còn 15/20 ký tự (bỏ khoảng trắng cuối), trùng trong công ty thì thêm hậu tố số, tăng version dòng bị đổi', async () => {
    const out = await run(seed, [TRUNCATE!]);
    expect(out.a!.attributes.map((a) => [a.name, a.version])).toEqual([
      ['Material Compos', 2],
      ['Material Compo2', 2],
      ['Kich co ao nam', 2],
      ['Màu sắc', 1],
    ]);
    expect(out.b!.attributes.map((a) => [a.name, a.version])).toEqual([
      ['Material Compo2', 2],
      ['Material Compos', 1],
      ['Material Compo3', 2],
    ]);
    expect(out.a!.attributes[3]!.values).toEqual([
      ['Navy blue with white', 'X', 1],
      ['Navy blue with whit2', 'X', 2],
      ['Đen', 'X', 1],
    ]);
  });

  it('chạy lại lần hai cho cùng kết quả', async () => {
    const once = await run(seed, [TRUNCATE!]);
    expect(await run(seed, [TRUNCATE!], 2)).toEqual(once);
  });
});

describe('migration dữ liệu Nhóm hàng cho công ty đã có (#447 A2)', () => {
  it('có file', () => {
    expect(DATA).toBeDefined();
  });

  const seed: Seed = {
    companies: ['old', 'empty', 'demo', 'done'],
    attributes: [
      ['old', 'Màu'],
      ['old', 'Cỡ'],
      ['demo', '[DEMO] Màu sắc'],
      ['demo', 'size'],
      ['demo', 'Màu sắc'],
      ['demo', 'Kích cỡ'],
      ['done', 'Tông màu', 'color'],
      ['done', 'màu sắc'],
    ],
    groups: [
      ['old', 'Áo thun'],
      ['old', 'Phụ kiện'],
      ['done', 'Gia dụng'],
    ],
    variants: [
      ['old', 3],
      ['done', 2],
    ],
    settings: [['done', 7]],
  };

  const expected = {
    // Có thuộc tính tương tự: gắn loại, không thêm; có nhóm: không chép 12 nhóm; số kế tiếp = số SKU + 1.
    old: {
      attributes: [
        { name: 'Màu', kind: 'color', version: 2, values: [] },
        { name: 'Cỡ', kind: 'size', version: 2, values: [] },
      ],
      groups: ['Áo thun', 'Phụ kiện'],
      nextSeq: 4,
    },
    // Công ty trống: đủ như công ty mới đăng ký.
    empty: {
      attributes: [
        { name: 'Màu sắc', kind: 'color', version: 1, values: COLORS.map(([v, c]) => [v, c, 1]) },
        { name: 'Kích cỡ', kind: 'size', version: 1, values: SIZES.map(([v, c]) => [v, c, 1]) },
      ],
      groups: GROUPS,
      nextSeq: 1,
    },
    // Thuộc tính khớp tạo sớm nhất thắng; "[DEMO] Màu sắc" không khớp tên.
    demo: {
      attributes: [
        { name: '[DEMO] Màu sắc', kind: null, version: 1, values: [] },
        { name: 'size', kind: 'size', version: 2, values: [] },
        { name: 'Màu sắc', kind: 'color', version: 2, values: [] },
        { name: 'Kích cỡ', kind: null, version: 1, values: [] },
      ],
      groups: GROUPS,
      nextSeq: 1,
    },
    // Đã có settings, đã có thuộc tính `color`: giữ nguyên; chưa có `size` thì thêm "Kích cỡ".
    done: {
      attributes: [
        { name: 'Tông màu', kind: 'color', version: 1, values: [] },
        { name: 'màu sắc', kind: null, version: 1, values: [] },
        { name: 'Kích cỡ', kind: 'size', version: 1, values: SIZES.map(([v, c]) => [v, c, 1]) },
      ],
      groups: ['Gia dụng'],
      nextSeq: 7,
    },
  };

  it('settings mỗi công ty, gắn `platform_kind` cho thuộc tính tương tự, thêm thứ còn thiếu, 12 nhóm cho công ty chưa có nhóm', async () => {
    expect(await run(seed, [DATA!])).toEqual(expected);
  });

  it('chạy lại lần hai cho cùng kết quả (chạy lại sau rollout)', async () => {
    expect(await run(seed, [DATA!], 2)).toEqual(expected);
  });
});
