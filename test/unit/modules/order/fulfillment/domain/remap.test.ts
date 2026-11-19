import { describe, expect, it } from 'vitest';
import type { HandoverSource } from '#src/modules/order/fulfillment/domain/handover.ts';
import type { OpenPurpose } from '#src/modules/order/fulfillment/domain/open-purpose.ts';
import type { PackageStatus } from '#src/modules/order/fulfillment/domain/package.ts';
import { lineSkuOf, type MappedSku, nothingToHold, planRemap, type RemapPackage } from '#src/modules/order/fulfillment/domain/remap.ts';

const line = (o: { variantId?: string | null; stockUntracked?: boolean; reservedQty?: number; quantity?: number } = {}) => ({
  variantId: o.variantId ?? null,
  stockUntracked: o.stockUntracked ?? false,
  reservedQty: o.reservedQty ?? 0,
  quantity: o.quantity ?? 1,
});

describe('lineSkuOf, nothingToHold (spec 237)', () => {
  it('trạng thái ghép của một dòng', () => {
    expect(lineSkuOf(line({ variantId: 'v' }))).toEqual({ kind: 'variant', variantId: 'v' });
    expect(lineSkuOf(line({ stockUntracked: true }))).toEqual({ kind: 'untracked' });
    expect(lineSkuOf(line())).toEqual({ kind: 'unmapped' });
  });

  it('kiện không còn gì để giữ: không dòng chưa ghép và mọi dòng có biến thể đã giữ đủ', () => {
    expect(nothingToHold([line({ stockUntracked: true })])).toBe(true);
    expect(nothingToHold([line({ variantId: 'v', reservedQty: 0, quantity: 1 })])).toBe(false);
    expect(nothingToHold([line()])).toBe(false);
    expect(nothingToHold([line({ variantId: 'v', reservedQty: 1, quantity: 1 }), line({ stockUntracked: true })])).toBe(true);
    expect(nothingToHold([line({ variantId: 'v', reservedQty: 1, quantity: 2 })])).toBe(false);
  });
});

