import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { api, type Role } from './lib/client.ts';
import { expectProblem, ruleViolations, served } from './lib/contract.ts';

// Tiền theo sổ dòng (Documents/21 §21, ca D4.x của Documents/26 §3.3). Server chưa có route (#116–#118 chưa merge)
// thì bỏ qua cả nhóm. Ca cần sàn (lệch tiền, kéo quyết toán thật) ở test integration và sàn giả lập #115.

const tokens = inject('tokens');
const fin = (role: Role) => api(tokens[role]);
const REASON = { reason: 'Kiểm thử hộp đen' };

/** Ngày hiệu lực xa trong tương lai, khác nhau mỗi lần chạy: ô cấu hình trên server giữ dữ liệu các lần trước. */
const farDay = () => new Date(Date.UTC(2200, 0, 1) + Math.floor(Math.random() * 300_000) * 86_400_000).toISOString().slice(0, 10);
const threshold = { abs: 5000, pct: 1, resolveLimit: 50000 };
const created: string[] = [];

async function draft(role: Role, effectiveFrom = farDay()) {
  const res = await fin(role).post('/finance/configs', { kind: 'mismatch_threshold', payload: threshold, effectiveFrom });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  created.push(res.body.id);
  return res.body as { id: string; version: number; status: string; effectiveFrom: string };
}

async function step(role: Role, id: string, path: string, body: Record<string, unknown>) {
  const res = await fin(role).post(`/finance/configs/${id}/${path}`, body);
  expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
  return res.body as { version: number; status: string };
}

/** Nháp đã chạy thử rồi gửi duyệt. */
async function pending(role: Role) {
  const d = await draft(role);
  const tried = await step(role, d.id, 'dry-run', { version: d.version });
  const sent = await step(role, d.id, 'submit', { version: tried.version });
  return { id: d.id, version: sent.version, effectiveFrom: d.effectiveFrom };
}

// Không để bản `scheduled` của lần chạy này chiếm dòng thời gian của ô cho lần sau.
afterAll(async () => {
  for (const id of created) {
    const cur = await fin('ceo').get(`/finance/configs/${id}`);
    if (['draft', 'pending_approval', 'scheduled'].includes(cur.body?.status)) {
      await fin('ceo').post(`/finance/configs/${id}/cancel`, { version: cur.body.version, ...REASON });
    }
  }
});

describe.runIf(await served('GET /finance/configs'))('D4.4 phiên bản cấu hình tiền (§21.4)', () => {
  it('D44-01: chưa chạy thử thì gửi duyệt nhận 422 dry_run_required; chạy thử rồi gửi thì pending_approval', async () => {
    const d = await draft('admin');
    expectProblem(await fin('admin').post(`/finance/configs/${d.id}/submit`, { version: d.version }), 422, 'dry_run_required');
    const tried = await step('admin', d.id, 'dry-run', { version: d.version });
    expect(ruleViolations(tried)).toEqual([]);
    expect((await step('admin', d.id, 'submit', { version: tried.version })).status).toBe('pending_approval');
  });

  it('D44-03: CEO duyệt bản Admin soạn: scheduled, lịch sử ghi người duyệt; Admin không có quyền duyệt nhận 403', async () => {
    const p = await pending('admin');
    expectProblem(await fin('admin').post(`/finance/configs/${p.id}/approve`, { version: p.version }), 403, 'forbidden');
    const approved = await fin('ceo').post(`/finance/configs/${p.id}/approve`, { version: p.version });
    expect(approved.body).toMatchObject({ status: 'scheduled', selfApproved: false, approvedBy: { id: expect.any(String) } });
    expect(approved.body.statusHistory.at(-1)).toMatchObject({ from: 'pending_approval', to: 'scheduled', source: 'user' });
    expect(ruleViolations(approved.body)).toEqual([]);
  });

  it('D44-03p: người lập có quyền duyệt (không phải CEO) tự duyệt nhận 409 second_person_required', async () => {
    const p = await pending('lead');
    expectProblem(await fin('lead').post(`/finance/configs/${p.id}/approve`, { version: p.version }), 409, 'second_person_required');
  });

  it('D44-03s: CEO tự soạn tự duyệt được, ghi selfApproved', async () => {
    const p = await pending('ceo');
    const approved = await step('ceo', p.id, 'approve', { version: p.version });
    expect(approved).toMatchObject({ status: 'scheduled', selfApproved: true });
  });

  it('D44-02: trả về cần lý do (422 reason_required), có lý do thì về draft', async () => {
    const p = await pending('admin');
    expectProblem(await fin('ceo').post(`/finance/configs/${p.id}/request-changes`, { version: p.version }), 422, 'reason_required');
    expect((await step('ceo', p.id, 'request-changes', { version: p.version, ...REASON })).status).toBe('draft');
  });

  it('D44-04: từ chối có lý do thì rejected; rejected không gửi lại được (409 invalid_transition)', async () => {
    const p = await pending('admin');
    const rejected = await step('ceo', p.id, 'reject', { version: p.version, ...REASON });
    expect(rejected.status).toBe('rejected');
    expectProblem(await fin('admin').post(`/finance/configs/${p.id}/submit`, { version: rejected.version }), 409, 'invalid_transition');
  });

  it('D44-05: huỷ bản scheduled trước ngày hiệu lực thì cancelled', async () => {
    const p = await pending('admin');
    const approved = await step('ceo', p.id, 'approve', { version: p.version });
    expect((await step('ceo', p.id, 'cancel', { version: approved.version, ...REASON })).status).toBe('cancelled');
  });

  it('D44-08: bản thứ hai cùng ô, cùng ngày hiệu lực với bản đã duyệt bị chặn 409 config_overlap (lúc gửi hoặc lúc duyệt)', async () => {
    const first = await pending('admin');
    await step('ceo', first.id, 'approve', { version: first.version });
    const second = await draft('admin', first.effectiveFrom);
    const tried = await step('admin', second.id, 'dry-run', { version: second.version });
    const sent = await fin('admin').post(`/finance/configs/${second.id}/submit`, { version: tried.version });
    const blocked = sent.status === 200 ? await fin('ceo').post(`/finance/configs/${second.id}/approve`, { version: sent.body.version }) : sent;
    expectProblem(blocked, 409, 'config_overlap');
  });

  it('D44-V: payload sai nhận 422 kèm lỗi theo ô payload.<trường>', async () => {
    const res = await fin('admin').post('/finance/configs', { kind: 'mismatch_threshold', payload: { abs: -1, pct: 1, resolveLimit: 0 }, effectiveFrom: farDay() });
    expectProblem(res, 422, 'validation_failed');
    expect(Object.keys(res.body.errors)).toContain('payload.abs');
  });

  it('D44-Q: Sale, Kho không xem được cấu hình (403 forbidden)', async () => {
    expectProblem(await fin('sale').get('/finance/configs'), 403, 'forbidden');
    expectProblem(await fin('kho').get('/finance/configs'), 403, 'forbidden');
  });
});

