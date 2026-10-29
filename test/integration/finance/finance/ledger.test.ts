import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  recordPackageDelivered,
  recordPackageReturned,
  recordReturnInspected,
  recordReturnRefunded,
} from '#src/modules/finance/finance/service/ledger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Sổ tiền theo đơn (#116, Documents/21 §21.1, §11.2). Loại sự kiện của kiện, trả hàng chưa có trong danh mục (#106,
// #107, #112): gọi thẳng hàm ghi sổ với payload giả. Giờ cố định 10:00 ngày 05/11/2026 giờ Việt Nam: chỉ giả `Date`.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const API = '/api/v1/finance';
const get = (token: string, path: string) => request(app).get(`${API}${path}`).set('Authorization', `Bearer ${token}`);

/** Phiên bản cấu hình đang áp từ 01/10/2026, ghi thẳng bằng role chủ bảng (luồng duyệt đã test ở #118). */
async function activeConfig(companyId: string, kind: string, shopId: string | null, payload: object) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
    [companyId, kind, shopId, JSON.stringify(payload), randomUUID(), randomUUID()],
  );
}

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  await activeConfig(c.companyId, 'fee', shopId, { fixedPct: 4, transactionPct: 2, servicePct: 1, optionalPct: 0, returnFee: 15000 });
  await activeConfig(c.companyId, 'tax_regime', null, { regime: 'household' });
  await activeConfig(c.companyId, 'tax_rules', null, { vatPct: 1, pitPct: 0.5, milestones: [500_000_000, 3_000_000_000] });
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 129000 }], source: 'marketplace' });
  const admin = await addMember(c.companyId, 'admin');
  const delivered = {
    packageId: randomUUID(),
    orderId: order.orderId,
    shopId,
    deliveredAt: '2026-11-04T08:00:00Z',
    lines: [{ variantId: v.variantId, quantity: 2, unitPrice: '129000', unitCost: '60000' }],
    platformSubsidy: '10000',
    shippingIncome: '30000',
    shippingCost: '30000',
  };
  return { companyId: c.companyId, ceo: c.ceo.token, admin: admin.token, shopId, order, variantId: v.variantId, delivered };
}

describe('ghi sổ theo sự kiện (§11.2)', () => {
  it('kiện giao xong: doanh thu, trợ giá, ship, phí, thuế khấu trừ, giá vốn theo phiên bản tại ngày giao; phát lại không ghi trùng', async () => {
    const s = await setup();
    expect(await recordPackageDelivered(s.companyId, s.delivered)).toBe(9);
    expect(await recordPackageDelivered(s.companyId, s.delivered)).toBe(0);
    const { rows } = await testPool().query(
      `select kind, amount, is_estimate, occurred_on::text as day, config_version_id is not null as versioned
       from finance.ledger_entries where company_id = $1 order by kind`,
      [s.companyId],
    );
    expect(rows).toHaveLength(9);
    expect(rows.every((r) => r.is_estimate && r.day === '2026-11-04')).toBe(true);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, [r.amount, r.versioned]]));
    expect(byKind).toMatchObject({
      revenue: ['258000.00', false],
      fee_fixed: ['-10320.00', true],
      withholding_tax: ['-3870.00', true],
      cogs: ['-120000.00', false],
    });
  });

  it('kiện hoàn về: phí khi hoàn theo cấu hình của gian hàng, một lần', async () => {
    const s = await setup();
    const returned = { packageId: randomUUID(), orderId: s.order.orderId, shopId: s.shopId, returnedAt: '2026-11-04T09:00:00Z' };
    expect(await recordPackageReturned(s.companyId, returned)).toBe(1);
    expect(await recordPackageReturned(s.companyId, returned)).toBe(0);
    const res = await get(s.ceo, `/ledger?kind=return_fee`);
    expect(res.body.items.map((l: { amount: number; packageId: string }) => [l.amount, l.packageId])).toEqual([[-15000, returned.packageId]]);
  });
});

