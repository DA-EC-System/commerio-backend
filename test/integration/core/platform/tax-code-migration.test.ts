// Migration dọn mã số thuế và bật Kênh bán (#459, `*_mst-chuan-hoa-kenh-ban-loi`): chạy trước migration sinh thêm UNIQUE.
// DB test đã có UNIQUE, nên ca dựng lại dạng trước #459 (bỏ UNIQUE) trong một giao dịch, chèn dữ liệu kiểu staging,
// chạy SQL của file rồi rollback.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { uniqueTaxCode } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const file = readdirSync(DIR).find((f) => f.endsWith('_mst-chuan-hoa-kenh-ban-loi.sql'))!;

describe('migration chuẩn hoá mã số thuế, Kênh bán lõi (#459)', () => {
  it('chuẩn hoá, đặt NULL mã sai định dạng và mã trùng (giữ công ty cũ nhất), bật channel; chạy lại không đổi gì', async () => {
    const client = await testPool().connect();
    try {
      await client.query('begin');
      await client.query('alter table core.companies drop constraint companies_tax_code_unique');
      const dup = uniqueTaxCode();
      const branch = uniqueTaxCode();
      const rows: Record<string, { taxCode: string; createdAt: string }> = {
        spaced: { taxCode: `${dup.slice(0, 4)} ${dup.slice(4)}`, createdAt: '2026-10-01T00:00:00Z' },
        dotted: { taxCode: `${dup.slice(0, 4)}.${dup.slice(4)}`, createdAt: '2026-10-02T00:00:00Z' },
        branch: { taxCode: `${branch}001`, createdAt: '2026-10-03T00:00:00Z' },
        invalid: { taxCode: '12345', createdAt: '2026-10-04T00:00:00Z' },
      };
      const ids: Record<string, string> = {};
      for (const [key, row] of Object.entries(rows)) {
        const { rows: inserted } = await client.query<{ id: string }>(
          'insert into core.companies (name, tax_code, created_at) values ($1, $2, $3) returning id',
          [`Công ty migration ${key} ${randomUUID().slice(0, 6)}`, row.taxCode, row.createdAt],
        );
        ids[key] = inserted[0]!.id;
      }
      await client.query(
        "insert into core.company_modules (company_id, module_code, enabled) values ($1, 'channel', false)",
        [ids.spaced],
      );

      const sql = readFileSync(join(DIR, file), 'utf8');
      await client.query(sql);
      const read = async () =>
        Object.fromEntries(
          (
            await client.query<{ id: string; tax_code: string | null }>(
              'select id, tax_code from core.companies where id = any($1)',
              [Object.values(ids)],
            )
          ).rows.map((r) => [r.id, r.tax_code]),
        );
      const after = await read();
      expect(after[ids.spaced!]).toBe(dup);
      expect(after[ids.dotted!]).toBeNull();
      expect(after[ids.branch!]).toBe(`${branch}-001`);
      expect(after[ids.invalid!]).toBeNull();

      const channel = await client.query<{ company_id: string; enabled: boolean }>(
        "select company_id, enabled from core.company_modules where module_code = 'channel' and company_id = any($1)",
        [Object.values(ids)],
      );
      expect(channel.rows).toHaveLength(4);
      expect(channel.rows.every((r) => r.enabled)).toBe(true);

      await client.query(sql);
      expect(await read()).toEqual(after);
      // Sau khi dọn thì UNIQUE thêm lại được (migration sinh chạy ngay sau).
      await client.query('alter table core.companies add constraint companies_tax_code_unique unique (tax_code)');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