describe.runIf(await served('GET /finance/ledger'))('D4.1 sổ tiền (§21.1)', () => {
  it('D41-01: danh sách dòng là Page kèm totals, tiền là số nguyên đồng', async () => {
    const res = await fin('ceo').get('/finance/ledger?pageSize=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: expect.any(Array), page: 1, pageSize: 5 });
    expect(Object.keys(res.body.totals).sort()).toEqual(['committedPurchase', 'platformBalance', 'receivable', 'withdrawn']);
    expect(ruleViolations(res.body)).toEqual([]);
  });

  it('D41-02: lãi của đơn không có hoặc của công ty khác nhận 404', async () => {
    expectProblem(await fin('ceo').get(`/finance/orders/${randomUUID()}/profit`), 404, 'not_found');
  });

  it('D41-03: cảnh báo mốc thuế trả { items }', async () => {
    const res = await fin('ceo').get('/finance/tax-warnings');
    expect([res.status, Array.isArray(res.body.items)]).toEqual([200, true]);
  });
});

describe.runIf(await served('GET /finance/payments'))('D4.2, D4.3 trạng thái tiền, đối soát (§21.2, §21.3)', () => {
  it('D42-L: danh sách trạng thái tiền là Page kèm counts; Sale không xem được', async () => {
    const res = await fin('ceo').get('/finance/payments');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ items: expect.any(Array), counts: expect.any(Object) });
    expect(ruleViolations(res.body)).toEqual([]);
    expectProblem(await fin('sale').get('/finance/payments'), 403, 'forbidden');
  });

  it('D42-06: chốt lệch, CEO duyệt đơn không có nhận 404', async () => {
    const id = randomUUID();
    expectProblem(await fin('ceo').post(`/finance/payments/${id}/resolve`, { version: 1, reason: 'x' }), 404, 'not_found');
    expectProblem(await fin('ceo').post(`/finance/payments/${id}/ceo-approve`, { version: 1 }), 404, 'not_found');
  });

  it('D43-01: kéo quyết toán gian hàng không thuộc công ty nhận 404; tệp báo cáo chưa hỗ trợ (422)', async () => {
    expectProblem(await fin('ceo').post('/finance/settlement-runs', { shopId: randomUUID() }), 404, 'not_found');
    const file = await fin('ceo').post('/finance/settlement-runs', { shopId: randomUUID(), fileId: randomUUID() });
    expect([404, 422]).toContain(file.status);
    const runs = await fin('ceo').get('/finance/settlement-runs');
    expect(runs.body).toMatchObject({ items: expect.any(Array), page: 1 });
  });

  it('D43-02: khớp sao kê dòng không có nhận 404; danh sách cần khớp là Page', async () => {
    expectProblem(await fin('ceo').post(`/finance/ledger/${randomUUID()}/bank-match`, { bankRef: 'VCB-QA' }), 404, 'not_found');
    const res = await fin('ceo').get('/finance/bank-matching?matched=false');
    expect(res.body).toMatchObject({ items: expect.any(Array), total: expect.any(Number) });
  });
});
