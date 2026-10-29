import { describe, expect, it } from 'vitest';
import { canSeeCost, docNumber, outstanding, purchasable, toDong } from '#src/modules/product/purchasing/domain/request.ts';

const line = { excluded: false, orderedQty: 10, receivedQty: 3, defectiveQty: 1, closedShortQty: 2 };

describe('còn chờ của dòng đề nghị', () => {
  it('= đặt − nhận − lỗi giữ − đóng thiếu', () => {
    expect(outstanding(line)).toBe(4);
  });

  it('dòng bị CEO loại không còn chờ gì', () => {
    expect(outstanding({ ...line, excluded: true })).toBe(0);
  });
});

describe('số chứng từ', () => {
  it('tiền tố và sáu chữ số', () => {
    expect(docNumber('DN', 1)).toBe('DN-000001');
    expect(docNumber('DN', 1234567)).toBe('DN-1234567');
  });
});

describe('SKU nhập được', () => {
  it('đang bán hoặc tạm ngừng; ngừng nhập và lưu trữ thì không', () => {
    expect(['selling', 'paused', 'discontinued', 'archived'].map(purchasable)).toEqual([true, true, false, false]);
  });
});

describe('thấy giá nhập', () => {
  it('người xem giá vốn, lập hoặc duyệt đề nghị thấy giá; kho chỉ nhận hàng thì không', () => {
    const modules = ['inventory', 'purchasing'];
    expect(canSeeCost({ permissions: ['inventory.cost.view'], enabledModules: modules })).toBe(true);
    expect(canSeeCost({ permissions: ['purchasing.request.manage'], enabledModules: modules })).toBe(true);
    expect(canSeeCost({ permissions: ['purchasing.receipt.manage'], enabledModules: modules })).toBe(false);
  });

  it('phân hệ purchasing tắt thì quyền mua hàng không cho thấy giá', () => {
    expect(canSeeCost({ permissions: ['purchasing.request.approve'], enabledModules: ['inventory'] })).toBe(false);
  });
});

describe('tiền ra API', () => {
  it('làm tròn nửa lên về số nguyên đồng', () => {
    expect(toDong('86666.50')).toBe(86667);
    expect(toDong('100000.00')).toBe(100000);
  });
});
