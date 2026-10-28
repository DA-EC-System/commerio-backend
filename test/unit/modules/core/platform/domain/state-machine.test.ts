import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  availableActions,
  defineMachine,
  type TransitionContext,
} from '#src/modules/core/platform/domain/state-machine.ts';
import { AppError } from '#src/shared/errors/app-error.ts';

type S = 'draft' | 'pending' | 'posted' | 'rejected' | 'auto';
type A = 'submit' | 'approve' | 'reject' | 'post_auto' | 'withdraw';

// Bảng mẫu theo phiếu kho (Documents/21 mục 15.3), rút gọn.
const machine = defineMachine<S, A>([
  { from: 'draft', to: 'pending', action: 'submit', permission: 'inventory.document.create' },
  { from: ['pending'], to: 'draft', action: 'withdraw' },
  {
    from: 'pending',
    to: 'posted',
    action: 'approve',
    permission: 'inventory.document.approve',
    needsSecondPerson: true,
    allowSelfApproval: true,
  },
  {
    from: 'pending',
    to: 'rejected',
    action: 'reject',
    permission: 'inventory.document.approve',
    needsSecondPerson: true,
    needsReason: true,
  },
  { from: 'auto', to: 'posted', action: 'post_auto', system: true, guard: (r) => (r.blocked ? 'claim_open' : null) },
]);

const creator = 'acc-creator';
const other = 'acc-other';
const all = ['inventory.document.create', 'inventory.document.approve'];
const user = (accountId: string, permissions: readonly string[] = all, enabledModules: readonly string[] = ['inventory']) => ({
  accountId,
  permissions,
  enabledModules,
});

function codeOf(fn: () => unknown): { status: number; code: string; extensions?: Record<string, unknown> } {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    const err = e as AppError;
    return { status: err.status, code: err.code, extensions: err.extensions };
  }
  throw new Error('không ném lỗi');
}

describe('assertTransition', () => {
  it('AC-1: thao tác không đi ra từ trạng thái hiện tại → 409 invalid_transition kèm current', () => {
    expect(codeOf(() => assertTransition(machine, 'draft', 'approve', { actor: user(other) }))).toEqual({
      status: 409,
      code: 'invalid_transition',
      extensions: { current: 'draft' },
    });
  });

  it('AC-1: current là bản ghi dạng API khi bên gọi truyền view', () => {
    const view = { id: 'doc-1', status: 'draft' };
    expect(codeOf(() => assertTransition(machine, 'draft', 'approve', { actor: user(other), view })).extensions).toEqual({
      current: view,
    });
  });

  it('cùng action từ from dạng mảng', () => {
    expect(assertTransition(machine, 'pending', 'withdraw', { actor: user(creator) })).toEqual({ to: 'draft', selfApproved: false });
  });

  it('AC-2: thiếu quyền của bước → 403 forbidden', () => {
    expect(codeOf(() => assertTransition(machine, 'draft', 'submit', { actor: user(creator, []) }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('AC-2: có quyền nhưng phân hệ của quyền đang tắt → 403 forbidden', () => {
    expect(codeOf(() => assertTransition(machine, 'draft', 'submit', { actor: user(creator, all, ['catalog']) }))).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(names({ actor: user(other, all, ['catalog']) }, 'pending')).toEqual(['withdraw']);
  });

  it('AC-2: hệ thống (actor null) không bị kiểm quyền', () => {
    expect(assertTransition(machine, 'draft', 'submit', { actor: null }).to).toBe('pending');
  });

  it('AC-2b: người dùng gọi chuyển của hệ thống → 409 invalid_transition; hệ thống thì qua', () => {
    expect(codeOf(() => assertTransition(machine, 'auto', 'post_auto', { actor: user(other) })).code).toBe('invalid_transition');
    expect(assertTransition(machine, 'auto', 'post_auto', { actor: null, record: {} }).to).toBe('posted');
  });

  describe('AC-3: người thứ hai', () => {
    const record = { createdBy: creator };

    it('người lập tự duyệt, không được tự duyệt → 409 second_person_required', () => {
      expect(codeOf(() => assertTransition(machine, 'pending', 'approve', { actor: user(creator), record }))).toMatchObject({
        status: 409,
        code: 'second_person_required',
      });
    });

    it('người lập được tự duyệt, bước cho phép → qua, selfApproved true', () => {
      expect(assertTransition(machine, 'pending', 'approve', { actor: user(creator), record, canSelfApprove: true })).toEqual({
        to: 'posted',
        selfApproved: true,
      });
    });

    it('bước không có allowSelfApproval thì canSelfApprove không mở được', () => {
      const ctx: TransitionContext = { actor: user(creator), record, canSelfApprove: true, reason: 'sai số' };
      expect(codeOf(() => assertTransition(machine, 'pending', 'reject', ctx)).code).toBe('second_person_required');
    });

    it('người khác → qua, selfApproved false', () => {
      expect(assertTransition(machine, 'pending', 'approve', { actor: user(other), record })).toEqual({
        to: 'posted',
        selfApproved: false,
      });
    });

    it('createdBy null (hệ thống lập) → không chặn', () => {
      expect(assertTransition(machine, 'pending', 'approve', { actor: user(creator), record: { createdBy: null } }).to).toBe('posted');
    });
  });

  it('AC-4: bước bắt buộc lý do, lý do rỗng hoặc khoảng trắng → 422 reason_required', () => {
    for (const reason of [undefined, null, '', '   ']) {
      expect(codeOf(() => assertTransition(machine, 'pending', 'reject', { actor: user(other), reason }))).toMatchObject({
        status: 422,
        code: 'reason_required',
      });
    }
    expect(assertTransition(machine, 'pending', 'reject', { actor: user(other), reason: 'đếm sai' }).to).toBe('rejected');
  });

  it('AC-5: guard trả mã → 409 với mã đó; null → qua', () => {
    expect(codeOf(() => assertTransition(machine, 'auto', 'post_auto', { actor: null, record: { blocked: true } }))).toMatchObject({
      status: 409,
      code: 'claim_open',
    });
    expect(assertTransition(machine, 'auto', 'post_auto', { actor: null, record: { blocked: false } }).to).toBe('posted');
  });
});

const names = (ctx: TransitionContext, from: S) => availableActions(machine, from, ctx).map((t) => t.action);

describe('availableActions (AC-6)', () => {
  it('bỏ thiếu quyền', () => {
    expect(names({ actor: user(other, []) }, 'pending')).toEqual(['withdraw']);
  });

  it('bỏ bước bị chặn bởi người thứ hai, trừ bước tự duyệt được', () => {
    const record = { createdBy: creator };
    expect(names({ actor: user(creator), record }, 'pending')).toEqual(['withdraw']);
    expect(names({ actor: user(creator), record, canSelfApprove: true }, 'pending')).toEqual(['withdraw', 'approve']);
    expect(names({ actor: user(other), record }, 'pending')).toEqual(['withdraw', 'approve', 'reject']);
  });

  it('bỏ chuyển của hệ thống và bước guard chặn', () => {
    expect(names({ actor: user(other), record: { blocked: false } }, 'auto')).toEqual([]);
  });
});
