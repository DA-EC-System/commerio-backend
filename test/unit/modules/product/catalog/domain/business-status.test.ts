import { describe, expect, it } from 'vitest';
import { assertTransition } from '#src/modules/core/index.ts';
import {
  BUSINESS_ACTIONS,
  type BusinessAction,
  type BusinessStatus,
  businessStatusMachine,
} from '#src/modules/product/catalog/domain/business-status.ts';

// Máy trạng thái kinh doanh của SKU, sơ đồ B1 (Documents/21 §17.3, kiem-thu/ca-theo-so-do.md B1).
const actor = { accountId: 'a', permissions: ['catalog.product.manage'], enabledModules: ['catalog'] };
const free = { archiveBlockers: [] };
const run = (from: BusinessStatus, action: BusinessAction, archiveBlockers: string[] = []) =>
  assertTransition(businessStatusMachine, from, action, { actor, record: { archiveBlockers } });

describe('máy trạng thái kinh doanh (B1)', () => {
  it.each([
    ['B1-01', 'selling', 'pause', 'paused'],
    ['B1-02', 'discontinued', 'pause', 'paused'],
    ['B1-03', 'paused', 'unpause', 'selling'],
    ['B1-04', 'selling', 'discontinue', 'discontinued'],
    ['B1-05', 'paused', 'discontinue', 'discontinued'],
    ['B1-06', 'discontinued', 'reactivate', 'selling'],
    ['B1-07', 'discontinued', 'archive', 'archived'],
    ['B1-08', 'archived', 'restore', 'discontinued'],
  ] as const)('%s: %s --%s--> %s', (_code, from, action, to) => {
    expect(run(from, action).to).toBe(to);
  });

  it('B1-07g: lưu trữ khi còn lý do chặn → 409 archive_blocked', () => {
    expect(() => run('discontinued', 'archive', ['Còn 3 tồn thực'])).toThrow(
      expect.objectContaining({ status: 409, code: 'archive_blocked' }),
    );
  });

  const allowed: Record<BusinessStatus, BusinessAction[]> = {
    selling: ['pause', 'discontinue'],
    paused: ['unpause', 'discontinue'],
    discontinued: ['pause', 'reactivate', 'archive'],
    archived: ['restore'],
  };
  const invalid = (Object.keys(allowed) as BusinessStatus[]).flatMap((from, i) =>
    BUSINESS_ACTIONS.filter((a) => !allowed[from].includes(a)).map((a) => [`B1-X0${i + 1}`, from, a] as const),
  );
  it.each(invalid)('%s: %s không có thao tác %s → 409 invalid_transition', (_code, from, action) => {
    expect(() => run(from, action)).toThrow(expect.objectContaining({ status: 409, code: 'invalid_transition' }));
  });

  it('thiếu quyền catalog.product.manage → 403 forbidden', () => {
    const sale = { ...actor, permissions: ['catalog.product.view'] };
    expect(() => assertTransition(businessStatusMachine, 'selling', 'pause', { actor: sale, record: free })).toThrow(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
  });
});
