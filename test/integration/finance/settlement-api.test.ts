import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { addMember, createCompany } from '../helpers/company.ts';
import { testPool } from '../helpers/db.ts';
import { login, testApp } from '../helpers/http.ts';
import { setModuleEnabled } from '../helpers/state.ts';
import { ingest, marketplaceOrder, orderTx, statement } from './settlement-helpers.ts';

// API đối soát tiền sàn (Documents/21 §12.6, §12.8; plan #30 lát 6–7: AC-8…AC-14).
const app = testApp();
const API = '/api/v1/finance';

/** Gian hàng sàn giả (#19 chưa có luồng kết nối): dòng `channel.shops` dựng bằng role chủ bảng. */
async function shop(companyId: string, shopName = 'Gian hàng thử') {
  const { rows } = await testPool().query<{ id: string }>(
    `insert into channel.shops (company_id, platform, external_shop_id, shop_name) values ($1, 'mock', $2, $3) returning id`,
    [companyId, `SHOP-${randomUUID().slice(0, 8)}`, shopName],
  );
  return rows[0]!.id;
}

async function company() {
  const c = await createCompany({ optionalModules: ['channel'] });
  const shopId = await shop(c.companyId);
  return { ...c, shopId, auth: `Bearer ${c.ceo.token}` };
}

/** Bảng kê có ba dòng: khớp, không thấy đơn, hoàn tiền; trạng thái trả tiền tuỳ chọn. */
async function seeded(paymentStatus = 'PAID', statementTime = 1760832000) {
  const c = await company();
  const ok = await marketplaceOrder(c.companyId, c.shopId, 100000);
  const refunded = await marketplaceOrder(c.companyId, c.shopId, 200000);
  const st = statement({ payment_status: paymentStatus, statement_time: statementTime, settlement_amount: '186000' });
  const txs = [
    orderTx(ok.externalOrderId, 100000),
    orderTx('SO-khong-co', 50000),
    orderTx(refunded.externalOrderId, 150000, {
      revenue_breakdown: { refund_subtotal_before_discount_amount: '-50000' },
    }),
  ];
  const { statementId } = await ingest(c.companyId, c.shopId, st, txs);
  return { ...c, ok, refunded, st, txs, statementId };
}

describe('GET /finance/settlements (AC-8, AC-9)', () => {
  it('trang bảng kê mới nhất trước, đủ trường SettlementStatement', async () => {
    const c = await seeded();
    const older = statement({ statement_time: 1760745600, settlement_amount: '0' });
    await ingest(c.companyId, c.shopId, older, []);

    const res = await request(app).get(`${API}/settlements`).set('Authorization', c.auth);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(res.body.items.map((s: { externalStatementId: string }) => s.externalStatementId)).toEqual([
      c.st.id,
      older.id,
    ]);
    expect(res.body.items[0]).toEqual({
      id: c.statementId,
      shop: { id: c.shopId, shopName: 'Gian hàng thử', platform: 'mock' },
      externalStatementId: c.st.id,
      statementTime: '2025-10-19T00:00:00.000Z',
      settlementAmount: 186000,
      paymentStatus: 'PAID',
      lineCount: 3,
      matchedCount: 1,
      discrepancyCount: 1,
      refundTaggedCount: 1,
      receiptTotal: 68000 + 118000,
    });
  });

  it('lọc shopId, paymentStatus, from/to theo ngày giờ VN của statementTime', async () => {
    const c = await seeded('PAID', Date.parse('2025-10-19T16:59:59Z') / 1000); // 23:59:59 ngày 19/10 giờ VN
    const q = (s: string) => request(app).get(`${API}/settlements?${s}`).set('Authorization', c.auth);
    expect((await q('from=2025-10-19&to=2025-10-19')).body.total).toBe(1);
    expect((await q('from=2025-10-20')).body.total).toBe(0);
    expect((await q('paymentStatus=PROCESSING')).body.total).toBe(0);
    expect((await q(`shopId=${randomUUID()}`)).body.total).toBe(0);
    expect((await q(`shopId=${c.shopId}`)).body.total).toBe(1);
  });

  it('GET /settlements/:id trả một bảng kê; id công ty khác hoặc sai định dạng → 404', async () => {
    const c = await seeded();
    const other = await company();
    const res = await request(app).get(`${API}/settlements/${c.statementId}`).set('Authorization', c.auth);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: c.statementId, lineCount: 3 });
    for (const id of [c.statementId, 'khong-phai-uuid']) {
      const r = await request(app).get(`${API}/settlements/${id}`).set('Authorization', other.auth);
      expect([r.status, r.body.type]).toEqual([404, '/problems/not_found']);
    }
  });
});

