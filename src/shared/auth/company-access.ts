// Trạng thái tài khoản trong công ty và luật đọc mã quyền, không dính HTTP: domain và service dùng được.
import { AppError } from '../errors/app-error.ts';
import { type AccessClaims, assertTokenCurrent } from './jwt.ts';

/** Trạng thái của một tài khoản trong một công ty, đọc từ DB ở mỗi request (Documents/21 D1). */
export interface CompanyAccess {
  readonly companyStatus: 'active' | 'locked';
  readonly membershipStatus: 'active' | 'suspended';
  /** Mọi quyền của các vai trò, chưa lọc theo phân hệ bật, để phân biệt `module_disabled` với `forbidden`. */
  readonly permissions: readonly string[];
  readonly enabledModules: readonly string[];
  /** Lần đổi mật khẩu gần nhất của tài khoản, so với dấu trong token (#62). */
  readonly passwordChangedAt: Date | null;
}

/** `null` khi tài khoản không thuộc công ty. Module `identity` cung cấp, `src/wiring.ts` tiêm vào. */
export type AccessLoader = (accountId: string, companyId: string) => Promise<CompanyAccess | null>;

/** Phân hệ của mã quyền `<phân hệ>.<đối tượng>.<hành động>`: phần trước dấu chấm đầu (Documents/21 mục 8). */
export function moduleOfPermission(permission: string): string {
  return permission.slice(0, permission.indexOf('.'));
}

/**
 * Tài khoản còn làm việc được trong công ty: không thuộc công ty → 404 `not_found` (C4), công ty khoá
 * → 403 `company_locked`, tài khoản khoá → 403 `account_locked`. Dùng chung cho `authorize` và chọn công ty.
 * Truyền `claims` khi request mang access token: token phát trước lần đổi mật khẩu → 401 (#62), ngay sau 404.
 */
export function assertCompanyAccess(access: CompanyAccess | null, claims?: AccessClaims): asserts access is CompanyAccess {
  if (!access) throw new AppError(404, 'not_found', 'Không tìm thấy công ty');
  if (claims) assertTokenCurrent(claims, access.passwordChangedAt);
  if (access.companyStatus === 'locked') throw new AppError(403, 'company_locked', 'Công ty đang bị khoá');
  if (access.membershipStatus === 'suspended') {
    throw new AppError(403, 'account_locked', 'Tài khoản của bạn đang bị khoá trong công ty này');
  }
}
