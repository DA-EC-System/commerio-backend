import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays } from '#src/modules/finance/finance/domain/config-version.ts';
import { activateDueConfigs, getEffectiveConfig } from '#src/modules/finance/finance/service/config-versions.ts';
import { withCompany } from '#src/shared/db/client.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { testPool } from '../../helpers/db.ts';
import { testApp } from '../../helpers/http.ts';

// Phiên bản cấu hình tiền (#118, Documents/21 §21.4). Giờ cố định 10:00 ngày TODAY giờ Việt Nam: chỉ giả `Date`.
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

const as = (token: string) => {
  const auth = `Bearer ${token}`;
  return {
    get: (path: string) => request(app).get(`${API}${path}`).set('Authorization', auth),
    post: (path: string, body: object = {}) => request(app).post(`${API}${path}`).set('Authorization', auth).send(body),
    put: (path: string, body: object) => request(app).put(`${API}${path}`).set('Authorization', auth).send(body),
  };
};
type Client = ReturnType<typeof as>;

/** Soạn, chạy thử, gửi duyệt bằng `author`; trả bản chờ duyệt. */
async function pending(author: Client, body: object) {
  const created = await author.post('/configs', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const dry = await author.post(`/configs/${created.body.id}/dry-run`, { version: created.body.version });
  expect(dry.status).toBe(200);
  const sent = await author.post(`/configs/${created.body.id}/submit`, { version: dry.body.version });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  return sent.body;
}

async function approved(author: Client, approver: Client, body: object) {
  const p = await pending(author, body);
  const res = await approver.post(`/configs/${p.id}/approve`, { version: p.version });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

async function setup() {
  const c = await createCompany();
  const admin = await addMember(c.companyId, 'admin');
  return { companyId: c.companyId, ceo: as(c.ceo.token), admin: as(admin.token) };
}

describe('soạn, chạy thử, gửi duyệt, duyệt (§21.4)', () => {
  it('Admin soạn và gửi duyệt, CEO duyệt → chờ hiệu lực; lịch sử ghi đủ các bước', async () => {
    const { ceo, admin } = await setup();
    const shopId = randomUUID();
    const draft = await admin.post('/configs', { kind: 'fee', shopId, payload: fee(), effectiveFrom: addDays(TODAY, 8) });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', kind: 'fee', shopId, dryRun: null, version: 1 });

    const early = await admin.post(`/configs/${draft.body.id}/submit`, { version: draft.body.version });
    expect([early.status, early.body.type]).toEqual([422, '/problems/dry_run_required']);

    const dry = await admin.post(`/configs/${draft.body.id}/dry-run`, { version: draft.body.version });
    expect(dry.body.dryRun).toMatchObject({ profit30: { now: 0, next: 0 }, rows: [{ shopId, feePct: 7, taxPct: null }] });
    const sent = await admin.post(`/configs/${draft.body.id}/submit`, { version: dry.body.version });
    expect(sent.body.status).toBe('pending_approval');

    const byAdmin = await admin.post(`/configs/${draft.body.id}/approve`, { version: sent.body.version });
    expect([byAdmin.status, byAdmin.body.type]).toEqual([403, '/problems/forbidden']);

    const ok = await ceo.post(`/configs/${draft.body.id}/approve`, { version: sent.body.version });
    expect(ok.body).toMatchObject({ status: 'scheduled', selfApproved: false, effectiveTo: null });
    expect(ok.body.approvedBy.id).toBeTruthy();
    expect(ok.body.statusHistory.map((h: { to: string }) => h.to)).toEqual(['draft', 'pending_approval', 'scheduled']);
  });

  it('CEO tự soạn, tự duyệt được và ghi selfApproved; người soạn khác CEO tự duyệt thì 409 second_person_required', async () => {
    const { companyId, ceo } = await setup();
    const own = await approved(ceo, ceo, { kind: 'tax_regime', payload: { regime: 'household' }, effectiveFrom: addDays(TODAY, 3) });
    expect(own).toMatchObject({ status: 'scheduled', selfApproved: true });

    const both = await createCustomRole(companyId, ['finance.config.manage', 'finance.config.approve']);
    const author = as((await addMember(companyId, both)).token);
    const p = await pending(author, { kind: 'min_margin', payload: { pct: 10 }, effectiveFrom: addDays(TODAY, 3) });
    const self = await author.post(`/configs/${p.id}/approve`, { version: p.version });
    expect([self.status, self.body.type]).toEqual([409, '/problems/second_person_required']);
  });

  it('từ chối cần lý do; sửa bản không còn nháp thì 409; gửi version cũ thì 409 version_conflict', async () => {
    const { ceo, admin } = await setup();
    const p = await pending(admin, { kind: 'mismatch_threshold', payload: { abs: 5000, pct: 1, resolveLimit: 200000 }, effectiveFrom: addDays(TODAY, 2) });
    const noReason = await ceo.post(`/configs/${p.id}/reject`, { version: p.version });
    expect([noReason.status, noReason.body.type]).toEqual([422, '/problems/reason_required']);
    const stale = await ceo.post(`/configs/${p.id}/reject`, { version: p.version - 1, reason: 'ngưỡng quá thấp' });
    expect([stale.status, stale.body.type]).toEqual([409, '/problems/version_conflict']);
    const edit = await admin.put(`/configs/${p.id}`, { version: p.version, payload: { abs: 1, pct: 1, resolveLimit: 1 }, effectiveFrom: TODAY });
    expect([edit.status, edit.body.type]).toEqual([409, '/problems/invalid_transition']);
    const rejected = await ceo.post(`/configs/${p.id}/reject`, { version: p.version, reason: 'ngưỡng quá thấp' });
    expect(rejected.body).toMatchObject({ status: 'rejected', statusReason: 'ngưỡng quá thấp' });
  });

  it('sửa nháp thì xoá kết quả chạy thử cũ', async () => {
    const { admin } = await setup();
    const d = await admin.post('/configs', { kind: 'min_margin', payload: { pct: 5 }, effectiveFrom: addDays(TODAY, 4) });
    const dry = await admin.post(`/configs/${d.body.id}/dry-run`, { version: d.body.version });
    expect(dry.body.dryRun).not.toBeNull();
    const edited = await admin.put(`/configs/${d.body.id}`, { version: dry.body.version, payload: { pct: 8 }, effectiveFrom: addDays(TODAY, 4) });
    expect(edited.body).toMatchObject({ payload: { pct: 8 }, dryRun: null });
  });
});

describe('dòng thời gian của một gian hàng', () => {
  it('duyệt bản đã tới ngày thì áp dụng ngay; bản sau tới ngày thì bản trước hết hiệu lực và phát sự kiện', async () => {
    const { companyId, ceo, admin } = await setup();
    const shopId = randomUUID();
    const a = await approved(admin, ceo, { kind: 'fee', shopId, payload: fee(), effectiveFrom: TODAY });
    expect(a.status).toBe('active');
    expect(a.statusHistory.map((h: { to: string }) => h.to)).toEqual(['draft', 'pending_approval', 'scheduled', 'active']);

    const later = addDays(TODAY, 5);
    const b = await approved(admin, ceo, { kind: 'fee', shopId, payload: fee({ fixedPct: 5 }), effectiveFrom: later });
    expect(b.status).toBe('scheduled');
    expect((await admin.get(`/configs/${a.id}`)).body).toMatchObject({ status: 'active', effectiveTo: addDays(later, -1) });

    await activateDueConfigs(new Date(`${later}T03:00:00Z`));
    expect((await admin.get(`/configs/${b.id}`)).body.status).toBe('active');
    expect((await admin.get(`/configs/${a.id}`)).body).toMatchObject({ status: 'expired', effectiveTo: addDays(later, -1) });

    const { rows } = await testPool().query(
      "select payload from core.outbox_messages where type = 'finance.fee_config_activated' and key = $1",
      [b.id],
    );
    expect(rows[0].payload).toMatchObject({ configVersionId: b.id, kind: 'fee', shopId, effectiveFrom: later, supersededId: a.id });

    const pick = (day: string) => withCompany(companyId, () => getEffectiveConfig('fee', shopId, day));
    expect((await pick(addDays(later, -1)))?.id).toBe(a.id);
    expect(await pick(later)).toMatchObject({ id: b.id, payload: { fixedPct: 5 } });
    expect(await pick(addDays(TODAY, -1))).toBeUndefined();
  });

  it('trùng ngày hiệu lực cùng gian hàng thì 409 config_overlap; huỷ bản đã duyệt thì bản trước chạy tiếp', async () => {
    const { ceo, admin } = await setup();
    const shopId = randomUUID();
    const a = await approved(admin, ceo, { kind: 'fee', shopId, payload: fee(), effectiveFrom: TODAY });
    const later = addDays(TODAY, 10);
    const b = await approved(admin, ceo, { kind: 'fee', shopId, payload: fee({ fixedPct: 6 }), effectiveFrom: later });

    const c = await admin.post('/configs', { kind: 'fee', shopId, payload: fee({ fixedPct: 7 }), effectiveFrom: later });
    const dry = await admin.post(`/configs/${c.body.id}/dry-run`, { version: c.body.version });
    const clash = await admin.post(`/configs/${c.body.id}/submit`, { version: dry.body.version });
    expect([clash.status, clash.body.type]).toEqual([409, '/problems/config_overlap']);

    const cancelled = await admin.post(`/configs/${b.id}/cancel`, { version: b.version });
    expect(cancelled.body.status).toBe('cancelled');
    expect((await admin.get(`/configs/${a.id}`)).body).toMatchObject({ status: 'active', effectiveTo: null });

    const late = await admin.post(`/configs/${a.id}/cancel`, { version: (await admin.get(`/configs/${a.id}`)).body.version });
    expect([late.status, late.body.type]).toEqual([409, '/problems/invalid_transition']);
  });
});

describe('kiểm dữ liệu và quyền', () => {
  it('nội dung sai theo loại thì 422 kèm ô payload.<trường>; phí sàn thiếu gian hàng thì 422', async () => {
    const { admin } = await setup();
    const bad = await admin.post('/configs', { kind: 'fee', shopId: randomUUID(), payload: fee({ fixedPct: 120 }), effectiveFrom: TODAY });
    expect(bad.status).toBe(422);
    expect(bad.body.errors).toHaveProperty(['payload.fixedPct']);
    const noShop = await admin.post('/configs', { kind: 'fee', payload: fee(), effectiveFrom: TODAY });
    expect(noShop.status).toBe(422);
    expect(noShop.body.errors).toHaveProperty('shopId');
  });

  it('Sale không xem được (403); công ty khác không thấy phiên bản (404)', async () => {
    const { companyId, admin } = await setup();
    const d = await admin.post('/configs', { kind: 'min_margin', payload: { pct: 5 }, effectiveFrom: TODAY });
    const sale = as((await addMember(companyId, 'sale')).token);
    const denied = await sale.get('/configs');
    expect([denied.status, denied.body.type]).toEqual([403, '/problems/forbidden']);

    const other = await setup();
    expect((await other.admin.get(`/configs/${d.body.id}`)).status).toBe(404);
    expect((await other.admin.get('/configs')).body.items).toEqual([]);
    expect((await admin.get('/configs?kind=min_margin')).body.items.map((i: { id: string }) => i.id)).toEqual([d.body.id]);
  });
});
