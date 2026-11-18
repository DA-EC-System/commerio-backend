import { describe, expect, it } from 'vitest';
import { planResplit, replacementPairs } from '#src/modules/order/fulfillment/domain/resplit.ts';
import type { ResplitGroup, ResplitPackage, ResplitPlan } from '#src/modules/order/fulfillment/domain/resplit.ts';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';

/** Kiện của đơn sàn: mỗi món một dòng đơn số lượng 1; `drop` là món chờ bỏ. Mã app `KH-<id>`. */
function pkg(id: string, status: PackageStatus, platformPackageCode: string | null, items: string[], drop: string[] = []): ResplitPackage {
  return {
    id,
    code: `KH-${id}`,
    status,
    platformPackageCode,
    lines: [
      ...items.map((o) => ({ id: `${id}-${o}`, orderLineId: o, quantity: 1, pendingDropQty: 0 })),
      ...drop.map((o) => ({ id: `${id}-${o}`, orderLineId: o, quantity: 1, pendingDropQty: 1 })),
    ],
  };
}
const group = (code: string, items: string[]): ResplitGroup => ({ code, lines: items.map((o) => ({ orderLineId: o, quantity: 1 })) });
const kinds = (plan: ResplitPlan) => plan.steps.map((s) => s.kind);
const NO_PLAN = { targets: new Map(), steps: [], resplit: true };

/** Áp kế hoạch bằng tay như service sẽ làm, để kiểm gọi lặp. */
function apply(packages: ResplitPackage[], groups: ResplitGroup[], plan: ResplitPlan): ResplitPackage[] {
  const out: ResplitPackage[] = packages.map((p) => ({ ...p, lines: p.lines.map((l) => ({ ...l })) }));
  const byId = (id: string) => out.find((p) => p.id === id)!;
  for (const s of plan.steps) {
    if (s.kind === 'clear_code') byId(s.packageId).platformPackageCode = null;
    else if (s.kind === 'relabel') byId(s.packageId).platformPackageCode = s.code;
    else if (s.kind === 'cancel_open') byId(s.packageId).status = 'cancelled';
    else if (s.kind === 'move_out') {
      const p = byId(s.packageId);
      p.lines = p.lines.filter((l) => !s.orderLineIds.includes(l.orderLineId));
    } else if (s.kind === 'mark_drop') {
      const p = byId(s.packageId);
      p.lines = p.lines.map((l) => (s.orderLineIds.includes(l.orderLineId) ? { ...l, pendingDropQty: l.quantity } : l));
    } else if (s.kind === 'create') {
      const g = groups.find((x) => x.code === s.code)!;
      out.push(pkg(`moi-${s.code}`, 'backordered', s.code, g.lines.map((l) => l.orderLineId)));
    }
  }
  return out;
}