describe('GET /finance/ledger, /orders/:orderId/profit (§21.1)', () => {
  it('CEO thấy cả dòng giá vốn, Admin không; tổng ước tính đang ở sàn chỉ tính tiền mặt', async () => {
    const s = await setup();
    await recordPackageDelivered(s.companyId, s.delivered);
    const ceo = await get(s.ceo, '/ledger');
    expect(ceo.status).toBe(200);
    expect(ceo.body.total).toBe(9);
    expect(ceo.body.items[0]).toMatchObject({ orderCode: s.order.code, estimated: true, replacedBy: null, source: { type: 'package' } });
    expect(ceo.body.totals).toEqual({ receivable: 246070, platformBalance: 0, withdrawn: 0, committedPurchase: null });
    const admin = await get(s.admin, '/ledger');
    expect(admin.body.total).toBe(8);
    expect(admin.body.items.some((l: { kind: string }) => l.kind === 'cogs')).toBe(false);
    expect((await get(s.ceo, '/ledger?filter=actual')).body.total).toBe(0);
    expect((await get(s.ceo, '/ledger?from=2026-11-05')).body.total).toBe(0);
    expect((await get(s.ceo, '/ledger?from=2026-11-04&to=2026-11-04')).body.total).toBe(9);
  });

  it('lãi theo đơn: khách trả một áo bán lại được thì hoàn tiền, giảm giá vốn; Admin không thấy giá vốn', async () => {
    const s = await setup();
    await recordPackageDelivered(s.companyId, s.delivered);
    const returnRequestId = randomUUID();
    const base = { orderId: s.order.orderId, shopId: s.shopId };
    await recordReturnRefunded(s.companyId, { ...base, returnRequestId, refundAmount: '129000', refundedAt: '2026-11-05T02:00:00Z' });
    await recordReturnInspected(s.companyId, {
      ...base,
      inspectionId: randomUUID(),
      inspectedAt: '2026-11-05T02:30:00Z',
      lines: [{ variantId: s.variantId, resellable: 1, unitCost: '60000' }],
    });
    const ceo = await get(s.ceo, `/orders/${s.order.orderId}/profit`);
    expect(ceo.body).toMatchObject({ net: 117070, cogs: -60000, gross: 57070, estimated: true });
    expect(ceo.body.lines).toHaveLength(11);
    const admin = await get(s.admin, `/orders/${s.order.orderId}/profit`);
    expect(admin.body).toMatchObject({ net: 117070, cogs: null, gross: null });
    expect(admin.body.lines.some((l: { kind: string }) => l.kind.startsWith('cogs'))).toBe(false);
  });

  it('đơn chưa giao kiện nào thì lãi 0; đơn không có thì 404', async () => {
    const s = await setup();
    expect((await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body).toMatchObject({ net: 0, gross: 0, estimated: false, lines: [] });
    expect((await get(s.ceo, `/orders/${randomUUID()}/profit`)).status).toBe(404);
  });
});

describe('cảnh báo mốc thuế, quyền, cô lập công ty', () => {
  it('luỹ kế năm từ 90% mốc 500 triệu thì cảnh báo; dưới thì không', async () => {
    const s = await setup();
    await recordPackageDelivered(s.companyId, s.delivered);
    expect((await get(s.ceo, '/tax-warnings')).body).toEqual({ regime: 'household', items: [] });
    await testPool().query(
      `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, shop_id) values ($1, 'revenue', 460000000, true, '2026-06-01', $2)`,
      [s.companyId, s.shopId],
    );
    expect((await get(s.ceo, '/tax-warnings')).body.items).toEqual([{ milestone: 500_000_000, ytdRevenue: 460_258_000, over: false }]);
  });

  it('Sale không xem sổ (403); công ty khác không thấy sổ, lãi của đơn (404)', async () => {
    const s = await setup();
    await recordPackageDelivered(s.companyId, s.delivered);
    const sale = await addMember(s.companyId, 'sale');
    const denied = await get(sale.token, '/ledger');
    expect([denied.status, denied.body.type]).toEqual([403, '/problems/forbidden']);
    const other = await setup();
    expect((await get(other.ceo, '/ledger')).body.total).toBe(0);
    expect((await get(other.ceo, `/orders/${s.order.orderId}/profit`)).status).toBe(404);
  });
});
