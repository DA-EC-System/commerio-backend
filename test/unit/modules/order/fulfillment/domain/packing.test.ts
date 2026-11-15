import { describe, expect, it } from 'vitest';
import { buildPickList, packGroupBlockers, readyGroupBlockers, scanMismatch } from '#src/modules/order/fulfillment/domain/packing.ts';

describe('so số quét', () => {
  const lines = [{ variantId: 'A', quantity: 1 }, { variantId: 'A', quantity: 2 }, { variantId: null, quantity: 4 }];
  it('gộp theo biến thể và bỏ qua dòng chưa ghép', () => {
    expect(scanMismatch(lines, [{ variantId: 'A', quantity: 3 }])).toBeNull();
    expect(scanMismatch([lines[2]!], [])).toBeNull();
  });
  it.each([0, 2, 4])('báo thiếu hoặc thừa khi quét %s', (quantity) => {
    expect(scanMismatch(lines, quantity ? [{ variantId: 'A', quantity }] : [])).toEqual({
      'lines.A': `Kiện cần 3, đã quét ${quantity}`,
    });
  });
  it('báo món quét ngoài kiện', () => {
    expect(scanMismatch([], [{ variantId: 'B', quantity: 2 }])).toEqual({ 'lines.B': 'Món này không có trong kiện' });
  });
});

describe('nhóm gói', () => {
  it('đóng gói khi các kiện khác đã giữ hoặc đóng và đơn đang xử lý', () => {
    expect(packGroupBlockers([
      { code: 'K1', status: 'packed', orderStatus: 'processing' },
      { code: 'K2', status: 'reserved', orderStatus: 'unpaid' },
      { code: 'K3', status: 'awaiting_pickup', orderStatus: 'processing' },
    ])).toEqual(['K2', 'K3']);
    expect(packGroupBlockers([])).toEqual([]);
  });
  it('chỉ báo sẵn sàng khi cả nhóm đã đóng', () => {
    expect(readyGroupBlockers([{ code: 'K1', status: 'reserved' }, { code: 'K2', status: 'packed' }])).toEqual(['K1']);
  });
});

it('danh sách nhặt đếm kiện riêng, gộp dòng chưa ghép theo SKU và xếp theo SKU', () => {
  const row = { packageId: 'K1', sku: 'Z', productName: 'Áo', attributesLabel: '', variantId: 'A', quantity: 1 };
  const unmapped = { ...row, variantId: null, sku: 'A' };
  expect(buildPickList([row, row, { ...row, packageId: 'K2' }, unmapped, { ...unmapped, quantity: 2 }])).toEqual([
    { variantId: null, sku: 'A', productName: 'Áo', attributesLabel: '', quantity: 3, packageCount: 1 },
    { variantId: 'A', sku: 'Z', productName: 'Áo', attributesLabel: '', quantity: 3, packageCount: 2 },
  ]);
});
