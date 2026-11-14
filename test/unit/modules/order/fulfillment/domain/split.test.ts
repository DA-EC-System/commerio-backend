import { describe, expect, it } from 'vitest';
import { SplitBody } from '#src/modules/order/fulfillment/api/schemas.ts';
import { carveLine, planSplit } from '#src/modules/order/fulfillment/domain/split.ts';

const A = '0b5f3c1e-8a52-4f0e-9a7d-1c2b3d4e5f60';
const B = '7e6d5c4b-3a29-4180-9f7e-6d5c4b3a2918';
const l = (id: string, variantId: string | null, quantity = 1, reservedQty = 0) =>
  ({ id, orderLineId: 'ol-' + id, variantId, quantity, reservedQty });

describe('luật chia kiện (spec 205 §5.2)', () => {
  it('chuyển nguyên dòng theo thứ tự dòng vào', () =>
    expect(planSplit([l('1', A), l('2', A), l('3', B)], [[{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: true, moves: [[{ lineId: '1', quantity: 1 }]] }));

  it('mỗi phần thành một kiện mới, cùng SKU ở hai phần được với unit', () =>
    expect(planSplit([l('1', A), l('2', A), l('3', B)], [[{ variantId: A, quantity: 1 }], [{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: true, moves: [[{ lineId: '1', quantity: 1 }], [{ lineId: '2', quantity: 1 }]] }));

  it('D12: dòng số lượng lớn chỉ lấy một phần', () =>
    expect(planSplit([l('1', A, 3, 3)], [[{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: true, moves: [[{ lineId: '1', quantity: 1 }]] }));

  it('carveLine chia cả phần giữ theo nguyên dòng', () => {
    expect(carveLine({ quantity: 3, reservedQty: 3 }, 1)).toEqual({ keep: { quantity: 2, reservedQty: 2 }, moved: { quantity: 1, reservedQty: 1 } });
    expect(carveLine({ quantity: 3, reservedQty: 0 }, 1)).toEqual({ keep: { quantity: 2, reservedQty: 0 }, moved: { quantity: 1, reservedQty: 0 } });
  });

  it('SKU không có trong kiện', () =>
    expect(planSplit([l('1', A), l('2', A)], [[{ variantId: B, quantity: 1 }]], 'unit'))
      .toEqual({ ok: false, code: 'validation_failed', errors: { 'parts.0.0.variantId': 'SKU không có trong kiện' } }));

  it('tổng xin chuyển qua các phần vượt số trong kiện', () =>
    expect(planSplit([l('1', A), l('2', B)], [[{ variantId: A, quantity: 1 }], [{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: false, code: 'validation_failed', errors: { 'parts.1.0.quantity': 'Vượt số lượng trong kiện' } }));

  it('AC9: kiện cũ hết món', () =>
    expect(planSplit([l('1', A)], [[{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: false, code: 'validation_failed', errors: { parts: 'Kiện cũ phải còn ít nhất một món' } }));

  it('dòng chưa ghép ở lại kiện cũ và được tính là món', () =>
    expect(planSplit([l('1', A), l('2', null)], [[{ variantId: A, quantity: 1 }]], 'unit'))
      .toEqual({ ok: true, moves: [[{ lineId: '1', quantity: 1 }]] }));

  it.each([
    ['chuyển một phần của SKU', [[{ variantId: A, quantity: 1 }]]],
    ['cùng SKU ở hai phần', [[{ variantId: A, quantity: 1 }], [{ variantId: A, quantity: 1 }]]],
  ])('AC5 sku: %s thì split_not_supported', (_, parts) =>
    expect(planSplit([l('1', A), l('2', A), l('3', B)], parts, 'sku'))
      .toEqual({ ok: false, code: 'split_not_supported', message: 'Sàn chỉ cho tách theo SKU, không tách đôi cùng một SKU' }));

  it('sku: chuyển trọn một SKU', () =>
    expect(planSplit([l('1', A), l('2', A), l('3', B)], [[{ variantId: A, quantity: 2 }]], 'sku'))
      .toEqual({ ok: true, moves: [[{ lineId: '1', quantity: 1 }, { lineId: '2', quantity: 1 }]] }));
});

describe('SplitBody', () => {
  const part = (variantId = A, quantity = 1) => ({ variantId, quantity });

  it('nhận body hợp lệ', () => expect(SplitBody.safeParse({ version: 0, parts: [[part(A), part(B)]] }).success).toBe(true));

  it('variantId lặp trong một phần thì lỗi tại đúng dòng', () => {
    const result = SplitBody.safeParse({ version: 0, parts: [[part(A), part(A)]] });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.path)).toContainEqual(['parts', 0, 1, 'variantId']);
  });

  it('parts rỗng thì lỗi', () => expect(SplitBody.safeParse({ version: 0, parts: [] }).success).toBe(false));

  it('21 phần thì lỗi', () =>
    expect(SplitBody.safeParse({ version: 0, parts: Array.from({ length: 21 }, () => [part()]) }).success).toBe(false));

  it('quantity 0 thì lỗi', () => expect(SplitBody.safeParse({ version: 0, parts: [[part(A, 0)]] }).success).toBe(false));
});
