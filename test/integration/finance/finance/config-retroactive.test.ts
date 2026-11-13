import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { recordPackageDelivered, recordPackageReturned } from '#src/modules/finance/finance/service/ledger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Phiên bản có ngày hiệu lực đã qua (#230; Documents/25 §10.4 "Luật hồi tố", 21 §21.4 `approve`): sang thẳng `active`
// và ghi dòng `adjustment` cho các kiện trong khoảng hồi tố, mỗi dòng có lý do, không sửa dòng cũ. Doanh nghiệp: lãi
// bỏ GTGT đầu ra (US-TI-14 dòng 2). Giờ cố định 10:00 ngày TODAY giờ Việt Nam: chỉ giả `Date`.
const TODAY = '2026-11-02';
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T03:00:00Z`));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const API = '/api/v1/finance';
const fee = (over: Record<string, number> = {}) => ({ fixedPct: 4, transactionPct: 2, servicePct: 1, optionalPct: 0, returnFee: 15000, ...over });
const rules = { vatPct: 1, pitPct: 0.5, outputVatPct: 10, milestones: [500_000_000, 3_000_000_000] };

const as = (token: string) => {
  const auth = `Bearer ${token}`;
  return {
    get: (path: string) => request(app).get(`${API}${path}`).set('Authorization', auth),
    post: (path: string, body: object = {}) => request(app).post(`${API}${path}`).set('Authorization', auth).send(body),
  };
};
type Client = ReturnType<typeof as>;

/** Phiên bản đang áp từ 01/10/2026, ghi thẳng bằng role chủ bảng (luồng duyệt đã test ở config-versions.test.ts). */
async function activeConfig(companyId: string, kind: string, shopId: string | null, payload: object): Promise<string> {
  const { rows } = await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now()) returning id`,
    [companyId, kind, shopId, JSON.stringify(payload), randomUUID(), randomUUID()],
  );
  return rows[0].id;
}

/** Soạn, chạy thử, gửi duyệt bằng `author`, `approver` duyệt. */
async function approve(author: Client, approver: Client, body: object) {
  const created = await author.post('/configs', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dry = await author.post(`/configs/${created.body.id}/dry-run`, { version: created.body.version });
  const sent = await author.post(`/configs/${created.body.id}/submit`, { version: dry.body.version });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  const res = await approver.post(`/configs/${created.body.id}/approve`, { version: sent.body.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  const oldFee = await activeConfig(c.companyId, 'fee', shopId, fee());
  await activeConfig(c.companyId, 'tax_regime', null, { regime: 'household' });
  await activeConfig(c.companyId, 'tax_rules', null, rules);
  const v = await createVariant(c.companyId);
  const admin = await addMember(c.companyId, 'admin');
  /** Một đơn sàn hai áo 129.000 đ, kiện giao ngày `day`. */
  const deliver = async (day: string) => {
    const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 129000 }], source: 'marketplace' });
    const packageId = randomUUID();
    await recordPackageDelivered(c.companyId, {
      packageId,
      orderId: order.orderId,
      shopId,
      deliveredAt: `${day}T03:00:00Z`,
      lines: [{ variantId: v.variantId, quantity: 2, unitPrice: '129000', unitCost: '60000' }],
      platformSubsidy: '10000',
      shippingIncome: '30000',
      shippingCost: '30000',
    });
    return { orderId: order.orderId, packageId };
  };
  return { companyId: c.companyId, shopId, oldFee, ceo: as(c.ceo.token), admin: as(admin.token), deliver };
}

const adjustments = async (companyId: string) =>
  (
    await testPool().query(
      `select package_id, source_type, amount, reason, is_estimate, occurred_on::text as day, config_version_id
       from finance.ledger_entries where company_id = $1 and kind = 'adjustment' order by created_at, amount`,
      [companyId],
    )
  ).rows;

