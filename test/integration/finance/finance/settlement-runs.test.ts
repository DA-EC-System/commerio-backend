import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformPayout, PlatformTxn } from '#src/modules/finance/finance/domain/settlement.ts';
import { recordPackageDelivered } from '#src/modules/finance/finance/service/ledger.ts';
import { openRun, processRun, runSettlement } from '#src/modules/finance/finance/service/settlement-runs.ts';
import type { FinanceContext } from '#src/modules/finance/finance/service/settlement-views.ts';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';
import { createOrder } from '../../helpers/sales.ts';

// Đối soát quyết toán (#117, Documents/21 §21.2, §21.3). Sàn thay bằng cổng giả trong `ctx`: dữ liệu như sàn giả lập
// #115 (2 áo × 129.000 đ). Giờ cố định 10:00 ngày 05/11/2026 giờ Việt Nam: chỉ giả `Date`.
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
const post = (token: string, path: string, body: object) => request(app).post(`${API}${path}`).set('Authorization', `Bearer ${token}`).send(body);

function fakeSource(txns: () => PlatformTxn[], payouts: () => PlatformPayout[] = () => []): FinanceContext {
  return {
    authorize: () => (_req, _res, next) => next(),
    settlementSource: { transactions: async () => txns(), payouts: async () => payouts(), shops: async () => [] },
  };
}

const EXT = '600000000000001';
const txn = (id: string, feeName: string, transactionType: string, amount: string, externalOrderId: string | null = EXT): PlatformTxn => ({
  txnId: id,
  externalOrderId,
  date: '2026-11-04',
  feeName,
  transactionType,
  amount,
  withholding: '0',
});
/** Quyết toán của đơn 2 áo; `commission` là phí cố định mỗi áo. */
const settlementOf = (prefix: string, commission: string) => [
  txn(`${prefix}1`, 'Item Price Credit', 'Orders-Sales', '129000.00'),
  txn(`${prefix}2`, 'Item Price Credit', 'Orders-Sales', '129000.00'),
  txn(`${prefix}3`, 'Commission', 'Orders-Lazada Fees', commission),
  txn(`${prefix}4`, 'Commission', 'Orders-Lazada Fees', commission),
  txn(`${prefix}5`, 'Payment Fee', 'Orders-Lazada Fees', '-2580.00'),
  txn(`${prefix}6`, 'Payment Fee', 'Orders-Lazada Fees', '-2580.00'),
];

async function config(companyId: string, kind: string, shopId: string | null, payload: object, createdBy: string = randomUUID()) {
  await testPool().query(
    `insert into finance.config_versions (company_id, kind, shop_id, status, payload, effective_from, created_by, approved_by, approved_at)
     values ($1, $2, $3, 'active', $4, '2026-10-01', $5, $6, now())`,
    [companyId, kind, shopId, JSON.stringify(payload), createdBy, randomUUID()],
  );
}

async function setup() {
  const c = await createCompany();
  const shopId = randomUUID();
  const admin = await addMember(c.companyId, 'admin');
  const author = await addMember(c.companyId, 'admin');
  await config(c.companyId, 'fee', shopId, { fixedPct: 4, transactionPct: 2, servicePct: 0, optionalPct: 0, returnFee: 15000 }, author.accountId);
  await config(c.companyId, 'mismatch_threshold', null, { abs: 5000, pct: 1, resolveLimit: 10000 });
  const v = await createVariant(c.companyId);
  const order = await createOrder(c.companyId, { lines: [{ variantId: v.variantId, quantity: 2, unitPrice: 129000 }], source: 'marketplace' });
  await testPool().query(`update "order".orders set shop_id = $1, external_order_id = $2 where id = $3`, [shopId, EXT, order.orderId]);
  return { companyId: c.companyId, ceo: c.ceo.token, admin, author, shopId, order, variantId: v.variantId };
}

async function deliver(s: Awaited<ReturnType<typeof setup>>) {
  await recordPackageDelivered(s.companyId, {
    packageId: randomUUID(),
    orderId: s.order.orderId,
    shopId: s.shopId,
    deliveredAt: '2026-11-01T08:00:00Z',
    lines: [{ variantId: s.variantId, quantity: 2, unitPrice: '129000', unitCost: '60000' }],
    platformSubsidy: '0',
    shippingIncome: '0',
    shippingCost: '0',
  });
}

