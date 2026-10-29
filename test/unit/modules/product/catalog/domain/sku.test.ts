import { describe, expect, it } from 'vitest';
import { renderSku, skuPatternError, valueCode } from '#src/modules/product/catalog/domain/sku.ts';

// Bộ ví dụ dùng chung với FE (Documents/21 mục 9). Sai một ký tự là SKU thật khác bản xem trước.
describe('renderSku theo bảng 9.1', () => {
  it.each([
    ['AO-{SEQ:4}-{VAL}', 12, ['Đen', 'XL'], 'AO-0012-DEN-XL'],
    ['AO-{SEQ}-{VAL}', 3, [], 'AO-0003'],
    ['{VAL}-{SEQ:6}', 1, ['Xanh navy', 'M'], 'XANHNA-M-000001'],
    ['QUAN_{SEQ:3}', 7, ['Trắng'], 'QUAN_007'],
    ['GIAY-{SEQ:2}-{VAL}', 123, ['Size 42'], 'GIAY-123-SIZE42'],
    ['MP-{VAL}-{SEQ:5}', 45, ['Hồng đất', '50ml'], 'MP-HONGDA-50ML-00045'],
    ['DC{SEQ:1}{VAL}', 9, ['Đỏ'], 'DC9DO'],
  ])('%s, số %i → %s', (pattern, seq, values, sku) => {
    expect(renderSku(pattern, seq, values.map(valueCode))).toBe(sku);
  });

  // Đo từ FE `src/utils/sku.ts` (ground-truth #12): gộp chuỗi dấu nối, giữ ký tự cuối của chuỗi, cắt hai đầu, trim.
  it.each([
    ['AO--{SEQ}', 'AO-0005'],
    ['_AO-{SEQ}_', 'AO-0005'],
    ['AO-_{SEQ}', 'AO_0005'],
    [' AO-{SEQ} ', 'AO-0005'],
  ])('gộp dấu nối như FE: %s → %s', (pattern, sku) => {
    expect(renderSku(pattern, 5, [])).toBe(sku);
  });
});

describe('valueCode theo bảng 9.2', () => {
  it.each([
    ['Xanh navy', 'XANHNA'],
    ['Xanh nhạt', 'XANHNH'],
    ['Đỏ đô', 'DODO'],
    ['Size 42', 'SIZE42'],
    ['50ml', '50ML'],
    ['Ấm áp', 'AMAP'],
  ])('%s → %s', (value, code) => {
    expect(valueCode(value)).toBe(code);
  });

  it('giá trị không có chữ hay số cho mã rỗng', () => {
    expect(valueCode('---')).toBe('');
  });
});

describe('skuPatternError theo bảng 9.3', () => {
  it.each([
    ['AO-{VAL}', 'Quy tắc phải có đúng một {SEQ} để SKU không trùng'],
    ['AO-{SEQ}-{SEQ}', 'Quy tắc phải có đúng một {SEQ} để SKU không trùng'],
    ['ao-{SEQ}', 'Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"'],
    ['AO {SEQ}', 'Phần chữ cố định chỉ gồm A-Z, 0-9, "-" và "_"'],
    ['AO-{SEQ:0}', 'Số chữ số của {SEQ} từ 1 đến 9'],
    ['AO-{VAL}-{VAL}-{SEQ}', 'Chỉ dùng {VAL} một lần'],
    ['', 'Nhập quy tắc SKU'],
    [`${'A'.repeat(36)}{SEQ}`, 'Quy tắc tối đa 40 ký tự'],
    ['AO-{SEQ}{X}', 'Chỉ dùng {SEQ}, {SEQ:n} (n từ 1 đến 9) và {VAL}'],
  ])('%s → lỗi', (pattern, message) => {
    expect(skuPatternError(pattern)).toBe(message);
  });

  it('quy tắc hợp lệ không có lỗi', () => {
    expect(skuPatternError('AO-{SEQ:4}-{VAL}')).toBeNull();
    expect(skuPatternError(` ${'A'.repeat(35)}{SEQ} `)).toBeNull();
  });
});