describe('luật hồi tố khi phiên bản sang active (25 §10.4)', () => {
  it('US-TI-12 dòng 2, US-TI-13 dòng 4: phí sàn hồi tố từ 25/10: sang thẳng active, điều chỉnh mọi kiện từ ngày hiệu lực, có lý do; kiện trước đó và dòng cũ giữ nguyên', async () => {
    const s = await setup();
    const before = await s.deliver('2026-10-20');
    const inRange = await s.deliver('2026-10-28');
    await recordPackageReturned(s.companyId, { packageId: before.packageId, orderId: before.orderId, shopId: s.shopId, returnedAt: '2026-10-30T03:00:00Z' });
    const linesBefore = (await testPool().query('select count(*)::int as n from finance.ledger_entries where company_id = $1', [s.companyId])).rows[0].n;

    const v = await approve(s.admin, s.ceo, { kind: 'fee', shopId: s.shopId, payload: fee({ fixedPct: 5, returnFee: 20000 }), effectiveFrom: '2026-10-25' });
    expect(v.status).toBe('active');
    expect((await s.admin.get(`/configs/${s.oldFee}`)).body).toMatchObject({ status: 'superseded', effectiveTo: '2026-10-24' });

    const adj = await adjustments(s.companyId);
    // Kiện 28/10: phí 7% → 8% của 258.000 đ (−18.060 → −20.640). Kiện hoàn 30/10 (kiện giao 20/10): phí khi hoàn 15.000 → 20.000.
    expect(adj.map((a) => [a.package_id, a.source_type, a.amount])).toEqual(
      expect.arrayContaining([
        [inRange.packageId, 'package', '-2580.00'],
        [before.packageId, 'package_return', '-5000.00'],
      ]),
    );
    expect(adj).toHaveLength(2);
    for (const a of adj) {
      expect(a).toMatchObject({ is_estimate: true, day: TODAY, config_version_id: v.id });
      expect(a.reason).toMatch(/^Hồi tố theo phiên bản phí sàn hiệu lực từ 2026-10-25/);
    }
    const linesAfter = (await testPool().query('select count(*)::int as n from finance.ledger_entries where company_id = $1', [s.companyId])).rows[0].n;
    expect(linesAfter).toBe(linesBefore + 2);

    const profit = await s.ceo.get(`/orders/${inRange.orderId}/profit`);
    expect(profit.body.lines.find((l: { kind: string }) => l.kind === 'adjustment')).toMatchObject({ amount: -2580, reason: expect.any(String) });
  });

  it('E148: bản sửa lỗi cùng ngày hiệu lực tính chênh lệch so với cả điều chỉnh trước đó; bản bị sửa sang superseded', async () => {
    const s = await setup();
    const pkg = await s.deliver('2026-10-28');
    const v1 = await approve(s.admin, s.ceo, { kind: 'fee', shopId: s.shopId, payload: fee({ fixedPct: 5 }), effectiveFrom: '2026-10-25' });
    const v2 = await approve(s.admin, s.ceo, {
      kind: 'fee',
      shopId: s.shopId,
      payload: fee({ fixedPct: 6 }),
      effectiveFrom: '2026-10-25',
      supersedesId: v1.id,
      isCorrection: true,
    });
    expect(v2.status).toBe('active');
    expect((await s.admin.get(`/configs/${v1.id}`)).body.status).toBe('superseded');
    const adj = await adjustments(s.companyId);
    expect(adj.map((a) => [a.package_id, a.amount, a.config_version_id])).toEqual([
      [pkg.packageId, '-2580.00', v1.id],
      [pkg.packageId, '-2580.00', v2.id],
    ]);
  });

  it('phiên bản ngày hiệu lực ở tương lai, ngưỡng lệch hồi tố: không ghi điều chỉnh', async () => {
    const s = await setup();
    await s.deliver('2026-10-28');
    await approve(s.admin, s.ceo, { kind: 'fee', shopId: s.shopId, payload: fee({ fixedPct: 9 }), effectiveFrom: '2026-11-10' });
    await approve(s.admin, s.ceo, { kind: 'mismatch_threshold', payload: { abs: 1, pct: 1, resolveLimit: 1 }, effectiveFrom: '2026-10-20' });
    expect(await adjustments(s.companyId)).toEqual([]);
  });

  it('US-TI-14 dòng 2, 4: hộ kinh doanh lên doanh nghiệp hồi tố: hoàn lại thuế khấu trừ đã ước tính; lãi của đơn bỏ GTGT đầu ra', async () => {
    const s = await setup();
    const pkg = await s.deliver('2026-10-28');
    const v = await approve(s.admin, s.ceo, { kind: 'tax_regime', payload: { regime: 'company' }, effectiveFrom: '2026-10-26' });
    expect(v.status).toBe('active');
    const adj = await adjustments(s.companyId);
    expect(adj.map((a) => [a.package_id, a.amount])).toEqual([[pkg.packageId, '3870.00']]);
    expect(adj[0].reason).toMatch(/loại hình thuế.*thuế sàn khấu trừ/);

    // 258.000 + 10.000 + 30.000 − 30.000 − 18.060 phí − 3.870 + 3.870 điều chỉnh − 23.455 GTGT đầu ra (258.000 − 258.000/1,1).
    const profit = await s.ceo.get(`/orders/${pkg.orderId}/profit`);
    expect(profit.status, JSON.stringify(profit.body)).toBe(200);
    expect(profit.body).toMatchObject({ net: 226485, cogs: -120000, gross: 106485, estimated: true });
  });

  it('US-TI-14 dòng 2: doanh nghiệp từ đầu: kiện giao không có dòng thuế khấu trừ, doanh thu trong lãi đã bỏ GTGT đầu ra', async () => {
    const c = await createCompany();
    const shopId = randomUUID();
    await activeConfig(c.companyId, 'fee', shopId, fee());
    await activeConfig(c.companyId, 'tax_regime', null, { regime: 'company' });
    await activeConfig(c.companyId, 'tax_rules', null, rules);
    const v = await createVariant(c.companyId);
    const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 1, unitPrice: 110000 }], source: 'marketplace' });
    await recordPackageDelivered(c.companyId, {
      packageId: randomUUID(),
      orderId: order.orderId,
      shopId,
      deliveredAt: '2026-10-28T03:00:00Z',
      lines: [{ variantId: v.variantId, quantity: 1, unitPrice: '110000', unitCost: '50000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    const profit = await as(c.ceo.token).get(`/orders/${order.orderId}/profit`);
    expect(profit.body.lines.map((l: { kind: string }) => l.kind)).not.toContain('withholding_tax');
    expect(profit.body.lines.find((l: { kind: string }) => l.kind === 'revenue').amount).toBe(110000);
    // 110.000/1,1 = 100.000; phí 7% của 110.000 = 7.700.
    expect(profit.body).toMatchObject({ net: 92300, cogs: -50000, gross: 42300 });
  });
});
