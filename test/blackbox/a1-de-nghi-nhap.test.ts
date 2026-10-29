import { beforeAll, describe, expect, inject, it } from 'vitest';
import { PurchaseRequest, PurchaseRequestPage } from '#src/modules/product/purchasing/api/schemas.ts';
import { api, type Role } from './lib/client.ts';
import { expectContract, expectProblem } from './lib/contract.ts';
import { act, newRequest, newSupplier, newVariant } from './lib/fixtures.ts';

// Ca theo sơ đồ A1 Đề nghị nhập (Documents/kiem-thu/ca-theo-so-do.md, mục A1) gọi qua HTTP vào server đang chạy.
// Cùng ca với test integration `product/purchasing/a1-ca-so-do.test.ts`, thêm kiểm hình dạng response theo §16.

type Step = [Role, string, Record<string, unknown>?];

const tokens = inject('tokens');
const REASON = { reason: 'Kiểm thử hộp đen' };
const ACTIONS = ['submit', 'withdraw', 'resubmit', 'approve', 'request_changes', 'reject', 'order', 'close_short', 'cancel'];

/** Đường đi tới từng trạng thái, người làm đúng vai (Mua hàng lập, CEO duyệt). */
const PATHS: Record<string, Step[]> = {
  draft: [],
  pending_approval: [['buyer', 'submit']],
  changes_requested: [['buyer', 'submit'], ['ceo', 'request_changes', REASON]],
  rejected: [['buyer', 'submit'], ['ceo', 'reject', REASON]],
  approved: [['buyer', 'submit'], ['ceo', 'approve']],
  ordered: [['buyer', 'submit'], ['ceo', 'approve'], ['buyer', 'order']],
  closed_short: [['buyer', 'submit'], ['ceo', 'approve'], ['buyer', 'order'], ['ceo', 'close_short', REASON]],
  cancelled: [['buyer', 'cancel']],
};

/** Mũi tên đi được bằng API (chưa có phiếu nhận #109 thì chưa tới partially_received, received). */
const ARROWS: [caseId: string, from: string, action: string, to: string, actor: Role, needsReason: boolean, perm: 'manage' | 'approve'][] = [
  ['A1-01', 'draft', 'submit', 'pending_approval', 'buyer', false, 'manage'],
  ['A1-02', 'pending_approval', 'withdraw', 'draft', 'buyer', false, 'manage'],
  ['A1-03', 'changes_requested', 'resubmit', 'pending_approval', 'buyer', false, 'manage'],
  ['A1-04', 'pending_approval', 'approve', 'approved', 'ceo', false, 'approve'],
  ['A1-05', 'pending_approval', 'request_changes', 'changes_requested', 'ceo', true, 'approve'],
  ['A1-06', 'pending_approval', 'reject', 'rejected', 'ceo', true, 'approve'],
  ['A1-07', 'approved', 'order', 'ordered', 'buyer', false, 'manage'],
  ['A1-12', 'ordered', 'close_short', 'closed_short', 'ceo', true, 'approve'],
  ['A1-14', 'draft', 'cancel', 'cancelled', 'buyer', false, 'manage'],
  ['A1-15', 'changes_requested', 'cancel', 'cancelled', 'buyer', false, 'manage'],
  ['A1-16', 'pending_approval', 'cancel', 'cancelled', 'buyer', false, 'manage'],
  ['A1-17', 'approved', 'cancel', 'cancelled', 'ceo', true, 'approve'],
  ['A1-18', 'ordered', 'cancel', 'cancelled', 'ceo', true, 'approve'],
];
/** Vai trò có sẵn không có quyền của bước (Documents/kiem-thu/ma-tran-quyen.md). */
const LACKING: Record<'manage' | 'approve', Role[]> = { manage: ['admin', 'sale', 'kho'], approve: ['admin', 'sale', 'kho', 'buyer'] };
/** Thao tác có mũi tên đi ra từ mỗi trạng thái. */
const ALLOWED: Record<string, string[]> = {
  draft: ['submit', 'cancel'],
  pending_approval: ['withdraw', 'approve', 'request_changes', 'reject', 'cancel'],
  changes_requested: ['resubmit', 'cancel'],
  rejected: [],
  approved: ['order', 'cancel'],
  ordered: ['close_short', 'cancel'],
  closed_short: [],
  cancelled: [],
};

let supplierId: string;
let variantId: string;

beforeAll(async () => {
  variantId = await newVariant(tokens.ceo);
  supplierId = await newSupplier(tokens.ceo);
});

/** Một đề nghị mới do Mua hàng lập, đi tới `state`. */
async function reach(state: string, creator: Role = 'buyer') {
  const r = await newRequest(tokens[creator], supplierId, variantId);
  let version = r.version;
  for (const [role, action, extra] of PATHS[state]!) {
    const res = await act(tokens[role], r.id, action, { version, ...extra });
    expect(res.status, `${action}: ${JSON.stringify(res.body)}`).toBe(200);
    version = res.body.version;
  }
  return { id: r.id, version };
}

const current = async (id: string) => (await api(tokens.ceo).get(`/purchasing/requests/${id}`)).body;