describe('planRemap (spec 237 bảng 1, 2, 3)', () => {
  type L = {
    variantId?: string | null;
    stockUntracked?: boolean;
    reservedQty?: number;
    quantity?: number;
    stockDeducted?: boolean;
    pendingDropQty?: number;
    remapPending?: boolean;
  };
  const pl = (id: string, o: L = {}) => ({
    id,
    orderLineId: `ol-${id}`,
    variantId: o.variantId ?? null,
    stockUntracked: o.stockUntracked ?? false,
    quantity: o.quantity ?? 1,
    reservedQty: o.reservedQty ?? 0,
    stockDeducted: o.stockDeducted ?? false,
    pendingDropQty: o.pendingDropQty ?? 0,
    remapPending: o.remapPending ?? false,
  });
  const pkg = (
    status: PackageStatus,
    lines: RemapPackage['lines'],
    o: { handedOverAt?: Date | null; handoverSource?: HandoverSource | null; needsOpen?: boolean; openPurpose?: OpenPurpose | null } = {},
  ): RemapPackage => ({
    status,
    handedOverAt: o.handedOverAt ?? null,
    handoverSource: o.handoverSource ?? null,
    needsOpen: o.needsOpen ?? false,
    openPurpose: o.openPurpose ?? null,
    lines,
  });
  const V: MappedSku = { kind: 'variant', variantId: 'v' };
  const U: MappedSku = { kind: 'untracked' };
  const to = (...pairs: [string, MappedSku][]) => new Map(pairs.map(([id, sku]) => [`ol-${id}`, sku]));
  const HOLD = { holdStock: true, orderCutoffAt: null };
  const NO_HOLD = { holdStock: false, orderCutoffAt: null };
  const cutoff = new Date('2026-11-10T00:00:00Z');
  const after = new Date('2026-11-11T00:00:00Z');
  const before = new Date('2026-11-09T00:00:00Z');

  it('kiện cancelled, returned: ghi dòng, không đụng tồn, không báo giao', () => {
    for (const status of ['cancelled', 'returned'] as const) {
      const plan = planRemap(pkg(status, [pl('a')]), to(['a', V]), HOLD);
      expect(plan.writes).toEqual([{ lineId: 'a', to: V }]);
      expect(plan.stock).toEqual({ kind: 'none' });
      expect(plan.reportDelivered).toBe(false);
      expect(plan.outcomes.get('a')).toBe('applied');
    }
  });

  it('kiện backordered, dòng duy nhất sang không quản tồn: hold', () => {
    expect(planRemap(pkg('backordered', [pl('a')]), to(['a', U]), HOLD).stock).toEqual({ kind: 'hold' });
  });

  it('kiện backordered có biến thể: xếp phân hàng cho mọi biến thể của kiện, xếp tăng, không trùng', () => {
    const p = pkg('backordered', [pl('a'), pl('b', { variantId: 'w' }), pl('c', { variantId: 'v' })]);
    expect(planRemap(p, to(['a', V]), HOLD).stock).toEqual({ kind: 'allocate', variantIds: ['v', 'w'] });
  });

  it('kiện backordered còn dòng chưa ghép khác (Review Focus 1): xếp phân hàng, không hold', () => {
    const plan = planRemap(pkg('backordered', [pl('a'), pl('b')]), to(['a', V]), HOLD);
    expect(plan.stock).toEqual({ kind: 'allocate', variantIds: ['v'] });
  });

  it('kiện reserved, dòng sang biến thể: giữ dòng mới; chờ kiểm kê thì nhả kiện (reclaim)', () => {
    const p = pkg('reserved', [pl('a'), pl('b', { variantId: 'w', reservedQty: 1 })]);
    expect(planRemap(p, to(['a', V]), HOLD).stock).toEqual({ kind: 'reserve_new', lineIds: ['a'], sealed: false });
    expect(planRemap(p, to(['a', V]), NO_HOLD).stock).toEqual({ kind: 'reclaim' });
  });

  it('kiện đã đóng của gian hàng chờ kiểm kê: không đụng tồn', () => {
    const p = pkg('packed', [pl('a'), pl('b', { variantId: 'w', reservedQty: 1 })]);
    expect(planRemap(p, to(['a', V]), NO_HOLD).stock).toEqual({ kind: 'none' });
  });

  it('kiện đã đóng đang giữ dòng khác: giữ dòng mới (sealed); không giữ dòng nào: xếp phân hàng mọi biến thể của kiện (P2)', () => {
    for (const status of ['packed', 'awaiting_pickup'] as const) {
      const held = pkg(status, [pl('a'), pl('b', { variantId: 'w', reservedQty: 1 })]);
      expect(planRemap(held, to(['a', V]), HOLD).stock).toEqual({ kind: 'reserve_new', lineIds: ['a'], sealed: true });
      const empty = pkg(status, [pl('a'), pl('b', { variantId: 'w' })]);
      expect(planRemap(empty, to(['a', V]), HOLD).stock).toEqual({ kind: 'allocate', variantIds: ['v', 'w'] });
    }
  });

  it('kiện đã đóng chưa giữ dòng nào, dòng chưa ghép cuối sang không quản tồn: xếp phân hàng mọi biến thể (review I1); còn dòng chưa ghép khác thì không', () => {
    for (const status of ['packed', 'awaiting_pickup'] as const) {
      const last = pkg(status, [pl('a'), pl('b', { variantId: 'w' })]);
      expect(planRemap(last, to(['a', U]), HOLD).stock).toEqual({ kind: 'allocate', variantIds: ['w'] });
      const more = pkg(status, [pl('a'), pl('b', { variantId: 'w' }), pl('c')]);
      expect(planRemap(more, to(['a', U]), HOLD).stock).toEqual({ kind: 'none' });
      expect(planRemap(last, to(['a', U]), NO_HOLD).stock).toEqual({ kind: 'none' });
    }
  });

  it('kiện reserved, packed, dòng sang không quản tồn: không đụng tồn', () => {
    for (const status of ['reserved', 'packed'] as const) {
      const p = pkg(status, [pl('a'), pl('b', { variantId: 'w', reservedQty: 1 })]);
      expect(planRemap(p, to(['a', U]), HOLD).stock).toEqual({ kind: 'none' });
    }
  });

  it('kiện đã rời kho từ mốc trở đi, hoặc mốc null: trừ dòng mới (ship)', () => {
    const p = pkg('in_transit', [pl('a')], { handedOverAt: after, handoverSource: 'marketplace' });
    expect(planRemap(p, to(['a', V]), { holdStock: true, orderCutoffAt: cutoff }).stock).toEqual({ kind: 'ship' });
    expect(planRemap(p, to(['a', V]), HOLD).stock).toEqual({ kind: 'ship' });
    const atCutoff = pkg('in_transit', [pl('a')], { handedOverAt: cutoff, handoverSource: 'marketplace' });
    expect(planRemap(atCutoff, to(['a', V]), { holdStock: true, orderCutoffAt: cutoff }).stock).toEqual({ kind: 'ship' });
  });

  it('kiện rời kho trước mốc chưa dòng nào trừ: chỉ ghi mốc (store_only, 16c); có dòng đã trừ: ship (P3)', () => {
    const opts = { holdStock: true, orderCutoffAt: cutoff };
    const fresh = pkg('in_transit', [pl('a')], { handedOverAt: before, handoverSource: 'marketplace' });
    expect(planRemap(fresh, to(['a', V]), opts).stock).toEqual({ kind: 'store_only' });
    const deducted = pkg('in_transit', [pl('a'), pl('b', { variantId: 'w', stockDeducted: true })], { handedOverAt: before, handoverSource: 'forced' });
    expect(planRemap(deducted, to(['a', V]), opts).stock).toEqual({ kind: 'ship' });
  });

  it('kiện đã mang before_cutoff: không đụng tồn', () => {
    const p = pkg('in_transit', [pl('a')], { handedOverAt: before, handoverSource: 'before_cutoff' });
    expect(planRemap(p, to(['a', V]), { holdStock: true, orderCutoffAt: cutoff }).stock).toEqual({ kind: 'none' });
  });

  it('kiện đã rời kho của gian hàng chờ kiểm kê: không đụng tồn (hàm bù lo, D8)', () => {
    const p = pkg('in_transit', [pl('a')], { handedOverAt: after, handoverSource: 'marketplace' });
    expect(planRemap(p, to(['a', V]), NO_HOLD).stock).toEqual({ kind: 'none' });
  });

  it('kiện delivered: dòng sang biến thể thì ship rồi báo giao; sang không quản tồn thì chỉ báo giao', () => {
    const p = pkg('delivered', [pl('a')], { handedOverAt: after, handoverSource: 'marketplace' });
    expect(planRemap(p, to(['a', V]), HOLD)).toMatchObject({ stock: { kind: 'ship' }, reportDelivered: true });
    expect(planRemap(p, to(['a', U]), HOLD)).toMatchObject({ stock: { kind: 'none' }, reportDelivered: true });
  });

  // PR 1 trả `kept` cho dòng đã ghép khác ghép mới (P1); từ PR 2 đổi ghép đi bảng 2, 3 (ca D2-G10 trở đi). Ca này giữ
  // phần còn đúng: đã đúng ghép mới thì không ghi, kiện đã rời kho giữ ghép cũ.
  it('dòng kiện đã ghép khác ghép mới ở kiện đã rời kho: kept, không ghi; đã đúng ghép mới: applied, không ghi; dòng ngoài changes không có kết quả', () => {
    const p = pkg('in_transit', [pl('a', { variantId: 'w', stockDeducted: true }), pl('b', { stockUntracked: true }), pl('c')], {
      handedOverAt: after,
      handoverSource: 'scan',
    });
    const plan = planRemap(p, to(['a', V], ['b', U]), HOLD);
    expect(plan.writes).toEqual([]);
    expect(plan.outcomes).toEqual(
      new Map([
        ['a', 'kept'],
        ['b', 'applied'],
      ]),
    );
    expect(plan.stock).toEqual({ kind: 'none' });
  });

  // Đổi ghép đã dùng (spec 237 §5.5 bảng 2, 3; §5.6; D24, D26). A = 'a1', B = 'v'.
  const A = 'a1';
  const B: MappedSku = V;

  it('D2-G10 bảng 2 reserved giữ A → B: writes B, releases A đủ số, stock reserve_new không sealed, allocateAlso = [A]', () => {
    const plan = planRemap(pkg('reserved', [pl('a', { variantId: A, reservedQty: 2, quantity: 2 })]), to(['a', B]), HOLD);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.releases).toEqual([{ lineId: 'a', variantId: A, quantity: 2 }]);
    expect(plan.stock).toEqual({ kind: 'reserve_new', lineIds: ['a'], sealed: false });
    expect(plan.allocateAlso).toEqual([A]);
    expect(plan.outcomes.get('a')).toBe('applied');
    expect(plan.marks).toEqual([]);
    expect(plan.purpose).toBeNull();
  });

  it('D2-G10 bảng 2 backordered giữ một phần A → B: releases phần đang giữ, writes, stock allocate gồm B, allocateAlso có A', () => {
    const p = pkg('backordered', [pl('a', { variantId: A, reservedQty: 1 }), pl('b', { variantId: 'w' })]);
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.releases).toEqual([{ lineId: 'a', variantId: A, quantity: 1 }]);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.stock).toEqual({ kind: 'allocate', variantIds: ['v', 'w'] });
    expect(plan.allocateAlso).toEqual([A]);
  });

  it('D2-G11 bảng 2 packed giữ A → B: không writes, marks = [dòng], purpose remap, outcome needs_unload, stock none', () => {
    const plan = planRemap(pkg('packed', [pl('a', { variantId: A, reservedQty: 1 })]), to(['a', B]), HOLD);
    expect(plan.writes).toEqual([]);
    expect(plan.releases).toEqual([]);
    expect(plan.marks).toEqual(['a']);
    expect(plan.purpose).toEqual({ needsOpen: true, openPurpose: 'remap' });
    expect(plan.outcomes.get('a')).toBe('needs_unload');
    expect(plan.stock).toEqual({ kind: 'none' });
    expect(plan.allocateAlso).toEqual([]);
  });

  it('D2-G11 bảng 2 packed đã có dấu, mục đích remap → B lần nữa: không marks, purpose null (19e)', () => {
    const p = pkg('awaiting_pickup', [pl('a', { variantId: A, reservedQty: 1, remapPending: true })], { needsOpen: true, openPurpose: 'remap' });
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.marks).toEqual([]);
    expect(plan.unmarks).toEqual([]);
    expect(plan.purpose).toBeNull();
    expect(plan.outcomes.get('a')).toBe('needs_unload');
  });

  it('D2-G11 bảng 2 packed mục đích stocktake → B: purpose thành remap (19b)', () => {
    const p = pkg('packed', [pl('a', { variantId: A, reservedQty: 1 })], { needsOpen: true, openPurpose: 'stocktake' });
    expect(planRemap(p, to(['a', B]), HOLD).purpose).toEqual({ needsOpen: true, openPurpose: 'remap' });
  });

  it('D2-G11 bảng 2 packed mục đích edit → B: marks, purpose null (giữ edit)', () => {
    const p = pkg('packed', [pl('a', { variantId: A, reservedQty: 1 })], { needsOpen: true, openPurpose: 'edit' });
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.marks).toEqual(['a']);
    expect(plan.purpose).toBeNull();
  });

  it('D2-G12 đổi về như cũ: dòng có dấu, from = to → unmarks, purpose stocktake, allocateAlso = biến thể của kiện (20b)', () => {
    const p = pkg('packed', [pl('a', { variantId: A, reservedQty: 1, remapPending: true }), pl('b', { variantId: 'w', reservedQty: 1 })], {
      needsOpen: true,
      openPurpose: 'remap',
    });
    const plan = planRemap(p, to(['a', { kind: 'variant', variantId: A }]), HOLD);
    expect(plan.unmarks).toEqual(['a']);
    expect(plan.marks).toEqual([]);
    expect(plan.writes).toEqual([]);
    expect(plan.outcomes.get('a')).toBe('applied');
    expect(plan.purpose).toEqual({ needsOpen: true, openPurpose: 'stocktake' });
    expect(plan.allocateAlso).toEqual([A, 'w']);
  });

  it('D2-G12 hai dòng có dấu, đổi một về như cũ: unmarks một, purpose null (20c)', () => {
    const p = pkg(
      'packed',
      [pl('a', { variantId: A, reservedQty: 1, remapPending: true }), pl('b', { variantId: 'w', reservedQty: 1, remapPending: true })],
      { needsOpen: true, openPurpose: 'remap' },
    );
    const plan = planRemap(p, to(['a', { kind: 'variant', variantId: A }]), HOLD);
    expect(plan.unmarks).toEqual(['a']);
    expect(plan.purpose).toBeNull();
    expect(plan.allocateAlso).toEqual([]);
  });

  it('D2-G14 bảng 2 in_transit đã trừ A: kept, không ghi gì (22)', () => {
    const p = pkg('in_transit', [pl('a', { variantId: A, stockDeducted: true })], { handedOverAt: after, handoverSource: 'scan' });
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.outcomes.get('a')).toBe('kept');
    expect(plan).toMatchObject({ writes: [], releases: [], marks: [], unmarks: [], purpose: null, allocateAlso: [], stock: { kind: 'none' } });
  });

  it('D2-G14 bảng 2 kiện cancelled: không có trong outcomes (22a)', () => {
    const plan = planRemap(pkg('cancelled', [pl('a', { variantId: A })]), to(['a', B]), HOLD);
    expect(plan.outcomes.has('a')).toBe(false);
    expect(plan.writes).toEqual([]);
  });

  it('D2-G14 dòng đã ghép chờ bỏ: không có trong outcomes, không marks', () => {
    const p = pkg('packed', [pl('a', { variantId: A, reservedQty: 1, pendingDropQty: 1 })], { needsOpen: true, openPurpose: 'edit' });
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.outcomes.has('a')).toBe(false);
    expect(plan.marks).toEqual([]);
    expect(plan.purpose).toBeNull();
  });

  it('D2-G15 bảng 2 reserved giữ A → không quản tồn: writes untracked, releases A, stock none, allocateAlso [A] (23)', () => {
    const plan = planRemap(pkg('reserved', [pl('a', { variantId: A, reservedQty: 1 })]), to(['a', U]), HOLD);
    expect(plan.writes).toEqual([{ lineId: 'a', to: U }]);
    expect(plan.releases).toEqual([{ lineId: 'a', variantId: A, quantity: 1 }]);
    expect(plan.stock).toEqual({ kind: 'none' });
    expect(plan.allocateAlso).toEqual([A]);
  });

  it('D2-G15 bảng 3 backordered untracked → B: writes, stock allocate (24)', () => {
    const plan = planRemap(pkg('backordered', [pl('a', { stockUntracked: true })]), to(['a', B]), HOLD);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.stock).toEqual({ kind: 'allocate', variantIds: ['v'] });
    expect(plan.outcomes.get('a')).toBe('applied');
  });

  it('D2-G15 bảng 3 packed untracked → B, kiện đang giữ dòng khác: writes, stock reserve_new sealed (24a)', () => {
    const p = pkg('packed', [pl('a', { stockUntracked: true }), pl('b', { variantId: 'w', reservedQty: 1 })]);
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.stock).toEqual({ kind: 'reserve_new', lineIds: ['a'], sealed: true });
    expect(plan.marks).toEqual([]);
    expect(plan.purpose).toBeNull();
  });

  it('D2-G15 bảng 3 in_transit: kept', () => {
    const p = pkg('in_transit', [pl('a', { stockUntracked: true })], { handedOverAt: after, handoverSource: 'scan' });
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.outcomes.get('a')).toBe('kept');
    expect(plan.writes).toEqual([]);
  });

  it('D2-G18 dòng chờ thay (awaitingLineIds) → kept; kiện backordered có dòng chờ thay không hold dù dòng khác sang không quản tồn (18b, D26)', () => {
    const awaitingLineIds = new Set(['a']);
    const kept = planRemap(pkg('backordered', [pl('a', { variantId: A }), pl('b')]), to(['a', B]), { ...HOLD, awaitingLineIds });
    expect(kept.outcomes.get('a')).toBe('kept');
    expect(kept.writes).toEqual([]);
    // Không có dòng chờ thay thì vẫn như PR 1: mọi dòng có biến thể đã giữ, dòng cuối sang "không quản tồn" → hold.
    const free = planRemap(pkg('backordered', [pl('a', { variantId: A, reservedQty: 1 }), pl('b')]), to(['b', U]), HOLD);
    expect(free.stock).toEqual({ kind: 'hold' });
    const awaited = planRemap(pkg('backordered', [pl('a', { variantId: A, reservedQty: 1 }), pl('b')]), to(['b', U]), { ...HOLD, awaitingLineIds });
    expect(awaited.writes).toEqual([{ lineId: 'b', to: U }]);
    expect(awaited.stock).not.toEqual({ kind: 'hold' });
  });

  it('D2-G10 holdStock false, reserved giữ A → B: không releases', () => {
    const plan = planRemap(pkg('reserved', [pl('a', { variantId: A, reservedQty: 1 })]), to(['a', B]), NO_HOLD);
    expect(plan.releases).toEqual([]);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.allocateAlso).toEqual([]);
  });

  it('D2-G10 reserved hai dòng A, B; A → B: writes dòng A, releases A, reserve_new chỉ dòng vừa đổi', () => {
    const p = pkg('reserved', [pl('a', { variantId: A, reservedQty: 1 }), pl('b', { variantId: 'v', reservedQty: 1 })]);
    const plan = planRemap(p, to(['a', B]), HOLD);
    expect(plan.writes).toEqual([{ lineId: 'a', to: B }]);
    expect(plan.releases).toEqual([{ lineId: 'a', variantId: A, quantity: 1 }]);
    expect(plan.stock).toEqual({ kind: 'reserve_new', lineIds: ['a'], sealed: false });
  });
});
