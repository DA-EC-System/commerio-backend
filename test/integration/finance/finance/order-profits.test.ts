import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrderProfitPage } from '#src/modules/finance/finance/api/ledger-schemas.ts';
import { recordPackageDelivered, recordReturnInspected, recordReturnRefunded } from '#src/modules/finance/finance/service/ledger.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Lãi theo danh sách đơn (#231; Documents/21 §21.1, 25 §10.2; AC US-TI-04, Documents/27 mục 6.8: chưa có mã ca).
// Ghi sổ bằng hàm ghi theo sự kiện như ledger.test.ts; số quyết toán chèn thẳng dòng thực tế bằng role chủ bảng.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const get = (token: string, path: string) => request(app).get(`/api/v1/finance${path}`).set('Authorization', `Bearer ${token}`);
const PERIOD = '/orders/profits?from=2026-11-01&to=2026-11-30';

async function activeConfig(companyId: string, kind: string, shopId: string | null, payload: object) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
    [companyId, kind, shopId, JSON.stringify(payload), randomUUID(), randomUUID()],
  );
}

/** Kiện đã giao trong fulfillment (để có `deliveredAt`), ghi thẳng bằng role chủ bảng. */
async function deliveredPackage(companyId: string, orderId: string, shopId: string, deliveredAt: string) {
  const id = randomUUID();
  await testPool().query(
    `insert into "order".packages (id, company_id, code, order_id, shop_id, status, handed_over_at, handover_source, delivered_at)
     values ($1, $2, $3, $4, $5, 'delivered', $6, 'marketplace', $6)`,
    [id, companyId, `K-${id.slice(0, 8)}`, orderId, shopId, deliveredAt],
  );
  return id;
}

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  // Phí 7% doanh thu, chưa có thuế khấu trừ (doanh nghiệp): số dễ đọc.
  await activeConfig(c.companyId, 'fee', shopId, { fixedPct: 4, transactionPct: 2, servicePct: 1, optionalPct: 0, returnFee: 15000 });
  await activeConfig(c.companyId, 'tax_regime', null, { regime: 'company' });
  const v = await createVariant(c.companyId);
  const admin = await addMember(c.companyId, 'admin');
  return { companyId: c.companyId, ceo: c.ceo.token, admin: admin.token, shopId, variantId: v.variantId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Đơn sàn có một kiện giao xong: 2 × 100.000đ, giá vốn 60.000đ một món (hoặc thiếu giá vốn). */
async function deliveredOrder(s: Setup, opts: { deliveredAt?: string; shopId?: string; unitCost?: string | null; withPackage?: boolean } = {}) {
  const order = await createOrder(s.companyId, { lines: [{ variantId: s.variantId, quantity: 2, unitPrice: 100000 }], source: 'marketplace' });
  const deliveredAt = opts.deliveredAt ?? '2026-11-04T08:00:00Z';
  const shopId = opts.shopId ?? s.shopId;
  const packageId = opts.withPackage ? await deliveredPackage(s.companyId, order.orderId, shopId, deliveredAt) : randomUUID();
  await recordPackageDelivered(s.companyId, {
    packageId,
    orderId: order.orderId,
    shopId,
    deliveredAt,
    lines: [{ variantId: s.variantId, quantity: 2, unitPrice: '100000', unitCost: opts.unitCost === undefined ? '60000' : opts.unitCost }],
    platformSubsidy: '0',
    shippingIncome: '0',
    shippingCost: '0',
  });
  return order;
}

/** Quyết toán của sàn về cho đơn: dòng thực tế doanh thu và phí (đơn đã có số thật thì mọi dòng ước tính coi như đã thay). */
async function settle(s: Setup, orderId: string, revenue: number, fee: number) {
  for (const [kind, amount] of [
    ['revenue', revenue],
    ['fee_fixed', -fee],
  ] as const) {
    await testPool().query(
      `insert into finance.ledger_entries (company_id, kind, amount, is_estimate, occurred_on, order_id, shop_id, source_type, external_transaction_id)
       values ($1, $2, $3, false, '2026-11-08', $4, $5, 'settlement_batch', $6)`,
      [s.companyId, kind, amount, orderId, s.shopId, randomUUID()],
    );
  }
}

describe('GET /finance/orders/profits (§21.1)', () => {
  it('US-TI-04 dòng 1: đơn 2 kiện mới giao 1 kiện chỉ tính phần đã giao, nhãn Ước tính; khớp lãi của đơn', async () => {
    const s = await setup();
    const order = await createOrder(s.companyId, { lines: [{ variantId: s.variantId, quantity: 2, unitPrice: 100000 }], source: 'marketplace' });
    const packageId = await deliveredPackage(s.companyId, order.orderId, s.shopId, '2026-11-04T08:00:00Z');
    await recordPackageDelivered(s.companyId, {
      packageId,
      orderId: order.orderId,
      shopId: s.shopId,
      deliveredAt: '2026-11-04T08:00:00Z',
      lines: [{ variantId: s.variantId, quantity: 1, unitPrice: '100000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    const res = await get(s.ceo, PERIOD);
    expect(res.status).toBe(200);
    const body = OrderProfitPage.parse(res.body);
    expect(body.items).toEqual([
      {
        orderId: order.orderId,
        code: order.code,
        shopId: s.shopId,
        deliveredAt: '2026-11-04T08:00:00.000Z',
        net: 93000,
        cogs: -60000,
        gross: 33000,
        marginPct: 35.5,
        estimated: true,
        costMissing: false,
        belowFloor: false,
      },
    ]);
    expect(body.totals).toEqual({ net: 93000, cogs: -60000, gross: 33000 });
    const single = await get(s.ceo, `/orders/${order.orderId}/profit`);
    expect(single.body).toMatchObject({ net: 93000, cogs: -60000, gross: 33000, estimated: true });
  });

  it('US-TI-04 dòng 2: đơn đã quyết toán bỏ nhãn Ước tính, số theo dòng thực tế', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    await settle(s, order.orderId, 200000, 15000);
    const [item] = (await get(s.ceo, PERIOD)).body.items;
    expect(item).toMatchObject({ net: 185000, cogs: -120000, gross: 65000, estimated: false });
    // Giá vốn không do sàn quyết toán: số quyết toán không thay dòng giá vốn, lãi của một đơn cùng số.
    const single = (await get(s.ceo, `/orders/${order.orderId}/profit`)).body;
    expect(single).toMatchObject({ net: 185000, cogs: -120000, gross: 65000, estimated: false });
    expect((await get(s.ceo, `/ledger?orderId=${order.orderId}&filter=replaced`)).body.items.map((l: { kind: string }) => l.kind).sort()).toEqual([
      'fee_fixed',
      'fee_service',
      'fee_transaction',
      'revenue',
    ]);
  });

  it('hoàn tiền khách trừ vào thực nhận của đơn', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    await recordReturnRefunded(s.companyId, {
      returnRequestId: randomUUID(),
      orderId: order.orderId,
      shopId: s.shopId,
      refundAmount: '100000',
      refundedAt: '2026-11-06T02:00:00Z',
    });
    expect((await get(s.ceo, PERIOD)).body.items[0]).toMatchObject({ net: 86000 });
  });

  it('US-TI-04 dòng 5: lãi thực dưới giá thấp nhất (giá vốn × (1 + lãi tối thiểu)) thì bật cờ; đơn còn ước tính không bật', async () => {
    const s = await setup();
    await activeConfig(s.companyId, 'min_margin', null, { pct: 10 });
    // Giá vốn 120.000đ, giá thấp nhất 132.000đ.
    const low = await deliveredOrder(s);
    await settle(s, low.orderId, 140000, 10000); // thực nhận 130.000 < 132.000
    const ok = await deliveredOrder(s);
    await settle(s, ok.orderId, 150000, 10000); // thực nhận 140.000 ≥ 132.000
    const estimatedLow = await deliveredOrder(s);
    await recordReturnRefunded(s.companyId, {
      returnRequestId: randomUUID(),
      orderId: estimatedLow.orderId,
      shopId: s.shopId,
      refundAmount: '100000',
      refundedAt: '2026-11-06T02:00:00Z',
    }); // ước tính 86.000 < 132.000 nhưng chưa quyết toán
    const all = (await get(s.ceo, PERIOD)).body.items as { orderId: string; belowFloor: boolean }[];
    expect(Object.fromEntries(all.map((i) => [i.orderId, i.belowFloor]))).toEqual({
      [low.orderId]: true,
      [ok.orderId]: false,
      [estimatedLow.orderId]: false,
    });
    const flagged = (await get(s.ceo, `${PERIOD}&belowFloor=true`)).body;
    expect(flagged.items.map((i: { orderId: string }) => i.orderId)).toEqual([low.orderId]);
    expect(flagged.totals).toEqual({ net: 130000, cogs: -120000, gross: 10000 });
    expect((await get(s.ceo, `${PERIOD}&belowFloor=false`)).body.total).toBe(2);
  });

  it('chưa có cấu hình lãi tối thiểu thì không bật cờ Dưới giá thấp nhất', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    await settle(s, order.orderId, 100000, 10000); // lỗ so với giá vốn
    expect((await get(s.ceo, PERIOD)).body.items[0]).toMatchObject({ gross: -30000, belowFloor: false });
  });

  it('US-TI-04 dòng 6: Admin thấy thực nhận, không thấy giá vốn, lãi gộp (R4: khoá có mặt, giá trị null)', async () => {
    const s = await setup();
    await deliveredOrder(s);
    const res = await get(s.admin, PERIOD);
    expect(res.status).toBe(200);
    const body = OrderProfitPage.parse(res.body);
    expect(body.items[0]).toMatchObject({ net: 186000, cogs: null, gross: null, marginPct: null });
    expect(body.totals).toEqual({ net: 186000, cogs: null, gross: null });
  });

  it('lọc theo ngày giao, gian hàng, thiếu giá vốn; tổng tính trên toàn bộ kết quả lọc, không chỉ trang', async () => {
    const s = await setup();
    const a = await deliveredOrder(s, { deliveredAt: '2026-11-03T08:00:00Z' });
    const b = await deliveredOrder(s, { deliveredAt: '2026-11-05T08:00:00Z', unitCost: null });
    // 31/10 23:30 giờ VN là 31/10, ngoài kỳ; 30/11 18:00 UTC là 01/12 giờ VN, ngoài kỳ.
    await deliveredOrder(s, { deliveredAt: '2026-10-31T16:30:00Z' });
    await deliveredOrder(s, { deliveredAt: '2026-11-30T18:00:00Z' });
    const otherShop = randomUUID();
    await activeConfig(s.companyId, 'fee', otherShop, { fixedPct: 0, transactionPct: 0, servicePct: 0, optionalPct: 0, returnFee: 0 });
    const c = await deliveredOrder(s, { deliveredAt: '2026-11-06T08:00:00Z', shopId: otherShop });

    const page1 = (await get(s.ceo, `${PERIOD}&pageSize=1`)).body;
    expect(page1).toMatchObject({ total: 3, page: 1, pageSize: 1 });
    expect(page1.items.map((i: { orderId: string }) => i.orderId)).toEqual([c.orderId]);
    // a: 186.000 / −120.000; b: 186.000 / 0 (thiếu giá vốn); c: 200.000 / −120.000.
    expect(page1.totals).toEqual({ net: 572000, cogs: -240000, gross: 332000 });
    expect((await get(s.ceo, `${PERIOD}&page=2&pageSize=1`)).body.items[0].orderId).toBe(b.orderId);

    const byShop = (await get(s.ceo, `${PERIOD}&shopId=${s.shopId}`)).body;
    expect(byShop.items.map((i: { orderId: string }) => i.orderId)).toEqual([b.orderId, a.orderId]);
    const missing = (await get(s.ceo, `${PERIOD}&costMissing=true`)).body;
    expect(missing.items).toMatchObject([{ orderId: b.orderId, costMissing: true, cogs: 0 }]);
    expect((await get(s.ceo, '/orders/profits?from=2026-11-04&to=2026-11-04')).body.total).toBe(0);
    expect((await get(s.ceo, '/orders/profits?from=2026-11-05&to=2026-11-05')).body.items[0].orderId).toBe(b.orderId);
  });

  it('đơn chưa giao kiện nào không có trong danh sách', async () => {
    const s = await setup();
    await createOrder(s.companyId, { lines: [{ variantId: s.variantId, quantity: 1, unitPrice: 100000 }], source: 'marketplace' });
    expect((await get(s.ceo, PERIOD)).body).toEqual({ items: [], totals: { net: 0, cogs: 0, gross: 0 }, total: 0, page: 1, pageSize: 20 });
  });

  it('thiếu kỳ, kỳ ngược, cờ sai trả 422; Sale 403; công ty khác không thấy đơn', async () => {
    const s = await setup();
    await deliveredOrder(s);
    for (const path of ['/orders/profits', '/orders/profits?from=2026-11-30&to=2026-11-01', `${PERIOD}&belowFloor=yes`]) {
      const res = await get(s.ceo, path);
      expect([res.status, res.body.type]).toEqual([422, '/problems/validation_failed']);
    }
    const sale = await addMember(s.companyId, 'sale');
    expect((await get(sale.token, PERIOD)).status).toBe(403);
    const other = await setup();
    expect((await get(other.ceo, PERIOD)).body.total).toBe(0);
  });
});

describe('dòng ghi sau lần quyết toán đầu (#231)', () => {
  it('khách trả hàng sau quyết toán: hoàn tiền ước tính và giảm giá vốn đều tính', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    await settle(s, order.orderId, 200000, 15000);
    const base = { orderId: order.orderId, shopId: s.shopId };
    await recordReturnRefunded(s.companyId, { ...base, returnRequestId: randomUUID(), refundAmount: '100000', refundedAt: '2026-11-09T02:00:00Z' });
    await recordReturnInspected(s.companyId, {
      ...base,
      inspectionId: randomUUID(),
      inspectedAt: '2026-11-09T03:00:00Z',
      lines: [{ variantId: s.variantId, resellable: 1, unitCost: '60000' }],
    });
    const expected = { net: 85000, cogs: -60000, gross: 25000, estimated: true };
    expect((await get(s.ceo, PERIOD)).body.items[0]).toMatchObject(expected);
    expect((await get(s.ceo, `/orders/${order.orderId}/profit`)).body).toMatchObject(expected);
  });

  it('kiện 2 giao sau quyết toán: doanh thu, phí của kiện 2 vẫn tính, không bật Dưới giá thấp nhất oan', async () => {
    const s = await setup();
    await activeConfig(s.companyId, 'min_margin', null, { pct: 10 });
    const order = await deliveredOrder(s);
    await settle(s, order.orderId, 200000, 15000);
    await recordPackageDelivered(s.companyId, {
      packageId: randomUUID(),
      orderId: order.orderId,
      shopId: s.shopId,
      deliveredAt: '2026-11-09T08:00:00Z',
      lines: [{ variantId: s.variantId, quantity: 1, unitPrice: '100000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    // 185.000 thực tế + 93.000 ước tính của kiện 2; giá vốn 180.000, giá thấp nhất 198.000.
    const expected = { net: 278000, cogs: -180000, gross: 98000, estimated: true };
    expect((await get(s.ceo, PERIOD)).body.items[0]).toMatchObject({ ...expected, belowFloor: false });
    expect((await get(s.ceo, `/orders/${order.orderId}/profit`)).body).toMatchObject(expected);
  });

  it('sàn quyết toán trước khi app thấy kiện giao (E139): số quyết toán là số thật của cả đơn', async () => {
    const s = await setup();
    const order = await createOrder(s.companyId, { lines: [{ variantId: s.variantId, quantity: 2, unitPrice: 100000 }], source: 'marketplace' });
    await settle(s, order.orderId, 200000, 15000);
    await recordPackageDelivered(s.companyId, {
      packageId: randomUUID(),
      orderId: order.orderId,
      shopId: s.shopId,
      deliveredAt: '2026-11-09T08:00:00Z',
      lines: [{ variantId: s.variantId, quantity: 2, unitPrice: '100000', unitCost: '60000' }],
      platformSubsidy: '0',
      shippingIncome: '0',
      shippingCost: '0',
    });
    expect((await get(s.ceo, PERIOD)).body.items[0]).toMatchObject({ net: 185000, cogs: -120000, gross: 65000, estimated: false });
  });
});

describe('nhãn Ước tính của dòng giá vốn (US-TI-04 dòng 2)', () => {
  it('dòng giá vốn không mang nhãn Ước tính: thuộc lọc thực tế, không thuộc lọc ước tính', async () => {
    const s = await setup();
    const order = await deliveredOrder(s);
    const kinds = async (filter: string) =>
      ((await get(s.ceo, `/ledger?orderId=${order.orderId}&filter=${filter}`)).body.items as { kind: string; estimated: boolean }[]).map((l) => [l.kind, l.estimated]);
    expect(await kinds('estimated')).not.toContainEqual(['cogs', true]);
    expect((await kinds('estimated')).map(([k]) => k)).not.toContain('cogs');
    expect(await kinds('actual')).toEqual([['cogs', false]]);
    await settle(s, order.orderId, 200000, 15000);
    expect(await kinds('estimated')).toEqual([]);
    expect((await kinds('actual')).map(([k]) => k).sort()).toEqual(['cogs', 'fee_fixed', 'revenue']);
  });
});
