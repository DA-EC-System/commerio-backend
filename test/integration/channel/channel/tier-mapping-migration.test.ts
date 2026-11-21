// Migration `*_anh-xa-hai-tang-du-lieu` (be#522), phần chuyển dữ liệu: chạy sau `*_du-lieu-chung-chuyen` (be#521) đã gộp bản sao
// catalog theo công ty vào dòng nền tảng và ghi `product.tier_merge_remap`. Dựng lại bảng gộp trong một giao dịch, chạy các câu
// dữ liệu của file (bỏ câu khoá ngoại, policy đã chạy lúc migrate) rồi rollback.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const file = readFileSync(join(DIR, readdirSync(DIR).find((f) => f.endsWith('_anh-xa-hai-tang-du-lieu.sql'))!), 'utf8');
const dataStatements = file
  .split('--> statement-breakpoint')
  .map((s) => s.trim())
  .filter((s) => !/^(--[^\n]*\n)*\s*(ALTER TABLE channel\.spec_option_mappings ADD CONSTRAINT|DROP POLICY|CREATE POLICY)/.test(s));

const tag = randomUUID().slice(0, 8);
const CODE = `tmm_${tag}`;
const OWN_CODE = `tmm_own_${tag}`;
const TAKEN = `tmm_taken_${tag}`;
let companyId: string;

async function inRollback(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  const client = await testPool().connect();
  try {
    await client.query('begin');
    await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const one = async (c: PoolClient, sql: string, params: unknown[]) => (await c.query<{ id: string }>(`${sql} returning id`, params)).rows[0]!.id;

beforeAll(async () => {
  companyId = (await createCompany({ optionalModules: [] })).companyId;
});

describe('chuyển ánh xạ sang hai tầng', () => {
  it('bản sao bỏ, lựa chọn riêng theo thông số chuẩn; spec đổi khoá trục; thông số riêng giữ mã riêng, nhường mã chuẩn', async () => {
    await inRollback(async (c) => {
      await c.query(`create table product.tier_merge_remap (kind text not null, old_id uuid not null, new_id uuid not null, primary key (kind, old_id))`);
      // Thông số chuẩn (dòng nền tảng sau be#521) với ánh xạ nền tảng; bản sao cũ của công ty đã bị xoá khỏi catalog.
      const std = await one(c, `insert into product.spec_fields (company_id, code, name, input, allow_custom) values (null, $1, $1, 'select', false)`, [`tmm_${tag}`]);
      const stdOpt = await one(c, `insert into product.spec_field_options (company_id, field_id, value, position) values (null, $1, 'Lụa', 1)`, [std]);
      const ownOpt = await one(c, `insert into product.spec_field_options (company_id, field_id, value, position) values ($1, $2, 'Lanh riêng', 2)`, [
        companyId,
        std,
      ]);
      const copyField = randomUUID();
      const copyOpt = randomUUID();
      await c.query(`insert into product.tier_merge_remap values ('spec_field', $1, $2), ('spec_option', $3, $4)`, [copyField, std, copyOpt, stdOpt]);
      await c.query(`insert into channel.spec_field_mappings (company_id, field_id, platform, attribute_code, priority) values (null, $1, 'lazada', $2, 1)`, [std, CODE]);
      // Dữ liệu trước be#522: công ty giữ dòng mã của bản sao, ánh xạ lựa chọn bản sao và lựa chọn riêng theo bản sao.
      await c.query(`alter table channel.spec_option_mappings drop constraint spec_option_mappings_field_fk`);
      await c.query(`insert into channel.spec_field_mappings (company_id, field_id, platform, attribute_code, priority) values ($1, $2, 'lazada', $3, 1)`, [
        companyId,
        copyField,
        CODE,
      ]);
      await c.query(
        `insert into channel.spec_option_mappings (company_id, field_id, option_id, platform, attribute_code, platform_option_id)
         values ($1, $2, $3, 'lazada', $4, 'x1'), ($1, $2, $5, 'lazada', $4, 'x2')`,
        [companyId, copyField, copyOpt, CODE, ownOpt],
      );
      // Thông số riêng của công ty: một mã riêng (giữ) và một mã nay thuộc thông số chuẩn (nhường).
      const own = await one(c, `insert into product.spec_fields (company_id, code, name, input, allow_custom) values ($1, $2, $2, 'text', true)`, [
        companyId,
        `tmm_own_${tag}`,
      ]);
      await c.query(`insert into channel.spec_field_mappings (company_id, field_id, platform, attribute_code, priority) values (null, $1, 'tiktok', $2, 1)`, [
        std,
        TAKEN,
      ]);
      await c.query(
        `insert into channel.spec_field_mappings (company_id, field_id, platform, attribute_code, priority) values ($1, $2, 'lazada', $3, 1), ($1, $2, 'tiktok', $4, 1)`,
        [companyId, own, OWN_CODE, TAKEN],
      );
      // Spec cũ trỏ id thuộc tính, giá trị của bản sao.
      const oldAttr = randomUUID();
      const newAttr = randomUUID();
      const oldVal = randomUUID();
      const newVal = randomUUID();
      const keepAttr = randomUUID();
      await c.query(`insert into product.tier_merge_remap values ('attribute', $1, $2), ('attribute_value', $3, $4)`, [oldAttr, newAttr, oldVal, newVal]);
      const v = await createVariant(companyId);
      await c.query(
        `insert into channel.product_specs (company_id, product_id, platform, external_category_id, axis_map, value_map, source, version)
         values ($1, $2, 'lazada', 'leaf', $3, $4, 'push', 2)`,
        [companyId, v.productId, JSON.stringify({ [oldAttr]: 'color_family', [keepAttr]: 'size' }), JSON.stringify({ [oldVal]: 'Đỏ' })],
      );

      for (const s of dataStatements) await c.query(s);

      const fieldRows = await c.query(`select company_id, field_id, platform, attribute_code from channel.spec_field_mappings where field_id = any($1)`, [
        [copyField, std, own],
      ]);
      expect(fieldRows.rows).toEqual(
        expect.arrayContaining([
          { company_id: null, field_id: std, platform: 'lazada', attribute_code: CODE },
          { company_id: companyId, field_id: own, platform: 'lazada', attribute_code: OWN_CODE },
        ]),
      );
      expect(fieldRows.rows.some((r) => r.field_id === copyField)).toBe(false);
      expect(fieldRows.rows.some((r) => r.field_id === own && r.platform === 'tiktok')).toBe(false);
      const optRows = await c.query(`select company_id, field_id, option_id, platform_option_id from channel.spec_option_mappings where option_id = any($1)`, [
        [copyOpt, stdOpt, ownOpt],
      ]);
      expect(optRows.rows).toEqual([{ company_id: companyId, field_id: std, option_id: ownOpt, platform_option_id: 'x2' }]);
      const spec = await c.query(`select axis_map, value_map, version from channel.product_specs where product_id = $1`, [v.productId]);
      expect(spec.rows[0]).toEqual({ axis_map: { [newAttr]: 'color_family', [keepAttr]: 'size' }, value_map: { [newVal]: 'Đỏ' }, version: 3 });
      expect((await c.query(`select to_regclass('product.tier_merge_remap') as t`)).rows[0].t).toBeNull();
    });
  });
});
