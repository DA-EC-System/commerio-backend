import { Decimal } from 'decimal.js';
import { describe, expect, it, vi } from 'vitest';
import { type CatalogContext, standardPricesOf } from '#src/modules/product/catalog/index.ts';
import { AppError } from '#src/shared/errors/app-error.ts';

const authorize = (() => () => undefined) as unknown as CatalogContext['authorize'];

// Giá chuẩn trong chi tiết sản phẩm (V22) đi vào catalog qua hàm tiêm (plan chuẩn bị A12, K4).
describe('standardPricesOf', () => {
  it('ctx chưa có standardPrices thì mọi biến thể có giá null, không lỗi', async () => {
    const prices = await standardPricesOf({ authorize }, ['a', 'b']);
    expect([...prices]).toEqual([
      ['a', null],
      ['b', null],
    ]);
  });

  it('pricing chưa làm (hàm tiêm báo 501 not_implemented) thì giá null, không lỗi', async () => {
    const standardPrices = async () => {
      throw new AppError(501, 'not_implemented', 'getStandardPrices chưa làm (#14)');
    };
    const prices = await standardPricesOf({ authorize, standardPrices }, ['a']);
    expect([...prices]).toEqual([['a', null]]);
  });

  it('lỗi khác của hàm tiêm vẫn ném ra', async () => {
    const standardPrices = async () => {
      throw new Error('mất kết nối');
    };
    await expect(standardPricesOf({ authorize, standardPrices }, ['a'])).rejects.toThrow('mất kết nối');
  });

  it('trả giá của hàm tiêm; id hàm tiêm không trả thì null', async () => {
    const standardPrices = vi.fn(async () => new Map([['a', new Decimal(150000)]]));
    const prices = await standardPricesOf({ authorize, standardPrices }, ['a', 'b']);
    expect(standardPrices).toHaveBeenCalledWith(['a', 'b']);
    expect(prices.get('a')?.toFixed(2)).toBe('150000.00');
    expect(prices.get('b')).toBeNull();
  });
});