describe('planResplit: sàn chia lại kiện (spec #238 §5.6, D22)', () => {
  it('nhóm trùng tập dòng của kiện chưa bàn giao, mã khác: chỉ relabel, targets trỏ kiện đó', () => {
    const plan = planResplit([pkg('a', 'reserved', 'X', ['1', '2'])], [group('Y', ['2', '1'])]);
    expect(plan.steps).toEqual([{ kind: 'relabel', packageId: 'a', code: 'Y' }]);
    expect(plan.targets).toEqual(new Map([['Y', 'a']]));
    expect(plan.resplit).toBe(false);
  });

  it('kiện tạm (mã null) khớp tập: relabel', () => {
    const plan = planResplit([pkg('a', 'backordered', null, ['1'])], [group('X', ['1'])]);
    expect(plan.steps).toEqual([{ kind: 'relabel', packageId: 'a', code: 'X' }]);
    expect(plan.targets.get('X')).toBe('a');
  });

  it('hai kiện đổi mã cho nhau: hai relabel, không create', () => {
    const plan = planResplit(
      [pkg('a', 'reserved', 'X', ['1']), pkg('b', 'packed', 'Y', ['2'])],
      [group('X', ['2']), group('Y', ['1'])],
    );
    expect(plan.steps).toEqual([
      { kind: 'relabel', packageId: 'b', code: 'X' },
      { kind: 'relabel', packageId: 'a', code: 'Y' },
    ]);
    expect(plan.targets).toEqual(new Map([['X', 'b'], ['Y', 'a']]));
    expect(plan.resplit).toBe(false);
  });

  it('kiện đã bàn giao khớp tập mà mã khác: nhận nhóm, không relabel', () => {
    const plan = planResplit([pkg('a', 'in_transit', 'X', ['1'])], [group('Y', ['1'])]);
    expect(plan.steps).toEqual([]);
    expect(plan.targets).toEqual(new Map([['Y', 'a']]));
    expect(plan.resplit).toBe(false);
  });

  it('kiện reserved 2 món chia thành 2 mã mới: cancel_open kiện cũ, 2 create replaces kiện cũ, awaitingOpen false', () => {
    const plan = planResplit([pkg('a', 'reserved', 'X', ['1', '2'])], [group('B', ['2']), group('A', ['1'])]);
    expect(plan.steps).toEqual([
      { kind: 'cancel_open', packageId: 'a' },
      { kind: 'create', code: 'A', replacesPackageId: 'a', awaitingOpen: false },
      { kind: 'create', code: 'B', replacesPackageId: 'a', awaitingOpen: false },
    ]);
    expect(plan.targets.size).toBe(0);
    expect(plan.resplit).toBe(false);
  });

  it('sàn giữ mã cũ cho món 1, món 2 sang mã mới: targets[mã cũ] = kiện cũ, move_out món 2, 1 create', () => {
    const plan = planResplit([pkg('a', 'reserved', 'X', ['1', '2'])], [group('X', ['1']), group('Y', ['2'])]);
    expect(plan.targets).toEqual(new Map([['X', 'a']]));
    expect(plan.steps).toEqual([
      { kind: 'move_out', packageId: 'a', orderLineIds: ['2'] },
      { kind: 'create', code: 'Y', replacesPackageId: 'a', awaitingOpen: false },
    ]);
  });

  it('kiện packed chia thành 2 mã mới: mark_drop mọi dòng, 2 create awaitingOpen true', () => {
    const plan = planResplit([pkg('a', 'packed', 'X', ['1', '2'])], [group('A', ['1']), group('B', ['2'])]);
    expect(plan.steps).toEqual([
      { kind: 'mark_drop', packageId: 'a', orderLineIds: ['1', '2'] },
      { kind: 'create', code: 'A', replacesPackageId: 'a', awaitingOpen: true },
      { kind: 'create', code: 'B', replacesPackageId: 'a', awaitingOpen: true },
    ]);
  });

  it('hai kiện chưa đóng về chung một mã mới: hai cancel_open, một create replaces kiện có nhiều món hơn (hoà thì mã nhỏ)', () => {
    const more = planResplit(
      [pkg('a', 'reserved', 'A', ['1']), pkg('b', 'backordered', 'B', ['2', '3'])],
      [group('N', ['1', '2', '3'])],
    );
    expect(more.steps).toEqual([
      { kind: 'cancel_open', packageId: 'a' },
      { kind: 'cancel_open', packageId: 'b' },
      { kind: 'create', code: 'N', replacesPackageId: 'b', awaitingOpen: false },
    ]);
    const tie = planResplit([pkg('b', 'reserved', 'B', ['2']), pkg('a', 'reserved', 'A', ['1'])], [group('N', ['1', '2'])]);
    expect(tie.steps.at(-1)).toEqual({ kind: 'create', code: 'N', replacesPackageId: 'a', awaitingOpen: false });
  });

  it('sàn gộp món của kiện B vào mã của kiện A: không lập, resplit true', () => {
    const plan = planResplit([pkg('a', 'reserved', 'A', ['1']), pkg('b', 'reserved', 'B', ['2'])], [group('A', ['1', '2'])]);
    expect(plan).toEqual(NO_PLAN);
  });

  it('một dòng đơn nằm ở hai nhóm: không lập, resplit true', () => {
    const plan = planResplit([pkg('a', 'reserved', 'X', ['1', '2'])], [group('X', ['1']), group('Y', ['1', '2'])]);
    expect(plan).toEqual(NO_PLAN);
  });

  it('nhóm có món của kiện in_transit: flag kiện đó một lần, nhóm không create, resplit true', () => {
    const plan = planResplit([pkg('t', 'in_transit', 'T', ['1', '2'])], [group('A', ['1']), group('B', ['2'])]);
    expect(plan.steps).toEqual([{ kind: 'flag', packageId: 't' }]);
    expect(plan.targets.size).toBe(0);
    expect(plan.resplit).toBe(true);
  });

  it('mã nhóm đang nằm ở kiện đã huỷ: clear_code kiện huỷ rồi create', () => {
    const plan = planResplit(
      [pkg('c', 'cancelled', 'X', ['9']), pkg('a', 'reserved', 'O', ['1', '2'])],
      [group('X', ['1']), group('Y', ['2'])],
    );
    expect(plan.steps).toEqual([
      { kind: 'clear_code', packageId: 'c' },
      { kind: 'cancel_open', packageId: 'a' },
      { kind: 'create', code: 'X', replacesPackageId: 'a', awaitingOpen: false },
      { kind: 'create', code: 'Y', replacesPackageId: 'a', awaitingOpen: false },
    ]);
  });

  it('mã sẽ gắn lại cho kiện khác đang nằm ở kiện đã huỷ: clear_code trước relabel', () => {
    const plan = planResplit([pkg('c', 'cancelled', 'X', ['9']), pkg('a', 'reserved', 'O', ['1'])], [group('X', ['1'])]);
    expect(plan.steps).toEqual([
      { kind: 'clear_code', packageId: 'c' },
      { kind: 'relabel', packageId: 'a', code: 'X' },
    ]);
  });

  it('kiện sống mất mã của nó cho kiện khác mà không nhận mã mới: clear_code kiện đó', () => {
    // Sàn đưa mã X của kiện a sang món 3 (kiện tạm b); món 1, 2 sang mã mới.
    const plan = planResplit(
      [pkg('a', 'reserved', 'X', ['1', '2']), pkg('b', 'backordered', null, ['3'])],
      [group('X', ['3']), group('Y', ['1', '2'])],
    );
    expect(plan.steps).toEqual([{ kind: 'relabel', packageId: 'b', code: 'X' }, { kind: 'relabel', packageId: 'a', code: 'Y' }]);
    const moved = planResplit(
      [pkg('a', 'reserved', 'X', ['1', '2']), pkg('b', 'backordered', null, ['3'])],
      [group('X', ['3']), group('Y', ['1']), group('Z', ['2'])],
    );
    expect(kinds(moved)).toEqual(['clear_code', 'relabel', 'cancel_open', 'create', 'create']);
    expect(moved.steps[0]).toEqual({ kind: 'clear_code', packageId: 'a' });
  });

  it('mã cần dùng đang nằm ở kiện đã bàn giao không đổi mã: không lập, resplit true', () => {
    const plan = planResplit(
      [pkg('t', 'in_transit', 'X', ['1']), pkg('a', 'reserved', null, ['2'])],
      [group('Y', ['1']), group('X', ['2'])],
    );
    expect(plan).toEqual(NO_PLAN);
  });

  it('món chưa có mã sàn (không trong nhóm nào) ở lại kiện: kiện cũ move_out phần chuyển đi, không cancel_open', () => {
    const plan = planResplit([pkg('a', 'reserved', 'O', ['1', '2'])], [group('A', ['1'])]);
    expect(plan.steps).toEqual([
      { kind: 'move_out', packageId: 'a', orderLineIds: ['1'] },
      { kind: 'create', code: 'A', replacesPackageId: 'a', awaitingOpen: false },
    ]);
  });

  it('dòng chờ bỏ không tính vào tập: kiện packed có một dòng chờ bỏ vẫn khớp nhóm gồm các dòng còn lại', () => {
    const plan = planResplit([pkg('p', 'packed', 'P', ['1', '2'], ['3'])], [group('P', ['1', '2'])]);
    expect(plan.steps).toEqual([]);
    expect(plan.targets).toEqual(new Map([['P', 'p']]));
    expect(plan.resplit).toBe(false);
  });

  it('thứ tự bước: clear_code, relabel, flag, cancel_open, move_out, mark_drop, create', () => {
    const packages = [
      pkg('c', 'cancelled', 'Z', ['9']),
      pkg('r', 'reserved', null, ['1']),
      pkg('t', 'in_transit', 'T', ['2', '8']),
      pkg('a', 'reserved', 'A', ['3', '4']),
      pkg('m', 'reserved', 'M', ['5', '6']),
      pkg('p', 'packed', 'P', ['7', '12']),
    ];
    const groups = [
      group('N3', ['7']),
      group('Z', ['3']),
      group('R1', ['1']),
      group('F', ['2']),
      group('M', ['5']),
      group('N2', ['6']),
      group('N1', ['4']),
      group('P', ['12']),
    ];
    const plan = planResplit(packages, groups);
    expect(kinds(plan)).toEqual(['clear_code', 'relabel', 'flag', 'cancel_open', 'move_out', 'mark_drop', 'create', 'create', 'create', 'create']);
    expect(plan.steps.filter((s) => s.kind === 'create').map((s) => s.kind === 'create' && s.code)).toEqual(['N1', 'N2', 'N3', 'Z']);
    expect(plan.targets).toEqual(new Map([['R1', 'r'], ['M', 'm'], ['P', 'p']]));
    expect(plan.resplit).toBe(true);
  });

  it('áp kế hoạch bằng tay rồi lập lại: steps rỗng (gọi lặp)', () => {
    const packages = [
      pkg('c', 'cancelled', 'Z', ['9']),
      pkg('r', 'reserved', null, ['1']),
      pkg('a', 'reserved', 'A', ['3', '4']),
      pkg('m', 'reserved', 'M', ['5', '6']),
      pkg('p', 'packed', 'P', ['7', '10']),
      pkg('q', 'awaiting_pickup', 'Q', ['11']),
    ];
    const groups = [group('N3', ['7']), group('Z', ['3']), group('R1', ['1']), group('M', ['5']), group('N2', ['6', '11']), group('N1', ['4', '10'])];
    const plan = planResplit(packages, groups);
    expect(plan.steps.length).toBeGreaterThan(0);
    const again = planResplit(apply(packages, groups, plan), groups);
    expect(again.steps).toEqual([]);
    expect(again.resplit).toBe(false);
    expect([...again.targets.keys()].sort()).toEqual(['M', 'N1', 'N2', 'N3', 'R1', 'Z']);
  });
});