const settlement = async (companyId: string, orderId: string) =>
  (await testPool().query('select status, estimated_total, settled_total, diff from finance.order_settlements where order_id = $1', [orderId])).rows[0];

describe('kéo quyết toán (§21.3)', () => {
  it('khớp: mỗi khoản một dòng thực tế, nối về dòng ước tính cùng loại, đơn settled; chạy lại không ghi trùng', async () => {
    const s = await setup();
    await deliver(s);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'pending', estimated_total: '242520.00' });

    const ctx = fakeSource(() => settlementOf('A', '-5160.00'));
    const run = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(run).toMatchObject({ status: 'done', lineCount: 6, duplicates: 0 });
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'settled', settled_total: '242520.00', diff: '0.00' });

    const linked = await testPool().query(
      `select a.kind from finance.ledger_entries a join finance.ledger_entries e on e.id = a.replaces_entry_id where a.order_id = $1 order by a.kind`,
      [s.order.orderId],
    );
    expect(linked.rows.map((r) => r.kind).sort()).toEqual(['fee_fixed', 'fee_transaction', 'revenue']);
    const profit = await get(s.ceo, `/orders/${s.order.orderId}/profit`);
    expect(profit.body).toMatchObject({ net: 242520, estimated: false });

    const again = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(again).toMatchObject({ status: 'done', lineCount: 0, duplicates: 6 });
    expect((await get(s.ceo, '/settlement-runs')).body.total).toBe(2);
  });

  it('sàn thu phí của đơn chưa giao kiện nào: mismatch (cancelled_charged)', async () => {
    const s = await setup();
    await runSettlement(fakeSource(() => [txn('C1', 'Commission', 'Orders-Lazada Fees', '-3000.00')]), s.companyId, null, s.shopId);
    expect(await settlement(s.companyId, s.order.orderId)).toMatchObject({ status: 'mismatch', diff: '-3000.00' });
  });

  it('gọi sàn lỗi: lần chạy failed kèm lý do, lần sau kéo lại từ mốc cũ; đang có lần chạy thì 409', async () => {
    const s = await setup();
    const broken = fakeSource(() => {
      throw new Error('sàn không trả lời');
    });
    const failed = await runSettlement(broken, s.companyId, null, s.shopId);
    expect(failed).toMatchObject({ status: 'failed', error: 'sàn không trả lời' });
    const ctx = fakeSource(() => []);
    const open = await openRun(ctx, s.companyId, null, s.shopId);
    expect(open.periodFrom.toISOString()).toBe(failed.periodFrom.toISOString());
    await expect(openRun(ctx, s.companyId, null, s.shopId)).rejects.toMatchObject({ code: 'settlement_running' });
    expect((await processRun(ctx, s.companyId, open.id)).status).toBe('done');
  });

  it('rút tiền: dòng withdrawal không gắn đơn, tổng withdrawn; số dư ví lệch; khớp sao kê một lần', async () => {
    const s = await setup();
    await deliver(s);
    const ctx = fakeSource(
      () => [...settlementOf('W', '-5160.00'), txn('W9', 'Seller Payout', 'Payout', '-200000.00', null)],
      () => [{ statementNumber: 'VN2026W44', createdAt: '2026-11-04', payout: '42520.00', closingBalance: '40000.00', paid: true }],
    );
    const run = await runSettlement(ctx, s.companyId, null, s.shopId);
    expect(run.walletDiff).toBe('-2520.00');
    expect((await get(s.ceo, '/ledger')).body.totals).toMatchObject({ platformBalance: 42520, withdrawn: 200000 });

    const open = await get(s.ceo, '/bank-matching?matched=false');
    expect(open.body.items.map((l: { kind: string; txnId: string }) => [l.kind, l.txnId])).toEqual([['withdrawal', 'W9']]);
    const id = open.body.items[0].id;
    const matched = await post(s.ceo, `/ledger/${id}/bank-match`, { bankRef: 'VCB-0001' });
    expect(matched.status).toBe(200);
    expect(matched.body.bankMatch).toMatchObject({ bankRef: 'VCB-0001' });
    const twice = await post(s.ceo, `/ledger/${id}/bank-match`, { bankRef: 'VCB-0002' });
    expect([twice.status, twice.body.type]).toEqual([409, '/problems/already_matched']);
    expect((await get(s.ceo, '/bank-matching?matched=true')).body.total).toBe(1);
  });
});

