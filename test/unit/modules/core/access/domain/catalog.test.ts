import { describe, expect, it } from 'vitest';
import { BUILTIN_ROLES, PERMISSIONS, permissionModule } from '#src/modules/core/access/domain/catalog.ts';
import { CORE_MODULES, OPTIONAL_MODULES } from '#src/modules/core/platform/domain/modules.ts';

// Mã quyền có tiền tố không phải mã phân hệ thì `authorize` luôn trả 403 `module_disabled` (#65 A25).
describe('danh mục quyền', () => {
  const modules: readonly string[] = [...CORE_MODULES, ...OPTIONAL_MODULES];

  it('mọi mã quyền và mọi quyền của vai trò có sẵn thuộc một phân hệ có thật', () => {
    const codes = [...PERMISSIONS.map((p) => p.code), ...Object.values(BUILTIN_ROLES).flatMap((r) => r.permissions)];
    expect(codes.filter((code) => !modules.includes(permissionModule(code)))).toEqual([]);
  });
});
