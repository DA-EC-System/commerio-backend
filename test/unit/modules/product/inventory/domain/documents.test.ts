import { describe, expect, it } from 'vitest';
import { activeRound, DOC_PREFIX, docNumber, matchShipment, mergeLines } from '#src/modules/product/inventory/domain/documents.ts';

// Luật thuần của phiếu do hệ thống lập theo kiện (spec #206 Q12, Q17, Q18).

describe('số phiếu (Q18)', () => {
  it('ghép tiền tố, đệm 6 chữ số; quá 6 chữ số thì giữ nguyên', () => {
    expect(docNumber('XK', 1)).toBe('XK-000001');
    expect(docNumber('DX', 1234567)).toBe('DX-1234567');
  });

  it('mỗi loại phiếu do hệ thống lập một tiền tố riêng', () => {
    expect(DOC_PREFIX).toEqual({ shipment: 'XK', shipment_reversal: 'DX', return_inspection: 'KT' });
  });
});

describe('gộp dòng theo SKU', () => {
  it('cộng số lượng của cùng SKU', () => {
    expect(
      mergeLines([
        { variantId: 'a', quantity: 2 },
        { variantId: 'b', quantity: 1 },
        { variantId: 'a', quantity: 3 },
      ]),
    ).toEqual(
      new Map([
        ['a', 5],
        ['b', 1],
      ]),
    );
  });

  it('không có dòng thì Map rỗng', () => {
    expect(mergeLines([])).toEqual(new Map());
  });

  it.each([0, -1, 1.5, Number.NaN])('từ chối quantity %s, lỗi có SKU', (q) => {
    expect(() => mergeLines([{ variantId: 'sku-a', quantity: q }])).toThrow(/sku-a/);
  });
});

describe('lưới gọi lặp ship theo id dòng kiện (Q12)', () => {
  const doc = (n: number, lineIds: string[]) => ({ n, lineIds });

  it('chưa dòng nào trừ trong lượt thì là lần mới, kể cả dòng mới cùng SKU, số với lần trước', () => {
    expect(matchShipment([], ['x'])).toEqual({ kind: 'new' });
    expect(matchShipment([doc(1, ['x'])], ['y'])).toEqual({ kind: 'new' });
  });

  it('đúng tập dòng của một phiếu (không kể thứ tự) thì là gọi lặp, trả phiếu đó', () => {
    expect(matchShipment([doc(1, ['x'])], ['x'])).toEqual({ kind: 'repeat', doc: doc(1, ['x']) });
    expect(matchShipment([doc(1, ['x', 'z']), doc(2, ['y'])], ['z', 'x'])).toEqual({ kind: 'repeat', doc: doc(1, ['x', 'z']) });
  });

  it('lẫn dòng đã trừ với dòng mới, thiếu dòng của phiếu, hoặc trải nhiều phiếu thì là xung đột, kèm id dòng đã trừ', () => {
    expect(matchShipment([doc(1, ['x'])], ['x', 'y'])).toEqual({ kind: 'conflict', lineIds: ['x'] });
    expect(matchShipment([doc(1, ['x', 'z'])], ['x'])).toEqual({ kind: 'conflict', lineIds: ['x'] });
    expect(matchShipment([doc(1, ['x']), doc(2, ['y'])], ['x', 'y'])).toEqual({ kind: 'conflict', lineIds: ['x', 'y'] });
  });
});

describe('lượt đang xuất của kiện (Q17)', () => {
  const xk = (n: number) => ({ kind: 'shipment' as const, n });
  const dx = (n: number) => ({ kind: 'shipment_reversal' as const, n });

  it('là các phiếu xuất sau phiếu đảo cuối cùng', () => {
    expect(activeRound([xk(1), dx(1), xk(2), xk(3)])).toEqual([xk(2), xk(3)]);
  });

  it('chưa đảo lần nào thì là mọi phiếu xuất', () => {
    expect(activeRound([xk(1)])).toEqual([xk(1)]);
  });

  it('vừa đảo xong, hoặc chưa có phiếu, thì rỗng', () => {
    expect(activeRound([xk(1), dx(1)])).toEqual([]);
    expect(activeRound([])).toEqual([]);
  });
});
