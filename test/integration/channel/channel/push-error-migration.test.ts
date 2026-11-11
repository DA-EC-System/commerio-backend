// Migration `push_error` text → jsonb (#219) trên dữ liệu kiểu cũ: chạy đúng câu SQL của file migration lên một bảng tạm
// cùng hai cột, chứa mọi dạng giá trị `main` từng ghi (listings.ts `pushOne`, listing-sync.ts kẹt `pushing`) và dạng lạ.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { testPool } from '../../helpers/db.ts';

const FILE = join(process.cwd(), 'db', 'migrations', '20261111145247_push-error-chuyen-du-lieu.sql');
const UPDATED_AT = '2026-11-01T02:03:04.567Z';

const legacy: [label: string, value: string | null][] = [
  ['null', null],
  ['rỗng', ''],
  ['chỉ khoảng trắng', '   '],
  ['lỗi tạm của main', 'Sàn lỗi tạm, đẩy lại sau'],
  ['kẹt pushing của main', 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại'],
  ['câu mặc định khi sàn từ chối', 'Sàn từ chối sản phẩm'],
  ['câu của sàn', 'E0501: Category attribute "brand" is mandatory'],
  ['ký tự đặc biệt', `Lỗi 'nháy đơn' "nháy kép" \\ gạch ngược\nxuống dòng\ttab 😀`],
  ['trông như JSON', '{"code":"x","message":"y"}'],
];

async function migrate(values: (string | null)[]) {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await client.query('create temp table legacy_listings (n int, push_error text, updated_at timestamptz not null) on commit drop');
    for (const [i, v] of values.entries()) {
      await client.query('insert into legacy_listings values ($1, $2, $3)', [i, v, UPDATED_AT]);
    }
    const sql = readFileSync(FILE, 'utf8').replaceAll('"channel"."listings"', 'legacy_listings');
    expect(sql).not.toContain('"channel"');
    await client.query(sql);
    const { rows } = await client.query<{ push_error: unknown; type: string }>(
      'select push_error, pg_typeof(push_error)::text as type from legacy_listings order by n',
    );
    await client.query('rollback');
    return rows;
  } finally {
    client.release();
  }
}

describe('migration push_error text → jsonb trên dữ liệu cũ (#219)', () => {
  it('mỗi dạng cũ ra { code, message, at } hoặc null; lỗi tạm và kẹt pushing là marketplace_unavailable', async () => {
    const rows = await migrate(legacy.map(([, v]) => v));
    expect(rows.every((r) => r.type === 'jsonb')).toBe(true);
    const at = UPDATED_AT;
    expect(Object.fromEntries(legacy.map(([label], i) => [label, rows[i]!.push_error]))).toEqual({
      null: null,
      rỗng: null,
      'chỉ khoảng trắng': null,
      'lỗi tạm của main': { code: 'marketplace_unavailable', message: 'Sàn lỗi tạm, đẩy lại sau', at },
      'kẹt pushing của main': { code: 'marketplace_unavailable', message: 'Quá 30 phút chưa có kết quả từ sàn, đẩy lại', at },
      'câu mặc định khi sàn từ chối': { code: 'marketplace_rejected', message: 'Sàn từ chối sản phẩm', at },
      'câu của sàn': { code: 'marketplace_rejected', message: 'E0501: Category attribute "brand" is mandatory', at },
      'ký tự đặc biệt': { code: 'marketplace_rejected', message: legacy[7]![1], at },
      // Chuỗi trông như JSON vẫn là câu lỗi, không bị đọc thành object.
      'trông như JSON': { code: 'marketplace_rejected', message: '{"code":"x","message":"y"}', at },
    });
  });

  it('migration drizzle ngay sau (SET DATA TYPE jsonb) chạy được trên cột đã chuyển, giữ nguyên giá trị', async () => {
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('create temp table legacy_listings (push_error text, updated_at timestamptz not null) on commit drop');
      await client.query('insert into legacy_listings values ($1, $2)', ['Sàn từ chối sản phẩm', UPDATED_AT]);
      await client.query(readFileSync(FILE, 'utf8').replaceAll('"channel"."listings"', 'legacy_listings'));
      await client.query('alter table legacy_listings alter column push_error set data type jsonb');
      const { rows } = await client.query('select push_error from legacy_listings');
      expect(rows[0].push_error).toMatchObject({ code: 'marketplace_rejected', message: 'Sàn từ chối sản phẩm' });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});
