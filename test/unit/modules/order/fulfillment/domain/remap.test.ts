import { describe, expect, it } from 'vitest';
import { lineSkuOf, nothingToHold } from '#src/modules/order/fulfillment/domain/remap.ts';

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
