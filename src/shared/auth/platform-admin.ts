import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.ts';
import { readAccessClaims } from './authenticate.ts';
import { assertTokenCurrent } from './company-access.ts';

/** Cờ quản trị nền tảng và dấu đổi mật khẩu của tài khoản, đọc từ DB; `undefined` khi không có tài khoản. */
export type PlatformAdminLoader = (
  accountId: string,
) => Promise<{ isPlatformAdmin: boolean; passwordChangedAt: Date | null } | undefined>;

/**
 * Guard cho API quản trị nền tảng (#7 [D]; #10 dùng lại). Đọc cờ từ DB mỗi request, không tin claim. Thứ tự: 401
 * `unauthorized` (thiếu, sai token) → 403 `password_change_required`, `two_factor_setup_required` → 401 (token phát
 * trước lần đổi mật khẩu, #62) → 403 `forbidden`. `src/wiring.ts` tiêm loader, module dùng `ctx.authorizePlatform`.
 */
export function createPlatformAdminGuard(loader: PlatformAdminLoader): RequestHandler {
  return async (req, res, next) => {
    const claims = await readAccessClaims(req);
    const account = await loader(claims.accountId);
    if (!account) throw new AppError(401, 'unauthorized', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn');
    assertTokenCurrent(claims, account.passwordChangedAt);
    if (!account.isPlatformAdmin) throw new AppError(403, 'forbidden', 'Chỉ quản trị nền tảng làm được thao tác này');
    res.locals.auth = claims;
    next();
  };
}