describe('GET /finance/settlement-lines (AC-10)', () => {
  it('dòng đủ trường SettlementLine: đơn, phí, phiếu thu', async () => {
    const c = await seeded();
    const res = await request(app)
      .get(`${API}/settlement-lines?statementId=${c.statementId}`)
      .set('Authorization', c.auth);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    const byTx = new Map(res.body.items.map((l: { externalTransactionId: string }) => [l.externalTransactionId, l]));
    const ok = byTx.get(c.txs[0]!.id) as Record<string, unknown>;
    expect(ok).toMatchObject({
      statementId: c.statementId,
      kind: 'order',
      externalOrderId: c.ok.externalOrderId,
      order: { id: c.ok.orderId, code: expect.any(String) },
      revenue: 100000,
      fees: {
        commission: 10000,
        transactionFee: 6000,
        infrastructureFee: 0,
        affiliate: 0,
        campaign: 0,
        tax: 1000,
        other: 0,
      },
      feeTotal: 17000,
      shippingCost: 15000,
      adjustment: 0,
      settlement: 68000,
      orderTotal: 100000,
      matchStatus: 'matched',
      discrepancyReason: null,
      receipt: { id: expect.any(String), number: expect.stringMatching(/^PT-\d{6}$/) },
      receiptPending: false,
    });
    expect(byTx.get(c.txs[1]!.id)).toMatchObject({
      order: null,
      orderTotal: null,
      matchStatus: 'discrepancy',
      discrepancyReason: 'order_not_found',
      receipt: null,
      receiptPending: false,
    });
    expect(byTx.get(c.txs[2]!.id)).toMatchObject({ matchStatus: 'refund_tagged', order: { id: c.refunded.orderId } });
  });

  it('bảng kê chưa PAID: dòng đủ điều kiện có receiptPending, chưa có phiếu', async () => {
    const c = await seeded('PROCESSING');
    const res = await request(app).get(`${API}/settlement-lines?matchStatus=matched`).set('Authorization', c.auth);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ receipt: null, receiptPending: true });
  });

  it('lọc matchStatus, orderId, shopId, from/to (khi không có statementId)', async () => {
    const c = await seeded();
    const q = async (s: string) =>
      (await request(app).get(`${API}/settlement-lines?${s}`).set('Authorization', c.auth)).body;
    expect((await q('matchStatus=discrepancy')).total).toBe(1);
    expect((await q(`orderId=${c.refunded.orderId}`)).items[0].matchStatus).toBe('refund_tagged');
    expect((await q(`shopId=${randomUUID()}`)).total).toBe(0);
    expect((await q('from=2025-10-20')).total).toBe(0);
    expect((await q('from=2025-10-19&to=2025-10-19')).total).toBe(3);
  });

  it('query sai → 422 theo ô', async () => {
    const c = await company();
    const res = await request(app)
      .get(`${API}/settlement-lines?matchStatus=x&orderId=abc&pageSize=101&from=19-10-2025`)
      .set('Authorization', c.auth);
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['from', 'matchStatus', 'orderId', 'pageSize']);
  });
});

describe('POST /finance/settlements/dev/import (AC-12)', () => {
  const body = (shopId: string, st = statement(), transactions: unknown[] = []) => ({
    shopId,
    statement: st,
    transactions,
  });

  it('nhận bảng kê khuôn OAS: 201 lần đầu, 200 khi đã có, trả SettlementStatement', async () => {
    const c = await company();
    const o = await marketplaceOrder(c.companyId, c.shopId, 100000);
    const b = body(c.shopId, statement(), [orderTx(o.externalOrderId, 100000)]);

    const first = await request(app).post(`${API}/settlements/dev/import`).set('Authorization', c.auth).send(b);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      externalStatementId: b.statement.id,
      lineCount: 1,
      matchedCount: 1,
      receiptTotal: 68000,
    });
    const again = await request(app).post(`${API}/settlements/dev/import`).set('Authorization', c.auth).send(b);
    expect([again.status, again.body.id]).toEqual([200, first.body.id]);
  });

  it('gian hàng không thuộc công ty → 422 errors.shopId', async () => {
    const c = await company();
    const other = await company();
    for (const shopId of [other.shopId, randomUUID()]) {
      const res = await request(app)
        .post(`${API}/settlements/dev/import`)
        .set('Authorization', c.auth)
        .send(body(shopId));
      expect(res.status).toBe(422);
      expect(res.body.errors).toHaveProperty('shopId');
    }
  });

  it('tiền sai định dạng, có phần lẻ, thiếu id, quá 200 giao dịch → 422 theo ô', async () => {
    const c = await company();
    const send = (b: object) => request(app).post(`${API}/settlements/dev/import`).set('Authorization', c.auth).send(b);
    const bad = await send(
      body(c.shopId, statement({ settlement_amount: '1.5' }), [
        orderTx('SO-1', 1000, { revenue_amount: 'abc' }),
        { ...orderTx('SO-2', 1000), id: '' },
      ]),
    );
    expect(bad.status).toBe(422);
    expect(Object.keys(bad.body.errors).sort()).toEqual([
      'statement.settlement_amount',
      'transactions.0.revenue_amount',
      'transactions.1.id',
    ]);
    const many = await send(
      body(
        c.shopId,
        statement(),
        Array.from({ length: 201 }, (_, i) => orderTx(`SO-${i}`, 1000)),
      ),
    );
    expect(many.status).toBe(422);
    expect(many.body.errors).toHaveProperty('transactions');
  });
});

