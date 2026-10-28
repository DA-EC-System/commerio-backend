// Luật cấp quyền cho vai trò tuỳ biến (UC-PI-06, QT-06, Documents/21 M3, D2). Thuần, không I/O.
import { BUILTIN_ONLY_PERMISSIONS, PERMISSIONS, permissionModule } from './catalog.ts';

/** Mã quyền cấp được cho vai trò tuỳ biến: cả danh mục trừ hai quyền `platform.*`. */
export const GRANTABLE_CODES: readonly string[] = PERMISSIONS.map((p) => p.code).filter(
  (code) => !BUILTIN_ONLY_PERMISSIONS.includes(code),
);

/** Danh mục quyền cấp được của các phân hệ đang bật, dạng FE dùng (`PermissionDef`). */
export function grantableCatalog(enabledModules: readonly string[]) {
  return PERMISSIONS.filter((p) => GRANTABLE_CODES.includes(p.code))
    .map((p) => ({ code: p.code, module: permissionModule(p.code), label: p.description }))
    .filter((p) => enabledModules.includes(p.module));
}

/** Các mã trong `codes` mà người gọi không mang (so với quyền thô, kể cả phân hệ đang tắt). */
export function lacking(codes: readonly string[], held: readonly string[]): string[] {
  return codes.filter((code) => !held.includes(code));
}

/** Các mã thuộc phân hệ không bật. */
export function disabledCodes(codes: readonly string[], enabledModules: readonly string[]): string[] {
  return codes.filter((code) => !enabledModules.includes(permissionModule(code)));
}

/** Quyền lưu khi sửa: quyền gửi lên cộng quyền của phân hệ đang tắt mà vai trò đang có (D2), bỏ trùng, sắp xếp. */
export function mergeKeptPermissions(
  requested: readonly string[],
  current: readonly string[],
  enabledModules: readonly string[],
): string[] {
  return [...new Set([...requested, ...disabledCodes(current, enabledModules)])].sort();
}
