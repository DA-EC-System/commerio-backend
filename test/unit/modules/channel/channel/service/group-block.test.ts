import { describe, expect, it } from 'vitest';
import { groupBlock } from '#src/modules/channel/channel/service/push-block.ts';

// Phần gom biến thể trước đây chỉ chạy trong việc nền (be#566, Documents/21 §18.11): kiểm trước cùng hàm với readiness.
const color = (id: string, value: string) => ({ attributeId: 'color', attributeName: 'Màu', value, valueId: id });
const size = (value: string) => ({ attributeId: 'size', attributeName: 'Cỡ', value, valueId: `s-${value}` });
const spec = (axisMap: Record<string, string>, missing: { code: string; label: string; reason: string }[] = []) =>
  ({ missing, row: { axisMap }, attributes: null }) as unknown as Parameters<typeof groupBlock>[1];

describe('groupBlock', () => {
  it('cùng bộ thuộc tính, trục đã ánh xạ: không chặn', () => {
    const vs = [{ id: 'a', attributes: [color('c1', 'Đỏ')] }, { id: 'b', attributes: [color('c2', 'Xanh')] }];
    expect(groupBlock(vs, spec({ color: 'color_family' }))).toBeNull();
  });

  it('SKU khác bộ thuộc tính: axis_shape, chỗ sửa là phần thuộc tính biến thể', () => {
    const vs = [{ id: 'a', attributes: [color('c1', 'Đỏ')] }, { id: 'b', attributes: [color('c2', 'Xanh'), size('M')] }];
    expect(groupBlock(vs, spec({ color: 'color_family', size: 'size' }))).toEqual({
      code: 'axis_shape',
      label: 'Các SKU của sản phẩm không cùng bộ thuộc tính phân loại',
      target: { kind: 'axis' },
    });
  });

  it('nhiều SKU không thuộc tính: axis_shape', () => {
    expect(groupBlock([{ id: 'a', attributes: [] }, { id: 'b', attributes: [] }], spec({}))?.code).toBe('axis_shape');
  });

  it('trục chưa ánh xạ: axis_unmapped chỉ tới thuộc tính đó', () => {
    expect(groupBlock([{ id: 'a', attributes: [color('c1', 'Đỏ')] }], spec({}))).toMatchObject({
      code: 'axis_unmapped',
      target: { kind: 'axis', attributeId: 'color' },
    });
  });

  it('spec còn thiếu hoặc chưa có spec: không xét (spec đã báo, tránh trùng mục)', () => {
    const vs = [{ id: 'a', attributes: [color('c1', 'Đỏ')] }, { id: 'b', attributes: [] }];
    expect(groupBlock(vs, spec({}, [{ code: 'color', label: 'Màu', reason: 'axis_unmapped' }]))).toBeNull();
    expect(groupBlock(vs, undefined)).toBeNull();
  });

  it('không có SKU mới nào để gom: không chặn', () => {
    expect(groupBlock([], spec({}))).toBeNull();
  });
});