describe('A1 Đề nghị nhập qua HTTP: mỗi mũi tên một ca đúng', () => {
  it.each(ARROWS)('%s: %s --%s--> %s', async (_id, from, action, to, actor, needsReason) => {
    const r = await reach(from);
    const res = await act(tokens[actor], r.id, action, { version: r.version, ...(needsReason ? REASON : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expectContract(PurchaseRequest, res.body);
    expect([res.body.status, res.body.version]).toEqual([to, r.version + 1]);
    const last = res.body.statusHistory.at(-1);
    expect(last).toMatchObject({ from, to, source: 'user', reason: needsReason ? REASON.reason : null });
    expect(last.by).not.toBeNull();
  });

  it('A1-04s: CEO tự lập rồi tự duyệt được (ngoại lệ tự duyệt, 25 §11)', async () => {
    const r = await reach('pending_approval', 'ceo');
    const res = await act(tokens.ceo, r.id, 'approve', { version: r.version });
    expect([res.status, res.body.status]).toEqual([200, 'approved']);
  });
});

describe('A1 Đề nghị nhập qua HTTP: ca bị chặn', () => {
  it.each(ARROWS)('%sq: vai trò thiếu quyền gọi %s từ %s nhận 403 forbidden', async (_id, from, action, _to, _actor, needsReason, perm) => {
    const r = await reach(from);
    for (const role of LACKING[perm]) {
      const res = await act(tokens[role], r.id, action, { version: r.version, ...(needsReason ? REASON : {}) });
      expect([role, res.status, res.body.code]).toEqual([role, 403, 'forbidden']);
    }
    const still = await current(r.id);
    expect([still.status, still.version]).toEqual([from, r.version]);
  });

  it.each(ARROWS.filter((a) => a[5]))('%sr: %s từ %s không ghi lý do nhận 422 reason_required', async (_id, from, action, _to, actor) => {
    const r = await reach(from);
    expectProblem(await act(tokens[actor], r.id, action, { version: r.version }), 422, 'reason_required');
  });

  it.each([
    ['A1-04p', 'approve'],
    ['A1-05p', 'request_changes'],
    ['A1-06p', 'reject'],
  ])('%s: trưởng mua hàng (không phải CEO) tự %s đề nghị mình lập nhận 409 second_person_required', async (_id, action) => {
    const r = await reach('pending_approval', 'lead');
    expectProblem(await act(tokens.lead, r.id, action, { version: r.version, ...REASON }), 409, 'second_person_required');
    // Người thứ hai có quyền duyệt thì được.
    const other = await act(tokens.ceo, r.id, action, { version: r.version, ...REASON });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
  });

  it.each(Object.entries(ALLOWED).map(([state, allowed], n) => [`A1-X${String(n + 1).padStart(2, '0')}`, state, allowed] as const))(
    '%s: ở %s, mọi thao tác không có mũi tên đi ra nhận 409 invalid_transition, trạng thái không đổi',
    async (_id, state, allowed) => {
      const r = await reach(state);
      for (const action of ACTIONS.filter((a) => !allowed.includes(a))) {
        const res = await act(tokens.ceo, r.id, action, { version: r.version, ...REASON });
        expect([action, res.status, res.body.code]).toEqual([action, 409, 'invalid_transition']);
      }
      const still = await current(r.id);
      expect([still.status, still.version]).toEqual([state, r.version]);
    },
  );

  it('A1-V: gửi version cũ nhận 409 version_conflict kèm bản mới nhất', async () => {
    const r = await reach('pending_approval');
    const res = await act(tokens.ceo, r.id, 'approve', { version: r.version - 1 });
    expectProblem(res, 409, 'version_conflict');
    expect(res.body.current).toMatchObject({ id: r.id, version: r.version, status: 'pending_approval' });
  });

  it('A1-C: hai người duyệt cùng lúc, đúng một người thành công', async () => {
    const r = await reach('pending_approval');
    const both = await Promise.all([
      act(tokens.ceo, r.id, 'approve', { version: r.version }),
      act(tokens.lead, r.id, 'reject', { version: r.version, ...REASON }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await current(r.id)).version).toBe(r.version + 1);
  });
});

describe('A1 danh sách và chi tiết theo hợp đồng §16', () => {
  it('danh sách là Page<PurchaseRequestSummary>, chi tiết là PurchaseRequest', async () => {
    const r = await reach('draft');
    const page = await api(tokens.buyer).get('/purchasing/requests?pageSize=5');
    expect(page.status).toBe(200);
    expectContract(PurchaseRequestPage, page.body);
    const detail = await api(tokens.buyer).get(`/purchasing/requests/${r.id}`);
    expectContract(PurchaseRequest, detail.body);
  });

  it('id sai định dạng hoặc không có nhận 404 not_found', async () => {
    expectProblem(await api(tokens.ceo).get('/purchasing/requests/khong-phai-uuid'), 404, 'not_found');
    expectProblem(await api(tokens.ceo).get('/purchasing/requests/00000000-0000-4000-8000-000000000999'), 404, 'not_found');
  });
});