describe('replacementPairs: kiện chờ thay (D9)', () => {
  it('replacementPairs: kiện mới ghép với dòng chờ bỏ ở kiện packed; kiện cũ đã cancelled hay reserved thì rỗng', () => {
    const fresh = [pkg('n', 'backordered', 'A', ['1']), pkg('k', 'backordered', 'B', ['2'])];
    expect(replacementPairs([pkg('o', 'packed', 'X', [], ['1', '2']), ...fresh], 'n')).toEqual([
      { newLineId: 'n-1', oldLineId: 'o-1', oldPackageId: 'o' },
    ]);
    expect(replacementPairs([pkg('o', 'awaiting_pickup', 'X', [], ['1', '2']), ...fresh], 'k')).toEqual([
      { newLineId: 'k-2', oldLineId: 'o-2', oldPackageId: 'o' },
    ]);
    expect(replacementPairs([pkg('o', 'cancelled', 'X', [], ['1', '2']), ...fresh], 'n')).toEqual([]);
    expect(replacementPairs([pkg('o', 'reserved', 'X', [], ['1', '2']), ...fresh], 'n')).toEqual([]);
    // Kiện cũ không phải kiện chờ thay của chính nó.
    expect(replacementPairs([pkg('o', 'packed', 'X', ['3'], ['1', '2']), ...fresh], 'o')).toEqual([]);
  });
});
