import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../errors/app-error.ts';
import { type AccessClaims, verifyAccessToken } from './jwt.ts';

interface AuthenticateOptions {
  /** Cho tài khoản còn mật khẩu thư mời gọi API này (me, đổi mật khẩu). Mặc định chặn. */
  readonly allowPasswordChange?: boolean;
}

/**
 * Đọc và kiểm access token ở header `Authorization: Bearer <token>`.
 * Thiếu hoặc sai thì 401 `unauthorized`; còn mật khẩu thư mời thì 403 `password_change_required`.
 */
export async function readAccessClaims(req: Request, options: AuthenticateOptions = {}): Promise<AccessClaims> {
  const header = req.get('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new AppError(401, 'unauthorized', 'Chưa đăng nhập');
  const claims = await verifyAccessToken(token);
  if (claims.mustChangePassword && !options.allowPasswordChange) {
    throw new AppError(403, 'password_change_required', 'Cần đổi mật khẩu trước khi tiếp tục');
  }
  return claims;
}

/** Middleware: kiểm access token như `readAccessClaims`, đặt người gọi vào `res.locals.auth`. */
export function authenticate(options: AuthenticateOptions = {}): RequestHandler {
  return async (req, res, next) => {
    res.locals.auth = await readAccessClaims(req, options);
    next();
  };
}

/** Người gọi đã qua `authenticate()` hoặc `authorize()`. */
export function getAuth(res: Response): AccessClaims {
  const auth = res.locals.auth as AccessClaims | undefined;
  if (!auth) throw new Error('Route chưa gắn authenticate()');
  return auth;
}
