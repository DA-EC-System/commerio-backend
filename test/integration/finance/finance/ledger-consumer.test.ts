import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventType } from '#src/modules/core/index.ts';
import { markProcessed } from '#src/modules/core/platform/repository/outbox.ts';
import { HandlerFailure, type IncomingMessage, processMessage, type ProcessDeps } from '#src/modules/core/platform/service/outbox/consumer.ts';
import { LEDGER_CONSUMER, ledgerHandlers, registerLedgerConsumers } from '#src/modules/finance/finance/service/ledger.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Consumer `finance-ledger` của sổ tiền (#228, #229; Documents/21 §11.2, §21.1). Sự kiện tự dựng theo payload của
// danh mục, chạy qua `processMessage` thật với handler như `registerLedgerConsumers`, trong `withCompany` kèm
// `processed_events` như `runShared` của khung. Bên phát `return_refunded` (#202), `return_inspected` (#208),
// `supplier_return_refunded` (#210) chưa merge.
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T03:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
});

const app = testApp();
const get = (token: string, path: string) => request(app).get(`/api/v1/finance${path}`).set('Authorization', `Bearer ${token}`);

type LedgerType = keyof typeof ledgerHandlers;

/** Chạy một sự kiện qua consumer; `eventId` truyền vào để thử giao lại cùng sự kiện. */
async function deliver<T extends LedgerType>(companyId: string, type: T, payload: unknown, eventId = randomUUID()) {
  const envelope = { eventId, type, companyId, aggregateId: randomUUID(), occurredAt: new Date().toISOString(), payload };
  const message: IncomingMessage = {
    topic: `commerio.${type.split('.')[0]}`,
    partition: 0,
    offset: '1',
    key: null,
    headers: { type },
    value: Buffer.from(JSON.stringify(envelope)),
  };
  const deps: ProcessDeps = {
    spec: { consumer: LEDGER_CONSUMER, scope: 'shared', handlers: new Map([[type as EventType, ledgerHandlers[type] as never]]) },
    retryDelaysMs: [],
    runHandler: (e, h) =>
      withCompany(companyId, async () => {
        if (!(await markProcessed(LEDGER_CONSUMER, e.eventId))) return;
        try {
          await h(e);
        } catch (err) {
          throw new HandlerFailure(err);
        }
      }),
    sendToDlq: async (_m, reason) => {
      throw new Error(`DLQ: ${reason}`);
    },
  };
  return processMessage(message, 0, deps);
}

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
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 3, unitPrice: 100000 }], source: 'marketplace' });
  const delivered = (lines: { variantId: string | null; quantity: number; unitPrice: string; unitCost: string | null }[]) => ({
    packageId: randomUUID(),
    orderId: order.orderId,
    shopId,
    deliveredAt: '2026-11-04T08:00:00.000Z',
    lines,
    platformSubsidy: '0.00',
    shippingIncome: '0.00',
    shippingCost: '0.00',
  });
  return { companyId: c.companyId, ceo: c.ceo.token, shopId, order, variantId: v.variantId, delivered };
}

async function rows(companyId: string) {
  const { rows: r } = await testPool().query<{ kind: string; amount: string; is_estimate: boolean; source_type: string }>(
    'select kind, amount, is_estimate, source_type from finance.ledger_entries where company_id = $1 order by kind::text',
    [companyId],
  );
  return r;
}

