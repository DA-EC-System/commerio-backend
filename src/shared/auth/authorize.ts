import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.ts';
import { readAccessClaims } from './authenticate.ts';
import { type AccessLoader, assertCompanyAccess, moduleOfPermission } from './company-access.ts';

export { type AccessLoader, assertCompanyAccess, type CompanyAccess, moduleOfPermission } from './company-access.ts';

/** `authorize('catalog.product.manage')`: middleware kiểm đăng nhập, công ty và quyền. */
export type Authorize = (permission: string) => RequestHandler;

/**
 * Dựng middleware kiểm quyền. Thứ tự kiểm (Documents/21 V3, V5, D1, D3): token → 401; chưa chọn công ty
 * → 403 `company_not_selected`; không thuộc công ty → 404 `not_found` (C4); công ty khoá → 403 `company_locked`;
 * tài khoản khoá → 403 `account_locked`; phân hệ tắt → 403 `module_disabled`; thiếu quyền → 403 `forbidden`.
 * Đặt trước `validate()` để thiếu quyền ra 403 chứ không ra 422.
 */
export function createAuthorize(loader: AccessLoader): Authorize {
  return (permission) => async (req, res, next) => {
    const claims = await readAccessClaims(req);
    if (!claims.companyId) throw new AppError(403, 'company_not_selected', 'Chưa chọn công ty làm việc');
    const access = await loader(claims.accountId, claims.companyId);
    assertCompanyAccess(access);
    if (!access.enabledModules.includes(moduleOfPermission(permission))) {
      throw new AppError(403, 'module_disabled', 'Phân hệ này đang tắt');
    }
    if (!access.permissions.includes(permission)) {
      throw new AppError(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    }
    res.locals.auth = claims;
    next();
  };
}
