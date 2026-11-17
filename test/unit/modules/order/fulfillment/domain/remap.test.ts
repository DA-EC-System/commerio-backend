import { describe, expect, it } from 'vitest';
import type { HandoverSource } from '#src/modules/order/fulfillment/domain/handover.ts';
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

describe('planRemap: ghép lần đầu (spec 237 bảng 1)', () => {
  type L = { variantId?: string | null; stockUntracked?: boolean; reservedQty?: number; quantity?: number; stockDeducted?: boolean };
  const pl = (id: string, o: L = {}) => ({
    id,
    orderLineId: `ol-${id}`,
    variantId: o.variantId ?? null,
    stockUntracked: o.stockUntracked ?? false,
    quantity: o.quantity ?? 1,
    reservedQty: o.reservedQty ?? 0,
    stockDeducted: o.stockDeducted ?? false,
  });
  const pkg = (
    status: PackageStatus,
    lines: RemapPackage['lines'],
    o: { handedOverAt?: Date | null; handoverSource?: HandoverSource | null } = {},
  ): RemapPackage => ({ status, handedOverAt: o.handedOverAt ?? null, handoverSource: o.handoverSource ?? null, lines });
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

  it('dòng kiện đã ghép khác ghép mới: kept, không ghi (P1); đã đúng ghép mới: applied, không ghi; dòng ngoài changes không có kết quả', () => {
    const p = pkg('backordered', [pl('a', { variantId: 'w' }), pl('b', { stockUntracked: true }), pl('c')]);
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
});
