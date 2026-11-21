import { describe, expect, it } from 'vitest';
import { childFirst } from '#src/modules/core/platform/repository/test-company.ts';

describe('childFirst: thứ tự xoá bảng theo khoá ngoại', () => {
  const t = (id: number, name: string) => ({ id, name });

  it('bảng con đứng trước bảng cha, kể cả nhiều tầng', () => {
    const order = childFirst([t(1, 'orders'), t(2, 'order_lines'), t(3, 'package_lines')], [
      { child: 2, parent: 1 },
      { child: 3, parent: 2 },
    ]);
    expect(order).toEqual(['package_lines', 'order_lines', 'orders']);
  });

  it('bỏ qua khoá ngoại tới bảng không có company_id', () => {
    expect(childFirst([t(1, 'a')], [{ child: 1, parent: 99 }])).toEqual(['a']);
  });

  it('ném khi khoá ngoại thành vòng, không đoán thứ tự', () => {
    expect(() => childFirst([t(1, 'a'), t(2, 'b')], [{ child: 1, parent: 2 }, { child: 2, parent: 1 }])).toThrow(/vòng/);
  });
});
