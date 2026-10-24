import { type CookieOptions, type Request, type Response, Router } from 'express';
import { type Options, rateLimit } from 'express-rate-limit';
import type { z } from 'zod';
import { authenticate, getAuth } from '../../../shared/auth/authenticate.ts';
import { verifyPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { env } from '../../../shared/config/env.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';
import { accessRouter } from '../../access/index.ts';
import { staffRouter } from '../../staff/index.ts';
import * as auth from '../service/auth-service.ts';
import { loginWithGoogle } from '../service/google.ts';
import { countTwoFactor } from '../service/metrics.ts';
import { isMfaChallenge, type LoginResult, type MfaChallenge } from '../service/session.ts';
import { beginSetup, confirmSetup, loginSecondFactor } from '../service/two-factor.ts';
import {
  ChangePasswordBody,
  ConfirmTwoFactorBody,
  GoogleLoginBody,
  LoginBody,
  RegisterBody,
  SecondFactorBody,
  SelectCompanyBody,
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
/** Số lần nhập sai mã 2FA tối đa mỗi 15 phút cho một tài khoản (#7 [D], spec 6.11); đủ thì 429 kể cả mã đúng. */
const TWO_FACTOR_LIMIT = 5;

/** 429 của bộ đếm sai mã 2FA, đếm metric `locked`. */
const twoFactorLimiter = (
  keyGenerator: (req: Request, res: Response) => string,
  skip?: (req: Request, res: Response) => boolean,
) =>
  authLimiter({
    limit: TWO_FACTOR_LIMIT,
    skipSuccessfulRequests: true,
    keyGenerator,
    ...(skip ? { skip } : {}),
    handler: (req, res, next) => {
      countTwoFactor('locked');
      // Khoá bộ đếm chỉ chứa id tài khoản (`mfa:<id>`, `setup:<id>`).
      req.log.warn({ limiterKey: keyGenerator(req, res) }, 'khoá nhập mã 2FA vì sai quá nhiều lần');
      next(new AppError(429, 'too_many_requests', 'Sai mã quá nhiều lần, hãy đợi 15 phút rồi thử lại'));
    },
  });

/** `/login`, `/google`: tài khoản đã bật 2FA thì chưa đặt cookie, chỉ trả `mfaToken`. */
function sendFirstFactor(res: Response, result: LoginResult | MfaChallenge) {
  if (isMfaChallenge(result)) {
    res.json(result);
    return;
  }
  const { refreshToken, ...session } = result;
  setRefreshCookie(res, refreshToken);
  res.json(session);
}

export function identityRouter(ctx: ModuleContext): Router {
  const router = Router();

  router.post('/register', authLimiter(), validate({ body: RegisterBody }), async (_req, res) => {
    res.status(201).json(await auth.register(body<typeof RegisterBody>(res)));
  });

  router.post('/login', authLimiter(), validate({ body: LoginBody }), async (_req, res) => {
    sendFirstFactor(res, await auth.login(body<typeof LoginBody>(res)));
  });

  // Chỉ đăng nhập tài khoản đã có, không đăng ký (#7 [A]). Giới hạn theo IP như /login (bộ đếm riêng).
  router.post('/google', authLimiter(), validate({ body: GoogleLoginBody }), async (_req, res) => {
    sendFirstFactor(res, await loginWithGoogle(body<typeof GoogleLoginBody>(res).credential));
  });

  // Bước thứ hai (#7 [D]). Thứ tự lỗi: 422 → 401 `unauthorized` (mfaToken sai) → 429 (sai 5 lần, đếm theo tài khoản
  // của mfaToken đã kiểm chữ ký) → 401 `two_factor_invalid`.
  router.post(
    '/login/2fa',
    authLimiter(),
    validate({ body: SecondFactorBody }),
    async (_req, res, next) => {
      const { mfaToken } = body<typeof SecondFactorBody>(res);
      res.locals.mfaAccountId = (await verifyPurposeToken('mfa', mfaToken).catch(() => undefined))?.sub;
      next();
    },
    twoFactorLimiter(
      (_req, res) => `mfa:${res.locals.mfaAccountId as string}`,
      (_req, res) => !res.locals.mfaAccountId,
    ),
    async (_req, res) => {
      const { refreshToken, ...session } = await loginSecondFactor(body<typeof SecondFactorBody>(res));
      setRefreshCookie(res, refreshToken);
      res.json(session);
    },
  );

  // Thiết lập 2FA: gọi được khi token còn cờ `tfs` hay `pwc` (Q18).
  const setupAuth = authenticate({ allowPasswordChange: true, allowTwoFactorSetup: true });
  // Phản hồi chứa secret hay mã khôi phục: không cho lưu cache.
  router.post('/2fa/setup', setupAuth, async (_req, res) => {
    const setup = await beginSetup(getAuth(res));
    res.set('Cache-Control', 'no-store').json(setup);
  });
  router.post(
    '/2fa/confirm',
    setupAuth,
    validate({ body: ConfirmTwoFactorBody }),
    twoFactorLimiter((_req, res) => `setup:${getAuth(res).accountId}`),
    async (req, res) => {
      const { refreshToken, ...result } = await confirmSetup(
        getAuth(res),
        body<typeof ConfirmTwoFactorBody>(res).code,
        readRefreshCookie(req),
      );
      setRefreshCookie(res, refreshToken);
      res.set('Cache-Control', 'no-store').json(result);
    },
  );

  router.post('/refresh', async (req, res) => {
    try {
      const session = await auth.refresh(readRefreshCookie(req));
      setRefreshCookie(res, session.refreshToken);
      res.json({ accessToken: session.accessToken });
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieOptions);
      throw err;
    }
  });

  router.post('/logout', async (req, res) => {
    await auth.logout(readRefreshCookie(req));
    res.clearCookie(REFRESH_COOKIE, cookieOptions);
    res.status(204).end();
  });

  router.get('/me', authenticate({ allowPasswordChange: true, allowTwoFactorSetup: true }), async (_req, res) => {
    res.json(await auth.me(getAuth(res)));
  });

  router.post('/select-company', authenticate(), validate({ body: SelectCompanyBody }), async (req, res) => {
    const { companyId } = body<typeof SelectCompanyBody>(res);
    res.json(await auth.selectCompany(getAuth(res), companyId, readRefreshCookie(req)));
  });

  router.post(
    '/change-password',
    authenticate({ allowPasswordChange: true, allowTwoFactorSetup: true }),
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
