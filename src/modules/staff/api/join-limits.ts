// Giới hạn tần suất của API công khai /join/* (#7 spec 6.11). Bộ đếm trong bộ nhớ của từng bản sao api; chốt chặn
// bền (5 lần sai mỗi mã, 5 lần gửi mỗi link) nằm ở DB. Ngưỡng nhân `JOIN_RATE_LIMIT_SCALE` để test chỉnh được.
import type { RequestHandler, Response } from 'express';
import { type Options, rateLimit } from 'express-rate-limit';
import { type PurposeClaims, type TokenPurpose, verifyPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { sha256Hex } from '../../../shared/crypto/codes.ts';
import { AppError } from '../../../shared/errors/app-error.ts';

const MIN15 = 15 * 60_000;
const HOUR = 60 * 60_000;

const BASE = {
  check: [60, MIN15],
  otpIp: [10, MIN15],
  otpEmail: [5, HOUR],
  otpInvitation: [6, HOUR],
  verifyIp: [30, MIN15],
  verifyInvitation: [10, MIN15],
  completeIp: [20, MIN15],
  completeEmail: [5, MIN15],
} as const;

export type JoinLimitName = keyof typeof BASE;
export interface JoinLimit {
  limit: number;
  windowMs: number;
}

export function joinLimits(scale: number): Record<JoinLimitName, JoinLimit> {
  const entries = Object.entries(BASE).map(([name, [limit, windowMs]]) => [
    name,
    { limit: Math.max(1, Math.round(limit * scale)), windowMs },
  ]);
  return Object.fromEntries(entries) as Record<JoinLimitName, JoinLimit>;
}

/** 429 `too_many_requests` dạng Problem Details; thư viện tự đặt `Retry-After`. Mặc định khoá theo IP. */
export function joinLimiter(spec: JoinLimit, options: Partial<Options> = {}): RequestHandler {
  return rateLimit({
    ...spec,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'too_many_requests', 'Thử quá nhiều lần, hãy đợi rồi thử lại'));
    },
    ...options,
  });
}

/** Khoá theo email đã băm: bộ đếm không giữ email. */
export const emailKey = (email: string) => `email:${sha256Hex(email)}`;

/**
 * Kiểm chữ ký token (EdDSA, rẻ) trước các bộ đếm theo lời mời, theo email: khoá lấy từ claim đã xác thực, nên người
 * không cầm token thật không đốt được bộ đếm của người khác. Token sai thì chỉ bộ đếm theo IP tính; service vẫn kiểm
 * lại và trả lỗi của luồng.
 */
export function readClaims(purpose: TokenPurpose, token: (res: Response) => string): RequestHandler {
  return async (_req, res, next) => {
    res.locals.joinClaims = await verifyPurposeToken(purpose, token(res)).catch(() => undefined);
    next();
  };
}

export const verifiedClaims = (res: Response): PurposeClaims | undefined =>
  res.locals.joinClaims as PurposeClaims | undefined;

/** Bộ đếm chỉ tính request có token đã xác thực, khoá theo `key(claims)`. */
export function claimLimiter(
  spec: JoinLimit,
  key: (claims: PurposeClaims, res: Response) => string,
  options: Partial<Options> = {},
) {
  return joinLimiter(spec, {
    skip: (_req, res) => !verifiedClaims(res),
    keyGenerator: (_req, res) => key(verifiedClaims(res)!, res),
    ...options,
  });
}