describe('consumer finance-ledger (§11.2)', () => {
  it('đăng ký được mọi loại sổ tiền nghe: loại nào thiếu trong danh mục thì ném', () => {
    expect(() => registerLedgerConsumers()).not.toThrow();
  });

  it('D41-04: package_delivered ghi bộ dòng ước tính; giao lại cùng eventId hay eventId khác cùng kiện không thêm dòng', async () => {
    const s = await setup();
    const pkg = s.delivered([{ variantId: s.variantId, quantity: 2, unitPrice: '100000.00', unitCost: '60000.00' }]);
    const eventId = randomUUID();
    expect(await deliver(s.companyId, 'fulfillment.package_delivered', pkg, eventId)).toEqual({ kind: 'done' });
    const first = await rows(s.companyId);
    expect(first.map((r) => [r.kind, r.amount])).toEqual([
      ['cogs', '-120000.00'],
      ['fee_fixed', '-8000.00'],
      ['fee_service', '-2000.00'],
      ['fee_transaction', '-4000.00'],
      ['revenue', '200000.00'],
    ]);
    await deliver(s.companyId, 'fulfillment.package_delivered', pkg, eventId);
    await deliver(s.companyId, 'fulfillment.package_delivered', pkg);
    expect(await rows(s.companyId)).toHaveLength(first.length);
    const { rows: seen } = await testPool().query('select 1 from core.processed_events where consumer = $1 and event_id = $2', [LEDGER_CONSUMER, eventId]);
    expect(seen).toHaveLength(1);
  });

  it('D41-05: dòng unitCost null (chưa ghép SKU hoặc bàn giao trước mốc lấy đơn) không vào giá vốn; lãi đơn costMissing', async () => {
    const s = await setup();
    const pkg = s.delivered([
      { variantId: s.variantId, quantity: 1, unitPrice: '100000.00', unitCost: '60000.00' },
      { variantId: null, quantity: 2, unitPrice: '100000.00', unitCost: null },
    ]);
    await deliver(s.companyId, 'fulfillment.package_delivered', pkg);
    const byKind = Object.fromEntries((await rows(s.companyId)).map((r) => [r.kind, r.amount]));
    expect([byKind.revenue, byKind.cogs]).toEqual(['300000.00', '-60000.00']);
    const profit = await get(s.ceo, `/orders/${s.order.orderId}/profit`);
    expect(profit.body).toMatchObject({ cogs: -60000, costMissing: true, estimated: true });
    // Kiện sau đủ giá vốn không xoá dấu thiếu của đơn.
    await deliver(s.companyId, 'fulfillment.package_delivered', s.delivered([{ variantId: s.variantId, quantity: 1, unitPrice: '1.00', unitCost: '1.00' }]));
    expect((await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body.costMissing).toBe(true);
    const admin = await addMember(s.companyId, 'admin');
    expect((await get(admin.token, `/orders/${s.order.orderId}/profit`)).body).toMatchObject({ cogs: null, gross: null, costMissing: true });
  });

  it('D41-05b: đơn mọi dòng có giá vốn, hoặc chưa giao kiện nào: costMissing false', async () => {
    const s = await setup();
    expect((await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body.costMissing).toBe(false);
    await deliver(s.companyId, 'fulfillment.package_delivered', s.delivered([{ variantId: s.variantId, quantity: 1, unitPrice: '100000.00', unitCost: '60000.00' }]));
    expect((await get(s.ceo, `/orders/${s.order.orderId}/profit`)).body.costMissing).toBe(false);
  });

  it('D41-06: package_returned ghi phí khi hoàn theo cấu hình của gian hàng, một lần', async () => {
    const s = await setup();
    const returned = { packageId: randomUUID(), orderId: s.order.orderId, shopId: s.shopId, returnedAt: '2026-11-04T09:00:00.000Z' };
    await deliver(s.companyId, 'fulfillment.package_returned', returned);
    await deliver(s.companyId, 'fulfillment.package_returned', returned);
    expect((await rows(s.companyId)).map((r) => [r.kind, r.amount])).toEqual([['return_fee', '-15000.00']]);
  });

  it('D41-07: return_refunded ghi hoàn tiền khách; return_inspected chỉ giảm giá vốn dòng có giá vốn', async () => {
    const s = await setup();
    const base = { orderId: s.order.orderId, shopId: s.shopId };
    await deliver(s.companyId, 'sales.return_refunded', { ...base, returnRequestId: randomUUID(), refundAmount: '100000.00', refundedAt: '2026-11-05T02:00:00.000Z' });
    const inspected = {
      ...base,
      inspectionId: randomUUID(),
      inspectedAt: '2026-11-05T02:30:00.000Z',
      lines: [
        { variantId: s.variantId, resellable: 1, unitCost: '60000.00' },
        { variantId: randomUUID(), resellable: 2, unitCost: null },
      ],
    };
    await deliver(s.companyId, 'inventory.return_inspected', inspected);
    await deliver(s.companyId, 'inventory.return_inspected', inspected);
    expect((await rows(s.companyId)).map((r) => [r.kind, r.amount])).toEqual([
      ['cogs_reversal', '60000.00'],
      ['customer_refund', '-100000.00'],
    ]);
  });

  it('D41-08: supplier_return_refunded ghi dòng thực tế supplier_refund không gắn đơn, hiện ở khớp sao kê; phát lại không trùng', async () => {
    const s = await setup();
    const refund = { supplierReturnId: randomUUID(), supplierId: randomUUID(), refundAmount: '120000.00', recordedAt: '2026-11-05T01:00:00.000Z' };
    await deliver(s.companyId, 'purchasing.supplier_return_refunded', refund);
    await deliver(s.companyId, 'purchasing.supplier_return_refunded', refund);
    expect(await rows(s.companyId)).toEqual([{ kind: 'supplier_refund', amount: '120000.00', is_estimate: false, source_type: 'supplier_return' }]);
    const matching = await get(s.ceo, '/bank-matching?kind=supplier_refund');
    expect(matching.body.items).toMatchObject([{ kind: 'supplier_refund', amount: 120000, orderId: null, shopId: null, estimated: false }]);
    // Không lẫn vào tiền đang ở sàn.
    expect((await get(s.ceo, '/ledger')).body.totals).toMatchObject({ receivable: 0, platformBalance: 0 });
    // Không lẫn vào lãi 30 ngày của chạy thử cấu hình thuế.
    const auth = `Bearer ${s.ceo}`;
    const draft = await request(app).post('/api/v1/finance/configs').set('Authorization', auth).send({ kind: 'tax_regime', payload: { regime: 'household' }, effectiveFrom: '2026-12-01' });
    const dry = await request(app).post(`/api/v1/finance/configs/${draft.body.id}/dry-run`).set('Authorization', auth).send({ version: draft.body.version });
    expect(dry.body.dryRun.profit30).toMatchObject({ now: 0 });
  });
});
