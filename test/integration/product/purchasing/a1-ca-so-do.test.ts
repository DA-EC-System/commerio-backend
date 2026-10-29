import { beforeAll, describe, expect, it } from 'vitest';
import { createVariant } from '../../helpers/catalog.ts';
import { addMember, createCompany, createCustomRole } from '../../helpers/company.ts';
import { act, BUYER_ROLE, createRequest, createSupplier, pur, runActions } from './helpers.ts';

// Ca kiểm thử theo sơ đồ A1 Đề nghị nhập (Documents/kiem-thu/ca-theo-so-do.md, mục A1; #122, #120). Mỗi `it` mang mã
// ca: `A1-nn` ca đúng, hậu tố `q` thiếu quyền, `p` người lập tự làm, `r` thiếu lý do, `X` thao tác ngoài bảng.

type Role = 'ceo' | 'admin' | 'sale' | 'kho' | 'buyer';
type Step = [Role, string, Record<string, unknown>?];

const REASON = { reason: 'Kiểm thử theo sơ đồ' };
const ACTIONS = ['submit', 'withdraw', 'resubmit', 'approve', 'request_changes', 'reject', 'order', 'close_short', 'cancel'];

/** Đường đi tới từng trạng thái qua API, người làm đúng vai (Mua hàng lập, CEO duyệt). */
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

/** Mũi tên người dùng đi được bằng API hiện có (chưa có phiếu nhận #109 nên chưa tới partially_received, received). */
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
/** Trạng thái đến được và các thao tác có mũi tên đi ra (sơ đồ A1). */
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

let tokens: Record<Role, string>;
let supplierId: string;
let variantId: string;

beforeAll(async () => {
  const c = await createCompany();
  variantId = (await createVariant(c.companyId)).variantId;
  tokens = {
    ceo: c.ceo.token,
    admin: (await addMember(c.companyId, 'admin')).token,
    sale: (await addMember(c.companyId, 'sale')).token,
    kho: (await addMember(c.companyId, 'warehouse')).token,
    buyer: (await addMember(c.companyId, BUYER_ROLE)).token,
  };
  supplierId = (await createSupplier(c.ceo.token)).id;
});

/** Một đề nghị mới do Mua hàng lập, đi tới `state`; trả id và `version` hiện tại. */
async function reach(state: string) {
  const r = await createRequest(tokens.buyer, supplierId, [{ variantId, quantity: 10, unitCost: 60000 }]);
  if (!PATHS[state]!.length) return { id: r.id, version: r.version };
  const body = await runActions(
    PATHS[state]!.map(([role, action, extra]) => [tokens[role], action, extra] as [string, string, Record<string, unknown>?]),
    r.id,
    r.version,
  );
  expect(body.status).toBe(state);
  return { id: r.id, version: body.version };
}

describe('A1 Đề nghị nhập: mỗi mũi tên một ca đúng', () => {
  it.each(ARROWS)('%s: %s --%s--> %s', async (_id, from, action, to, actor, needsReason) => {
    const r = await reach(from);
    const res = await act(tokens[actor], r.id, action, { version: r.version, ...(needsReason ? REASON : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.status).toBe(to);
    expect(res.body.version).toBe(r.version + 1);
    const last = res.body.statusHistory.at(-1);
    expect(last).toMatchObject({ from, to, ...(needsReason ? { reason: REASON.reason } : {}) });
    expect(last.by).not.toBeNull();
  });

  it.todo('A1-08..A1-11: nhận một phần, nhận xong do phiếu nhận ghi sổ (chờ #109)');
  it.todo('A1-13: đóng thiếu đề nghị đã nhận một phần (chờ #109)');
});

describe('A1 Đề nghị nhập: ca bị chặn', () => {
  it.each(ARROWS)('%sq: vai trò thiếu quyền gọi %s từ %s nhận 403', async (_id, from, action, _to, _actor, needsReason, perm) => {
    const r = await reach(from);
    for (const role of LACKING[perm]) {
      const res = await act(tokens[role], r.id, action, { version: r.version, ...(needsReason ? REASON : {}) });
      expect([role, res.status, res.body.code]).toEqual([role, 403, 'forbidden']);
    }
    const still = await pur(tokens.ceo).get(`/requests/${r.id}`);
    expect([still.body.status, still.body.version]).toEqual([from, r.version]);
  });

  it.each(ARROWS.filter((a) => a[5]))('%sr: %s từ %s không ghi lý do nhận 422 reason_required', async (_id, from, action, _to, actor) => {
    const r = await reach(from);
    const res = await act(tokens[actor], r.id, action, { version: r.version });
    expect([res.status, res.body.code]).toEqual([422, 'reason_required']);
  });

  it.each([
    ['A1-05p', 'request_changes'],
    ['A1-06p', 'reject'],
  ])('%s: người lập có quyền duyệt (không phải CEO) tự %s nhận 409 second_person_required', async (_id, action) => {
    const c = await createCompany();
    const role = await createCustomRole(c.companyId, ['purchasing.request.manage', 'purchasing.request.approve']);
    const lead = (await addMember(c.companyId, role)).token;
    const v = (await createVariant(c.companyId)).variantId;
    const r = await createRequest(lead, (await createSupplier(c.ceo.token)).id, [{ variantId: v, quantity: 1, unitCost: 1000 }]);
    const sent = await act(lead, r.id, 'submit', { version: r.version });
    const res = await act(lead, r.id, action, { version: sent.body.version, ...REASON });
    expect([res.status, res.body.code]).toEqual([409, 'second_person_required']);
  });

  it.each(Object.entries(ALLOWED).map(([state, allowed], n) => [`A1-X${String(n + 1).padStart(2, '0')}`, state, allowed] as const))(
    '%s: ở %s, mọi thao tác không có mũi tên đi ra nhận 409 invalid_transition, trạng thái không đổi',
    async (_id, state, allowed) => {
      const r = await reach(state);
      for (const action of ACTIONS.filter((a) => !allowed.includes(a))) {
        const res = await act(tokens.ceo, r.id, action, { version: r.version, ...REASON });
        expect([action, res.status, res.body.code]).toEqual([action, 409, 'invalid_transition']);
      }
      const still = await pur(tokens.ceo).get(`/requests/${r.id}`);
      expect([still.body.status, still.body.version]).toEqual([state, r.version]);
    },
  );
});
