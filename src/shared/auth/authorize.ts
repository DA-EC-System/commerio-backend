import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors/app-error.ts';
import { readAccessClaims } from './authenticate.ts';
import { type AccessLoader, assertCompanyAccess, type CompanyAccess, moduleOfPermission } from './company-access.ts';

export { type AccessLoader, assertCompanyAccess, type CompanyAccess, moduleOfPermission } from './company-access.ts';

/** `authorize('catalog.product.manage')`: middleware kiểm đăng nhập, công ty và quyền. */
export type Authorize = (permission: string) => RequestHandler;

/**
 * Dựng middleware kiểm quyền. Thứ tự kiểm (Documents/21 V3, V5, D1, D3): token → 401; chưa chọn công ty
 * → 403 `company_not_selected`; không thuộc công ty → 404 `not_found` (C4); token phát trước lần đổi mật khẩu gần
 * nhất → 401 `unauthorized` (#62); công ty khoá → 403 `company_locked`;
 * tài khoản khoá → 403 `account_locked`; phân hệ tắt → 403 `module_disabled`; thiếu quyền → 403 `forbidden`.
 * Đặt trước `validate()` để thiếu quyền ra 403 chứ không ra 422.
 */
export function createAuthorize(loader: AccessLoader): Authorize {
  return (permission) => async (req, res, next) => {
    const access = await loadMemberAccess(req, res, loader);
    if (!access.enabledModules.includes(moduleOfPermission(permission))) {
      throw new AppError(403, 'module_disabled', 'Tính năng này đang tắt');
    }
    if (!access.permissions.includes(permission)) {
      throw new AppError(403, 'forbidden', 'Bạn không có quyền thực hiện thao tác này');
    }
    next();
  };
}

/**
 * Thành viên còn làm việc được trong công ty, không đòi mã quyền: các bước của `authorize` trừ kiểm phân hệ và
 * quyền. Dùng cho route mọi thành viên gọi được, rồi tự lọc theo quyền đọc ở `getAccess` (tệp đính kèm, onboarding).
 */
export function createMember(loader: AccessLoader): RequestHandler {
  return async (req, res, next) => {
    await loadMemberAccess(req, res, loader);
    next();
  };
}

/** Bước chung của `authorize` và `member`: token, đã chọn công ty, truy cập công ty; ghi vào `res.locals`. */
async function loadMemberAccess(req: Request, res: Response, loader: AccessLoader): Promise<CompanyAccess> {
  const claims = await readAccessClaims(req);
  if (!claims.companyId) throw new AppError(403, 'company_not_selected', 'Chưa chọn công ty làm việc');
  const access = await loader(claims.accountId, claims.companyId);
  assertCompanyAccess(access, claims);
  res.locals.auth = claims;
  res.locals.access = access;
  return access;
}

/**
 * Qua khi một trong các middleware `authorize` qua: `anyOf(ctx.authorize('a'), ctx.authorize('b'))`. Thử lần lượt,
 * chỉ thử tiếp khi bị 403 `forbidden`; lỗi khác (401, 404, công ty khoá, phân hệ tắt…) trả ngay.
 */
export function anyOf(...checks: readonly RequestHandler[]): RequestHandler {
  return async (req, res, next) => {
    for (const [i, check] of checks.entries()) {
      try {
        // `authorize` ném lỗi thay vì gọi next(err), nên chờ nó xong rồi mới quyết.
        await check(req, res, next);
        return;
      } catch (err) {
        if (i === checks.length - 1 || !(err instanceof AppError && err.code === 'forbidden')) throw err;
      }
    }
  };
}

/**
 * Quyền thô hiện tại của người gọi mà `authorize` vừa đọc từ DB (gồm quyền của phân hệ đang tắt, D1): route cần
 * quyền phụ (vd xem giá vốn) đọc ở đây thay vì nạp lần hai. Chỉ gọi sau `ctx.authorize(...)`.
 */
export function getAccess(res: Response): CompanyAccess {
  const access = res.locals.access as CompanyAccess | undefined;
  if (!access) throw new Error('getAccess chỉ gọi được sau authorize');
  return access;
}
