import { describe, expect, it } from 'vitest';
import { BUILTIN_ONLY_PERMISSIONS, PERMISSIONS } from '#src/modules/core/access/domain/catalog.ts';
import {
  disabledCodes,
  GRANTABLE_CODES,
  grantableCatalog,
  lacking,
  mergeKeptPermissions,
} from '#src/modules/core/access/domain/roles.ts';

describe('luật cấp quyền cho vai trò tuỳ biến', () => {
  it('danh mục cấp được bỏ hai quyền platform.* chỉ vai trò có sẵn mang (M3)', () => {
    expect(GRANTABLE_CODES).toHaveLength(PERMISSIONS.length - BUILTIN_ONLY_PERMISSIONS.length);
    for (const code of BUILTIN_ONLY_PERMISSIONS) expect(GRANTABLE_CODES).not.toContain(code);
  });

  it('danh mục trả về chỉ gồm quyền của phân hệ đang bật, dạng {code, module, label}', () => {
    const list = grantableCatalog(['identity', 'catalog']);
    expect(list.map((p) => p.module).every((m) => m === 'identity' || m === 'catalog')).toBe(true);
    expect(list).toContainEqual({ code: 'catalog.product.view', module: 'catalog', label: 'Xem, tra cứu sản phẩm' });
    expect(list.some((p) => p.code.startsWith('platform.'))).toBe(false);
  });

  it('lacking: các mã người gọi không mang', () => {
    expect(lacking(['a.b.c', 'd.e.f'], ['a.b.c'])).toEqual(['d.e.f']);
    expect(lacking(['a.b.c'], ['a.b.c', 'x.y.z'])).toEqual([]);
  });

  it('disabledCodes: các mã thuộc phân hệ không bật', () => {
    expect(disabledCodes(['purchasing.order.manage', 'catalog.product.view'], ['catalog'])).toEqual([
      'purchasing.order.manage',
    ]);
  });

  it('PUT giữ quyền của phân hệ đang tắt mà vai trò đang có, bỏ trùng, sắp xếp (D2)', () => {
    const merged = mergeKeptPermissions(
      ['catalog.product.view', 'catalog.product.view'],
      ['purchasing.order.manage', 'catalog.product.manage'],
      ['catalog'],
    );
    expect(merged).toEqual(['catalog.product.view', 'purchasing.order.manage']);
  });
});
