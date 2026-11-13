import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SkuProfitPage } from '#src/modules/finance/finance/api/ledger-schemas.ts';
import { recordPackageDelivered, recordReturnInspected } from '#src/modules/finance/finance/service/ledger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Lãi theo SKU (#231; Documents/21 §21.1, 25 §10.2): dòng hàng lưu từ sự kiện kiện giao, khoản cấp đơn chia theo doanh thu.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const get = (token: string, path: string) => request(app).get(`/api/v1/finance${path}`).set('Authorization', `Bearer ${token}`);
const PERIOD = '/skus/profits?from=2026-11-01&to=2026-11-30';

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  // Phí 7% doanh thu: đơn 250.000đ thực nhận ước tính 232.500đ.
  for (const [kind, shop, payload] of [
    ['fee', shopId, { fixedPct: 4, transactionPct: 2, servicePct: 1, optionalPct: 0, returnFee: 15000 }],
    ['tax_regime', null, { regime: 'company' }],
  ] as const) {
    await testPool().query(
      `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
       values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
      [c.companyId, kind, shop, JSON.stringify(payload), randomUUID(), randomUUID()],
    );
  }
  const a = await createVariant(c.companyId);
  const b = await createVariant(c.companyId);
  const admin = await addMember(c.companyId, 'admin');
  return { companyId: c.companyId, ceo: c.ceo.token, admin: admin.token, shopId, a, b };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Đơn hai dòng: A 2 × 100.000đ (vốn 60.000đ), B 1 × 50.000đ chưa có giá vốn; giao một kiện. */
async function deliveredOrder(s: Setup, deliveredAt = '2026-11-04T08:00:00Z') {
  const order = await createOrder(s.companyId, {
    lines: [
      { variantId: s.a.variantId, quantity: 2, unitPrice: 100000 },
      { variantId: s.b.variantId, quantity: 1, unitPrice: 50000 },
    ],
    source: 'marketplace',
  });
  await recordPackageDelivered(s.companyId, {
    packageId: randomUUID(),
    orderId: order.orderId,
    shopId: s.shopId,
    deliveredAt,
    lines: [
      { variantId: s.a.variantId, quantity: 2, unitPrice: '100000', unitCost: '60000' },
      { variantId: s.b.variantId, quantity: 1, unitPrice: '50000', unitCost: null },
    ],
    platformSubsidy: '0',
    shippingIncome: '0',
    shippingCost: '0',
  });
  return order;
}

describe('GET /finance/skus/profits (§21.1)', () => {
  it('chia thực nhận của đơn theo doanh thu dòng hàng, giá vốn theo dòng, đánh dấu thiếu giá vốn', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    const res = await get(s.ceo, PERIOD);
    expect(res.status).toBe(200);
    const body = SkuProfitPage.parse(res.body);
    expect(body.items).toEqual([
      {
        variantId: s.a.variantId,
        sku: s.a.sku,
        productName: expect.stringMatching(/^Sản phẩm /),
        soldQty: 2,
        net: 186000,
        cogs: -120000,
        gross: 66000,
        marginPct: 35.5,
        costMissing: false,
      },
      {
        variantId: s.b.variantId,
        sku: s.b.sku,
        productName: expect.stringMatching(/^Sản phẩm /),
        soldQty: 1,
        net: 46500,
        cogs: 0,
        gross: 46500,
        marginPct: 100,
        costMissing: true,
      },
    ]);
    expect(body.totals).toEqual({ net: 232500, cogs: -120000, gross: 112500 });
    expect(body.total).toBe(2);
    // Tổng theo SKU khớp lãi của đơn.
    const single = (await get(s.ceo, `/orders/${order.orderId}/profit`)).body;
    expect(single).toMatchObject({ net: 232500, cogs: -120000 });
  });

  it('R4: Admin thấy thực nhận, không thấy giá vốn, lãi gộp', async () => {
    const s = await setup();
    await deliveredOrder(s);
    const body = SkuProfitPage.parse((await get(s.admin, PERIOD)).body);
    expect(body.items[0]).toMatchObject({ net: 186000, cogs: null, gross: null, marginPct: null });
    expect(body.totals).toEqual({ net: 232500, cogs: null, gross: null });
  });

  it('lọc theo ngày giao (giờ Việt Nam), gian hàng; phân trang giữ tổng toàn bộ', async () => {
    const s = await setup();
    await deliveredOrder(s, '2026-11-03T08:00:00Z');
    await deliveredOrder(s, '2026-10-31T16:30:00Z'); // 31/10 giờ VN, ngoài kỳ
    const body = SkuProfitPage.parse((await get(s.ceo, `${PERIOD}&pageSize=1&page=2`)).body);
    expect(body.items.map((i) => i.variantId)).toEqual([s.b.variantId]);
    expect(body.total).toBe(2);
    expect(body.totals.net).toBe(232500);
    expect((await get(s.ceo, `${PERIOD}&shopId=${randomUUID()}`)).body).toMatchObject({ items: [], total: 0, totals: { net: 0, cogs: 0, gross: 0 } });
    expect((await get(s.ceo, '/skus/profits?from=2026-11-30&to=2026-11-01')).status).toBe(422);
  });

  it('dòng hàng chưa ghép SKU gộp một dòng variantId null; nhận sự kiện trùng không đếm hai lần', async () => {
    const s = await setup();
    const order = await createOrder(s.companyId, { lines: [{ variantId: s.a.variantId, quantity: 1, unitPrice: 100000 }], source: 'marketplace' });
    const event = {
      packageId: randomUUID(),
      orderId: order.orderId,
      shopId: s.shopId,
      deliveredAt: '2026-11-04T08:00:00Z',
      lines: [{ variantId: null, quantity: 1, unitPrice: '100000', unitCost: null }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    };
    await recordPackageDelivered(s.companyId, event);
    await recordPackageDelivered(s.companyId, event);
    const body = SkuProfitPage.parse((await get(s.ceo, PERIOD)).body);
    expect(body.items).toEqual([
      { variantId: null, sku: null, productName: null, soldQty: 1, net: 93000, cogs: 0, gross: 93000, marginPct: 100, costMissing: true },
    ]);
  });

  it('khách trả hàng: phần giảm giá vốn của đơn chia theo giá vốn dòng hàng', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    await recordReturnInspected(s.companyId, {
      orderId: order.orderId,
      shopId: s.shopId,
      inspectionId: randomUUID(),
      inspectedAt: '2026-11-06T02:00:00Z',
      lines: [{ variantId: s.a.variantId, resellable: 1, unitCost: '60000' }],
    });
    const body = SkuProfitPage.parse((await get(s.ceo, PERIOD)).body);
    expect(body.items.find((i) => i.variantId === s.a.variantId)).toMatchObject({ cogs: -60000 });
  });
});
