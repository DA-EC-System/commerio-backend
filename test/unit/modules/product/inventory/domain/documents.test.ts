import { describe, expect, it } from 'vitest';
import { activeRound, DOC_PREFIX, docNumber, mergeLines, sameLines } from '#src/modules/product/inventory/domain/documents.ts';

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

describe('so dòng đã gộp (lưới gọi lặp ship, Q12)', () => {
  it('cùng SKU, cùng số thì bằng', () => {
    expect(sameLines(new Map([['a', 3]]), new Map([['a', 3]]))).toBe(true);
  });

  it('khác số, thiếu hoặc thừa SKU thì khác', () => {
    expect(sameLines(new Map([['a', 3]]), new Map([['a', 2]]))).toBe(false);
    expect(
      sameLines(
        new Map([['a', 3]]),
        new Map([
          ['a', 3],
          ['b', 1],
        ]),
      ),
    ).toBe(false);
    expect(sameLines(new Map([['a', 3]]), new Map([['b', 3]]))).toBe(false);
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
