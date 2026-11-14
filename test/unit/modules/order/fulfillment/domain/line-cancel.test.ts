import { describe, expect, it } from 'vitest';
import { planLineCancel } from '#src/modules/order/fulfillment/domain/line-cancel.ts';

const l = (id: string, pendingDropQty = 0) => ({ id, orderLineId: 'ol-' + id, variantId: 'v', quantity: 1, reservedQty: 1, pendingDropQty });

describe('xét huỷ dòng theo kiện (spec 205 §5.10, D16)', () => {
  it('không món nào bị huỷ', () => expect(planLineCancel('reserved', [l('1'), l('2')], new Set())).toEqual({ kind: 'none' }));

  it.each(['backordered', 'reserved'] as const)('kiện %s, một phần món bị huỷ thì xoá dòng', (s) =>
    expect(planLineCancel(s, [l('1'), l('2')], new Set(['ol-2']))).toEqual({ kind: 'drop', lines: [l('2')] }));

  it.each(['packed', 'awaiting_pickup'] as const)('kiện %s, một phần món bị huỷ thì chờ bỏ', (s) =>
    expect(planLineCancel(s, [l('1'), l('2')], new Set(['ol-2']))).toEqual({ kind: 'pending', lines: [l('2')], fresh: [l('2')] }));

  it('dòng đã chờ bỏ không đánh dấu lại', () =>
    expect(planLineCancel('packed', [l('1'), l('2', 1)], new Set(['ol-2']))).toEqual({ kind: 'pending', lines: [l('2', 1)], fresh: [] }));

  it('mọi dòng bị huỷ là whole', () => expect(planLineCancel('reserved', [l('1'), l('2')], new Set(['ol-1', 'ol-2']))).toEqual({ kind: 'whole' }));

  it.each(['in_transit', 'delivered', 'returning', 'cancelled'] as const)('AC18: kiện %s không xét huỷ dòng', (s) =>
    expect(planLineCancel(s, [l('1'), l('2')], new Set(['ol-2']))).toEqual({ kind: 'none' }));
});