describe('trạng thái tiền của đơn và chốt lệch (§21.2)', () => {
  it('lệch quá ngưỡng: mismatch; người soạn phí không chốt được; vượt hạn mức cần CEO duyệt rồi Admin khác chốt', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('M', '-10320.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body).toMatchObject({ status: 'mismatch', diff: -10320, needsCeoApproval: true, feeConfigAuthor: { id: s.author.accountId } });
    expect(p.body.statusHistory.map((h: { to: string }) => h.to)).toEqual(['pending', 'mismatch']);
    expect((await get(s.ceo, '/payments?status=mismatch')).body.counts).toMatchObject({ mismatch: 1 });

    const reason = { version: p.body.version, reason: 'Sàn tính phí cố định 8%' };
    const byAuthor = await post(s.author.token, `/payments/${s.order.orderId}/resolve`, reason);
    expect([byAuthor.status, byAuthor.body.type]).toEqual([409, '/problems/second_person_required']);
    const early = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, reason);
    expect([early.status, early.body.type]).toEqual([409, '/problems/ceo_approval_required']);
    const byAdminApprove = await post(s.admin.token, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect(byAdminApprove.status).toBe(403);

    const approved = await post(s.ceo, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect(approved.body).toMatchObject({ status: 'mismatch', needsCeoApproval: false, ceoApproval: { by: { id: expect.any(String) } } });
    const resolved = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { ...reason, version: approved.body.version });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ status: 'resolved', resolved: { reason: 'Sàn tính phí cố định 8%', by: { id: s.admin.accountId } } });

    // Điều chỉnh muộn trong ngưỡng so với mốc lúc chốt: giữ resolved; quá ngưỡng thì mismatch lại.
    await runSettlement(fakeSource(() => [txn('M7', 'Payment Fee', 'Orders-Lazada Fees', '-1000.00')]), s.companyId, null, s.shopId);
    expect((await settlement(s.companyId, s.order.orderId)).status).toBe('resolved');
    await runSettlement(fakeSource(() => [txn('M8', 'Penalty', 'Other', '-9000.00')]), s.companyId, null, s.shopId);
    expect((await settlement(s.companyId, s.order.orderId)).status).toBe('mismatch');
  });

  it('lệch trong hạn mức tự chốt: Admin chốt ngay; CEO duyệt khi không cần thì 409', async () => {
    const s = await setup();
    await deliver(s);
    await runSettlement(fakeSource(() => settlementOf('S', '-9000.00')), s.companyId, null, s.shopId);
    const p = await get(s.ceo, `/payments/${s.order.orderId}`);
    expect(p.body).toMatchObject({ status: 'mismatch', diff: -7680, needsCeoApproval: false });
    const noNeed = await post(s.ceo, `/payments/${s.order.orderId}/ceo-approve`, { version: p.body.version });
    expect([noNeed.status, noNeed.body.type]).toEqual([409, '/problems/approval_not_needed']);
    const noReason = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: ' ' });
    expect(noReason.status).toBe(422);
    const ok = await post(s.admin.token, `/payments/${s.order.orderId}/resolve`, { version: p.body.version, reason: 'Đã đối chiếu Seller Center' });
    expect(ok.body.status).toBe('resolved');
  });

  it('kéo quyết toán qua API: gian hàng không thuộc công ty thì 404; Sale không xem được trạng thái tiền', async () => {
    const s = await setup();
    const res = await post(s.ceo, '/settlement-runs', { shopId: s.shopId });
    expect([res.status, res.body.type]).toEqual([404, '/problems/not_found']);
    const sale = await addMember(s.companyId, 'sale');
    expect((await get(sale.token, '/payments')).status).toBe(403);
  });
});