describe('POST /finance/settlements/dev/import: giới hạn (review diff)', () => {
  it('tiền tệ khác VND, tiền vượt numeric(18,2), thời điểm vô lý → 422, không 500', async () => {
    const c = await company();
    const send = (b: object) => request(app).post(`${API}/settlements/dev/import`).set('Authorization', c.auth).send(b);
    const huge = '10000000000000000';
    const res = await send({
      shopId: c.shopId,
      statement: statement({ currency: 'USD' }),
      transactions: [orderTx('SO-1', 1000, { revenue_amount: huge })],
    });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body.errors).sort()).toEqual(['statement.currency', 'transactions.0.revenue_amount']);
    const late = await send({ shopId: c.shopId, statement: statement({ statement_time: 1e15 }), transactions: [] });
    expect([late.status, Object.keys(late.body.errors ?? {})]).toEqual([422, ['statement.statement_time']]);
    const { rowCount } = await testPool().query('select 1 from finance.settlement_statements where company_id = $1', [
      c.companyId,
    ]);
    expect(rowCount).toBe(0);
  });

  it('tiền lớn nhất vừa numeric(18,2) vẫn nhận; currency VND nhận', async () => {
    const c = await company();
    const max = '9999999999999999';
    const res = await request(app)
      .post(`${API}/settlements/dev/import`)
      .set('Authorization', c.auth)
      .send({ shopId: c.shopId, statement: statement({ currency: 'VND', settlement_amount: max }), transactions: [] });
    expect(res.status).toBe(201);
  });
});

describe('quyền, phân hệ, công ty (AC-11, AC-13)', () => {
  const routes = (statementId: string, shopId: string) =>
    [
      ['get', `${API}/settlements`],
      ['get', `${API}/settlements/${statementId}`],
      ['get', `${API}/settlement-lines`],
      ['post', `${API}/settlements/dev/import`, { shopId, statement: statement(), transactions: [] }],
    ] as const;

  it('thiếu token → 401', async () => {
    for (const [method, url] of routes(randomUUID(), randomUUID())) {
      expect((await request(app)[method](url)).status).toBe(401);
    }
  });

  it('token chưa chọn công ty → 403 company_not_selected', async () => {
    const c = await company();
    const { token } = await login(c.ceo.email);
    for (const [method, url] of routes(randomUUID(), c.shopId)) {
      const res = await request(app)[method](url).set('Authorization', `Bearer ${token}`);
      expect([res.status, res.body.type]).toEqual([403, '/problems/company_not_selected']);
    }
  });

  it('Admin, Sale (không có quyền finance) → 403 forbidden trước kiểm dữ liệu', async () => {
    const c = await company();
    for (const role of ['admin', 'sale'] as const) {
      const m = await addMember(c.companyId, role);
      for (const [method, url] of [
        ...routes(randomUUID(), c.shopId),
        ['get', `${API}/settlement-lines?pageSize=999`],
      ] as const) {
        const res = await request(app)[method](url).set('Authorization', `Bearer ${m.token}`).send({});
        expect([res.status, res.body.type]).toEqual([403, '/problems/forbidden']);
      }
    }
  });

  it('công ty tắt Channel → 403 module_disabled trước kiểm dữ liệu', async () => {
    const c = await company();
    await setModuleEnabled(c.companyId, 'channel', false);
    for (const [method, url] of [
      ...routes(randomUUID(), c.shopId),
      ['get', `${API}/settlement-lines?pageSize=999`],
    ] as const) {
      const res = await request(app)[method](url).set('Authorization', c.auth).send({});
      expect([res.status, res.body.type]).toEqual([403, '/problems/module_disabled']);
    }
  });

  it('danh sách không lẫn bảng kê, dòng của công ty khác', async () => {
    const a = await seeded();
    const b = await company();
    expect((await request(app).get(`${API}/settlements`).set('Authorization', b.auth)).body.total).toBe(0);
    const lines = await request(app)
      .get(`${API}/settlement-lines?statementId=${a.statementId}`)
      .set('Authorization', b.auth);
    expect(lines.body.total).toBe(0);
  });
});

describe('Swagger (AC-14)', () => {
  it('openapi.json có 4 đường dẫn đối soát', async () => {
    const res = await request(app).get('/api/openapi.json');
    for (const p of ['/settlements', '/settlements/{id}', '/settlement-lines', '/settlements/dev/import']) {
      expect(res.body.paths).toHaveProperty(`/api/v1/finance${p}`);
    }
  });
});
