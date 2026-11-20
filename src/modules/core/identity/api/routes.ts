import { type CookieOptions, type Request, type Response, Router } from 'express';
import { type Options, rateLimit } from 'express-rate-limit';
import type { z } from 'zod';
import { authenticate, getAuth } from '../../../../shared/auth/authenticate.ts';
import { env } from '../../../../shared/config/env.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../../shared/http/validate.ts';
import { accessRouter } from '../../access/index.ts';
import { staffRouter } from '../../staff/index.ts';
import * as auth from '../service/auth-service.ts';
import { loginWithGoogle } from '../service/google.ts';
import { RegistrationRetryLater, resendRegistration, startRegistration, verifyRegistration } from '../service/registration.ts';
import {
  ChangePasswordBody,
  GoogleLoginBody,
  LoginBody,
  RegisterBody,
  RegistrationIdBody,
  SelectCompanyBody,
  VerifyRegistrationBody,
} from './schemas.ts';

/** Refresh token nằm trong cookie HttpOnly, chỉ gửi kèm các đường dẫn /identity (Documents/21 A1). */
export const REFRESH_COOKIE = 'commerio_refresh';
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'strict',
  path: '/api/v1/identity',
};

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, { ...cookieOptions, maxAge: auth.REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000 });
}

function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE];
  return typeof value === 'string' && value ? value : undefined;
}

const body = <T extends z.ZodType>(res: Response) => validated<T>(res, 'body');

// Chặn dò mật khẩu và đăng ký hàng loạt: đếm theo IP trong 15 phút.
const authLimiter = (options: Partial<Options> = {}) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: env.AUTH_RATE_LIMIT,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'too_many_requests', 'Thử quá nhiều lần, hãy đợi 15 phút rồi thử lại'));
    },
    ...options,
  });

/** Số lần đổi mật khẩu lỗi tối đa mỗi 15 phút cho một tài khoản (chặn đoán mật khẩu bằng access token bị lộ). */
const CHANGE_PASSWORD_LIMIT = 5;
/** Số lần nhập mã mỗi 15 phút cho một lần đăng ký (nhân `JOIN_RATE_LIMIT_SCALE`). */
const REGISTRATION_VERIFY_LIMIT = 10;

export function identityRouter(ctx: auth.IdentityContext): Router {
  const router = Router();

  // Đăng ký hai bước (#459, Documents/21 mục 2.1). Không trả 401 ở ba route này.
  router.post('/register', authLimiter(), validate({ body: RegisterBody }), async (_req, res) => {
    res.status(202).json(await startRegistration(body<typeof RegisterBody>(res)));
  });

  router.post('/register/resend', authLimiter(), validate({ body: RegistrationIdBody }), async (_req, res, next) => {
    try {
      res.status(202).json(await resendRegistration(body<typeof RegistrationIdBody>(res).registrationId));
    } catch (err) {
      if (err instanceof RegistrationRetryLater) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      next(err);
    }
  });

  router.post(
    '/register/verify',
    authLimiter(),
    validate({ body: VerifyRegistrationBody }),
    // Sau validate: khoá theo lần đăng ký (chốt chặn bền là 5 lần sai mỗi mã trong DB).
    authLimiter({
      limit: Math.max(1, Math.round(REGISTRATION_VERIFY_LIMIT * env.JOIN_RATE_LIMIT_SCALE)),
      keyGenerator: (_req, res) => `registration:${body<typeof VerifyRegistrationBody>(res).registrationId}`,
    }),
    async (_req, res) => {
      if (!ctx.seedCompanyDefaults) throw new Error('Chưa nối seedCompanyDefaults (src/wiring.ts)');
      const { refreshToken, ...result } = await verifyRegistration(
        body<typeof VerifyRegistrationBody>(res),
        ctx.seedCompanyDefaults,
      );
      setRefreshCookie(res, refreshToken);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json(result);
    },
  );

  router.post('/login', authLimiter(), validate({ body: LoginBody }), async (_req, res) => {
    const { refreshToken, ...result } = await auth.login(body<typeof LoginBody>(res));
    setRefreshCookie(res, refreshToken);
    res.json(result);
  });

  // Chỉ đăng nhập tài khoản đã có, không đăng ký (#7 [A]). Giới hạn theo IP như /login (bộ đếm riêng).
  router.post('/google', authLimiter(), validate({ body: GoogleLoginBody }), async (_req, res) => {
    const { refreshToken, ...result } = await loginWithGoogle(body<typeof GoogleLoginBody>(res).credential);
    setRefreshCookie(res, refreshToken);
    res.json(result);
  });

  router.post('/refresh', async (req, res) => {
    try {
      const session = await auth.refresh(readRefreshCookie(req));
      setRefreshCookie(res, session.refreshToken);
      res.json({ accessToken: session.accessToken });
    } catch (err) {
      // Cookie cũ đã xoay vòng: không xoá, kẻo đè cookie mới mà request khác vừa đặt.
      if (!(err instanceof auth.StaleRefreshTokenError)) res.clearCookie(REFRESH_COOKIE, cookieOptions);
      throw err;
    }
  });

  router.post('/logout', async (req, res) => {
    await auth.logout(readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', authenticate({ allowPasswordChange: true }), async (_req, res) => {
    res.json(await auth.me(getAuth(res)));
  });

  router.post('/select-company', authenticate(), validate({ body: SelectCompanyBody }), async (req, res) => {
    const { companyId } = body<typeof SelectCompanyBody>(res);
    res.json(await auth.selectCompany(getAuth(res), companyId, readRefreshCookie(req)));
  });

  router.post(
    '/change-password',
    authenticate({ allowPasswordChange: true }),
    validate({ body: ChangePasswordBody }),
    // Sau validate: body sai định dạng không bị đếm; chỉ đếm lần lỗi, theo tài khoản.
    authLimiter({
      limit: CHANGE_PASSWORD_LIMIT,
      skipSuccessfulRequests: true,
      keyGenerator: (_req, res) => getAuth(res).accountId,
    }),
    async (req, res) => {
      setRefreshCookie(res, await auth.changePassword(getAuth(res), body<typeof ChangePasswordBody>(res), readRefreshCookie(req)));
      res.status(204).end();
    },
  );

  // Vai trò và quyền (/identity/roles, /identity/permissions) do module access phục vụ. Gắn sau route của
  // identity để middleware không đường dẫn bên access (nếu có) không chặn được /login, /refresh.
  router.use(accessRouter(ctx));
  // Nhân viên (/identity/staff, #7) do module staff phục vụ, gắn cùng cách.
  router.use(staffRouter(ctx));

  return router;
}
