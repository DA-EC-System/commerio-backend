import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { defaultDemo } from '../../../db/seed/demo.ts';
import { parseSection, seedScenarios } from '../../../db/seed/scenarios.ts';
import { uniqueEmail } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, PASSWORD, selectCompany, testApp } from '../helpers/http.ts';

const db = testPool();
function input() {
  const result = defaultDemo(PASSWORD);
  for (const account of Object.values(result.accounts)) account.email = uniqueEmail('demo');
  return result;
}

async function counts(companyIds: string[]) {
  const { rows } = await db.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.columns
      where column_name = 'company_id' and table_schema in ('core','product','order','finance','channel','insight')`,
  );
  const result: Record<string, number> = {};
  for (const row of rows) {
    const table = `"${row.table_schema}"."${row.table_name}"`;
    const count = await db.query<{ n: number }>(`select count(*)::int n from ${table} where company_id = any($1::uuid[])`, [companyIds]);
    result[table] = count.rows[0]!.n;
  }
  return result;
}

describe('seed kịch bản qua API công khai', () => {
  it('chạy hai lần không thêm dòng; đủ vai trò, đề nghị duyệt và cách ly công ty qua HTTP', async () => {
    const main = input();
    const secondary = input();
    const options = { secondary, now: new Date('2026-10-29T03:00:00Z') };
    const first = await seedScenarios(main, options);
    const companyId = first.companyId as string;
    const secondId = (first.secondary as { companyId: string }).companyId;
    const before = await counts([companyId, secondId]);
    expect(await seedScenarios(main, options)).toEqual(first);
    expect(await counts([companyId, secondId])).toEqual(before);
    const approvals = await db.query('select status, self_approved, created_by, approved_by from product.purchase_requests where company_id = $1', [companyId]);
    expect(approvals.rows.map((r) => r.status)).toEqual(expect.arrayContaining([
      'draft', 'pending_approval', 'approved', 'changes_requested', 'rejected', 'ordered',
    ]));
    expect(approvals.rows.some((r) => r.self_approved && r.created_by === r.approved_by)).toBe(true);
    expect(approvals.rows.some((r) => !r.self_approved && r.approved_by && r.created_by !== r.approved_by)).toBe(true);

    const token = await selectCompany((await login(main.accounts.ceo.email)).token, companyId);
    const secondToken = await selectCompany((await login(secondary.accounts.ceo.email)).token, secondId);
    const app = testApp();
    const products = await request(app).get('/api/v1/catalog/products').auth(token, { type: 'bearer' }).expect(200);
    expect(products.body.total).toBe(11);
    const isolated = await request(app).get('/api/v1/catalog/products').auth(secondToken, { type: 'bearer' }).expect(200);
    expect(isolated.body.total).toBe(3);
    await request(app).get(`/api/v1/catalog/products/${products.body.items[0].id}`).auth(secondToken, { type: 'bearer' }).expect(404);
    const stock = await request(app).get('/api/v1/inventory/stock').auth(token, { type: 'bearer' }).expect(200);
    expect(stock.body.items.length).toBeGreaterThan(0);
    const purchases = await request(app).get('/api/v1/purchasing/requests').auth(token, { type: 'bearer' }).expect(200);
    expect(purchases.body.total).toBe(7);
    const otherPurchases = await request(app).get('/api/v1/purchasing/requests').auth(secondToken, { type: 'bearer' }).expect(200);
    expect(otherPurchases.body.total).toBe(0);
    const modules = await request(app).get('/api/v1/platform/modules').auth(token, { type: 'bearer' }).expect(200);
    expect(modules.body.every((m: { enabled: boolean }) => m.enabled)).toBe(true);
    await selectCompany((await login(main.accounts.buyer!.email)).token, companyId);
  }, 60000);

  it('chạy riêng purchasing kéo theo catalog nhưng không seed công ty thứ hai hay tồn', async () => {
    const result = await seedScenarios(input(), { only: 'purchasing' });
    expect(result.purchasing).toEqual({ suppliers: 3, requests: 7 });
    expect(result.secondary).toBeUndefined();
    expect(result.inventory).toBeUndefined();
  }, 60000);

  it('từ chối tên phân hệ sai trước khi seed', () => {
    expect(parseSection(['--only', 'purchasing'])).toBe('purchasing');
    expect(() => parseSection(['--only', 'sales'])).toThrow('Cú pháp');
  });
});
