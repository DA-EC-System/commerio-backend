import { describe, expect, it } from 'vitest';
import { buildPickList, packGroupBlockers, readyGroupBlockers, scanMismatch } from '#src/modules/order/fulfillment/domain/packing.ts';

describe('so số quét', () => {
  const line = (id: string, variantId: string | null, quantity: number, stockUntracked = false) => ({ id, variantId, quantity, stockUntracked });
  const lines = [line('L1', 'A', 1), line('L2', 'A', 2), line('L3', null, 4)];
  it('gộp theo biến thể và bỏ qua dòng chưa ghép SKU', () => {
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

  describe('dòng không quản tồn', () => {
    const withUntracked = [line('L1', 'A', 1), line('U1', null, 2, true), line('U2', null, 1, true)];
    it('khớp khi mọi dòng không quản tồn đã đủ theo id dòng', () => {
      expect(scanMismatch(withUntracked, [{ variantId: 'A', quantity: 1 }], [{ lineId: 'U1', quantity: 2 }, { lineId: 'U2', quantity: 1 }])).toBeNull();
    });
    it('báo thiếu khi chưa cho dòng không quản tồn vào hộp', () => {
      expect(scanMismatch(withUntracked, [{ variantId: 'A', quantity: 1 }], [{ lineId: 'U1', quantity: 1 }])).toEqual({
        'untrackedLines.U1': 'Kiện cần 2, đã quét 1',
        'untrackedLines.U2': 'Kiện cần 1, đã quét 0',
      });
    });
    it('báo dòng lạ: id không có trong kiện hoặc là dòng đã ghép, chưa ghép', () => {
      expect(scanMismatch([...withUntracked, line('L3', null, 1)], [{ variantId: 'A', quantity: 1 }], [
        { lineId: 'U1', quantity: 2 }, { lineId: 'U2', quantity: 1 }, { lineId: 'X', quantity: 1 }, { lineId: 'L1', quantity: 1 }, { lineId: 'L3', quantity: 1 },
      ])).toEqual({
        'untrackedLines.X': 'Dòng này không phải dòng "không quản tồn" của kiện',
        'untrackedLines.L1': 'Dòng này không phải dòng "không quản tồn" của kiện',
        'untrackedLines.L3': 'Dòng này không phải dòng "không quản tồn" của kiện',
      });
    });
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

it('danh sách nhặt đếm kiện riêng, gộp dòng chưa ghép theo SKU, tách dòng không quản tồn và xếp theo SKU', () => {
  const row = { packageId: 'K1', sku: 'Z', productName: 'Áo', attributesLabel: '', variantId: 'A', untracked: false, quantity: 1 };
  const unmapped = { ...row, variantId: null, sku: 'A' };
  const untracked = { ...unmapped, untracked: true, packageId: 'K3' };
  expect(buildPickList([row, row, { ...row, packageId: 'K2' }, unmapped, { ...unmapped, quantity: 2 }, untracked])).toEqual([
    { variantId: null, untracked: false, sku: 'A', productName: 'Áo', attributesLabel: '', quantity: 3, packageCount: 1 },
    { variantId: null, untracked: true, sku: 'A', productName: 'Áo', attributesLabel: '', quantity: 1, packageCount: 1 },
    { variantId: 'A', untracked: false, sku: 'Z', productName: 'Áo', attributesLabel: '', quantity: 3, packageCount: 2 },
  ]);
});
