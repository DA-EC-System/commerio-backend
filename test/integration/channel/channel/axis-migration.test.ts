// Migration dữ liệu `*_ghep-truc-du-lieu` (#448 L6): trục `__custom` của spec có sẵn đổi sang mã chuẩn đầu tiên theo platform_kind
// mà leaf có (kind = 'sales'), mỗi mã một trục; leaf không có mã nào thì giữ `__custom`; chạy lại được. Chạy SQL của file trong
// một giao dịch rồi rollback (dữ liệu không ở lại DB dùng chung).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';

const DIR = join(process.cwd(), 'db', 'migrations');
const sql = readFileSync(join(DIR, readdirSync(DIR).find((f) => f.endsWith('_ghep-truc-du-lieu.sql'))!), 'utf8');
const sfx = randomUUID().slice(0, 8);
const ttLeaf = `AXM-TT-${sfx}`;
const ttOnlyColor = `AXM-TC-${sfx}`;
const lzLeaf = `AXM-LZ-${sfx}`;
let companyId: string;
let colorAttr: string;
let sizeAttr: string;

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

const spec = async (c: PoolClient, platform: string, leaf: string, axisMap: object, version = 1) => {
  const v = await createVariant(companyId);
  await c.query(
    `insert into channel.product_specs (company_id, product_id, platform, external_category_id, axis_map, source, version)
     values ($1, $2, $3, $4, $5, 'push', $6)`,
    [companyId, v.productId, platform, leaf, JSON.stringify(axisMap), version],
  );
  return v.productId;
};
const read = async (c: PoolClient, productId: string) =>
  (await c.query('select axis_map, version from channel.product_specs where product_id = $1', [productId])).rows[0];

beforeAll(async () => {
  const q = testPool();
  const c = await createCompany({ optionalModules: [] });
  companyId = c.companyId;
  const attrs = await q.query('select id, platform_kind from product.attributes where company_id = $1', [companyId]);
  colorAttr = attrs.rows.find((r) => r.platform_kind === 'color').id;
  sizeAttr = attrs.rows.find((r) => r.platform_kind === 'size').id;
  const leaf = async (platform: string, id: string, codes: string[]) => {
    await q.query(
      `insert into channel.platform_categories (platform, external_id, name, is_leaf, path, path_search, synced_at)
       values ($1, $2, $2, true, $2, lower($2), now())`,
      [platform, id],
    );
    for (const code of codes) {
      await q.query(
        `insert into channel.platform_category_attributes (platform, external_category_id, code, label, kind, input, tier, fetched_at)
         values ($1, $2, $3, $3, 'sales', 'select', 'category', now())`,
        [platform, id, code],
      );
    }
  };
  await leaf('tiktok', ttLeaf, ['100000', '100007']);
  await leaf('tiktok', ttOnlyColor, ['100000']);
  await leaf('lazada', lzLeaf, ['color_family', 'size']);
});

describe('migration ghép trục dữ liệu', () => {
  it('TikTok: Màu, Kích cỡ thành 100000, 100007; leaf chỉ có 100000 thì size giữ __custom; Lazada color_family, size', async () => {
    await inRollback(async (c) => {
      const full = await spec(c, 'tiktok', ttLeaf, { [colorAttr]: '__custom', [sizeAttr]: '__custom' });
      const partial = await spec(c, 'tiktok', ttOnlyColor, { [colorAttr]: '__custom', [sizeAttr]: '__custom' });
      const lazada = await spec(c, 'lazada', lzLeaf, { [colorAttr]: '__custom', [sizeAttr]: '__custom' });
      await c.query(sql);
      expect((await read(c, full)).axis_map).toEqual({ [colorAttr]: '100000', [sizeAttr]: '100007' });
      expect((await read(c, partial)).axis_map).toEqual({ [colorAttr]: '100000', [sizeAttr]: '__custom' });
      expect((await read(c, lazada)).axis_map).toEqual({ [colorAttr]: 'color_family', [sizeAttr]: 'size' });
    });
  });

  it('trục đã có mã giữ nguyên và không bị dùng lại; trục không phải uuid, thuộc tính tự đặt giữ __custom', async () => {
    await inRollback(async (c) => {
      const taken = await spec(c, 'tiktok', ttLeaf, { [colorAttr]: '100007', [sizeAttr]: '__custom', 'A-COLOR': '__custom' });
      await c.query(sql);
      // size muốn 100007 nhưng đã bị trục Màu giữ; 100001 không có ở leaf.
      expect((await read(c, taken)).axis_map).toEqual({ [colorAttr]: '100007', [sizeAttr]: '__custom', 'A-COLOR': '__custom' });
    });
  });

  it('tăng version khi version >= 1, giữ version 0; chạy lại không đổi gì thêm', async () => {
    await inRollback(async (c) => {
      const saved = await spec(c, 'tiktok', ttLeaf, { [colorAttr]: '__custom' }, 3);
      const copy = await spec(c, 'tiktok', ttLeaf, { [colorAttr]: '__custom' }, 0);
      await c.query(sql);
      expect((await read(c, saved)).version).toBe(4);
      expect((await read(c, copy)).version).toBe(0);
      await c.query(sql);
      expect(await read(c, saved)).toEqual({ axis_map: { [colorAttr]: '100000' }, version: 4 });
    });
  });
});
