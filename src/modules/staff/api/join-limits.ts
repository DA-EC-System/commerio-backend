// Giới hạn tần suất của API công khai /join/* (#7 spec 6.11). Bộ đếm trong bộ nhớ của từng bản sao api; chốt chặn
// bền (5 lần sai mỗi mã, 5 lần gửi mỗi link) nằm ở DB. Ngưỡng nhân `JOIN_RATE_LIMIT_SCALE` để test chỉnh được.
import type { RequestHandler } from 'express';
import { type Options, rateLimit } from 'express-rate-limit';
import { decodeJwt } from 'jose';
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
 * Claim đọc từ token **chưa kiểm chữ ký**, chỉ để chia bộ đếm theo lời mời hay email; token không đọc được thì chung
 * một khoá. Token thật vẫn được kiểm ở service.
 */
export function unverifiedClaim(token: string, claim: 'jti' | 'em'): string {
  try {
    const value = decodeJwt(token)[claim];
    return typeof value === 'string' ? value : 'invalid';
  } catch {
    return 'invalid';
  }
}
