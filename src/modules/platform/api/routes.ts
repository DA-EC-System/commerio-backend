import { type RequestHandler, Router } from 'express';
import { z } from 'zod';
import { getAuth } from '../../../shared/auth/authenticate.ts';
import { validate, validated } from '../../../shared/http/validate.ts';
import type { ModuleContext } from '../../../shared/module.ts';

/** `ctx` mà router của platform nhận: guard và việc của module lớp trên do src/wiring.ts tiêm (#7 [D]). */
export interface PlatformContext extends ModuleContext {
  /** Chỉ quản trị nền tảng qua (đọc cờ từ DB mỗi request). */
  readonly authorizePlatform?: RequestHandler;
  /** Đặt lại 2FA của tài khoản (identity). */
  readonly resetAccountTwoFactor?: (accountId: string, actorId: string) => Promise<void>;
}

// `accountId` sai dạng trả 404 ở service.
export const AccountParams = z.object({ accountId: z.string() });

/** Route của module `platform`, gắn tại /api/v1/platform. Kiểm quyền bằng `ctx.authorize(...)` hoặc `ctx.authorizePlatform`. */
export function platformRouter(ctx: PlatformContext): Router {
  const router = Router();
  const { authorizePlatform, resetAccountTwoFactor } = ctx;
  if (authorizePlatform && resetAccountTwoFactor) {
    router.post(
      '/accounts/:accountId/2fa/reset',
      authorizePlatform,
      validate({ params: AccountParams }),
      async (_req, res) => {
        await resetAccountTwoFactor(validated<typeof AccountParams>(res, 'params').accountId, getAuth(res).accountId);
        res.status(204).end();
      },
    );
  }
  return router;
}
