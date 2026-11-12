import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Khoản ngoài sàn và lãi bán hàng (#308; Documents/25 §10.1 "Khoản không gắn đơn", §10.2, §10.3; 21 §21.1). Tổng tiền
// ở sàn và chạy thử cấu hình lọc theo loại dòng, không theo gian hàng; dòng "đã thay" hiểu như nhau ở hai chỗ.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const DAY = '2026-11-01';

async function entry(companyId: string, cols: Record<string, unknown>): Promise<string> {
  const all = { company_id: companyId, is_estimate: false, occurred_on: DAY, ...cols };
  const keys = Object.keys(all);
  const { rows } = await testPool().query<{ id: string }>(
    `insert into finance.ledger_entries (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    Object.values(all),
  );
  return rows[0]!.id;
}

async function profit30(token: string): Promise<number> {
  const auth = `Bearer ${token}`;
  const draft = await request(app)
    .post('/api/v1/finance/configs')
    .set('Authorization', auth)
    .send({ kind: 'tax_regime', payload: { regime: 'household' }, effectiveFrom: '2026-12-01' });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const dry = await request(app).post(`/api/v1/finance/configs/${draft.body.id}/dry-run`).set('Authorization', auth).send({ version: draft.body.version });
  expect(dry.status, JSON.stringify(dry.body)).toBe(200);
  return dry.body.dryRun.profit30.now;
}

async function totals(token: string) {
  const res = await request(app).get('/api/v1/finance/ledger').set('Authorization', `Bearer ${token}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.totals;
}

describe('chạy thử cấu hình: lãi 30 ngày chỉ gồm lãi bán hàng', () => {
  it('rút tiền về ngân hàng không vào lãi (21 §21.1)', async () => {
    const c = await createCompany();
    const shopId = randomUUID();
    await entry(c.companyId, { kind: 'revenue', amount: '100000', shop_id: shopId });
    await entry(c.companyId, { kind: 'withdrawal', amount: '-50000', shop_id: shopId });
    expect(await profit30(c.ceo.token)).toBe(100000);
  });

  it('COD tự giao đã thu là khoản ngoài sàn (25 §10.1), kể cả khi gắn gian hàng: không vào lãi', async () => {
    const c = await createCompany();
    const shopId = randomUUID();
    await entry(c.companyId, { kind: 'revenue', amount: '100000', shop_id: shopId });
    await entry(c.companyId, { kind: 'cod_collected', amount: '100000', shop_id: shopId });
    expect(await profit30(c.ceo.token)).toBe(100000);
  });

  it('đơn đã có số quyết toán: mọi dòng ước tính của đơn coi như đã thay, như tổng tiền ở sàn', async () => {
    const c = await createCompany();
    const shopId = randomUUID();
    const orderId = randomUUID();
    const est = await entry(c.companyId, { kind: 'revenue', amount: '100000', shop_id: shopId, order_id: orderId, is_estimate: true });
    await entry(c.companyId, { kind: 'fee_fixed', amount: '-4000', shop_id: shopId, order_id: orderId, is_estimate: true });
    await entry(c.companyId, { kind: 'revenue', amount: '100000', shop_id: shopId, order_id: orderId, replaces_entry_id: est });
    await entry(c.companyId, { kind: 'fee_transaction', amount: '-3000', shop_id: shopId, order_id: orderId });
    expect(await profit30(c.ceo.token)).toBe(97000);
    expect(await totals(c.ceo.token)).toMatchObject({ receivable: 0, platformBalance: 97000 });
  });
});

describe('tổng tiền ở sàn (25 §10.3): bỏ khoản ngoài sàn, vẫn trừ rút tiền', () => {
  it('NCC hoàn tiền, COD tự giao không vào số dư ví sàn; rút tiền trừ vào số dư', async () => {
    const c = await createCompany();
    const shopId = randomUUID();
    await entry(c.companyId, { kind: 'revenue', amount: '100000', shop_id: shopId });
    await entry(c.companyId, { kind: 'withdrawal', amount: '-30000', shop_id: shopId });
    await entry(c.companyId, { kind: 'supplier_refund', amount: '120000', source_type: 'supplier_return', source_id: randomUUID() });
    await entry(c.companyId, { kind: 'cod_collected', amount: '50000', shop_id: shopId });
    expect(await totals(c.ceo.token)).toMatchObject({ receivable: 0, platformBalance: 70000, withdrawn: 30000 });
  });
});
