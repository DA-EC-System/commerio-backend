// Tham gia công ty qua link mời (#7 [C], UC-PI-09): API công khai, token trong body. Thứ tự lỗi theo spec 6.5; bước
// phải giữ bộ đếm (sai OTP) commit trước rồi mới ném (spec 6.7). Mọi lỗi là 409, 410, 422 hoặc 429, không có 401: FE
// coi 401 là hết phiên (Review Focus 1).
import { PurposeTokenError, signPurposeToken, verifyPurposeToken } from '../../../shared/auth/purpose-token.ts';
import { safeEqualHex } from '../../../shared/crypto/codes.ts';
import { hashPassword, verifyPassword } from '../../../shared/crypto/password.ts';
import { withCompany } from '../../../shared/db/client.ts';
import { pgError } from '../../../shared/db/pg-error.ts';
import { AppError } from '../../../shared/errors/app-error.ts';
import { logger } from '../../../shared/logger.ts';
import { isUuid } from '../../../shared/uuid.ts';
import { getCompanies, publishEvent } from '../../platform/index.ts';
import { isLinkExpired } from '../domain/invitation-machine.ts';
import { OTP_MAX_SENDS, OTP_RESEND_SECONDS, otpHash } from '../domain/otp.ts';
import { findAccountByEmail, findMemberByAccount } from '../repository/accounts.ts';
import {
  consumeOtpAttempt,
  findInvitation,
  type InvitationRow,
  markClaimed,
  requestOtpWrite,
  submitInvitation,
} from '../repository/invitations.ts';
import { countOtpRequest, countTransition } from './metrics.ts';

export type JoinNext = 'set_password' | 'sign_in';

/** 429 kèm số giây chờ; route đặt header `Retry-After`. */
export class RetryLaterError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(429, 'too_many_requests', message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const invalidLink = () => new AppError(410, 'invitation_invalid', 'Link mời không hợp lệ hoặc đã hết hạn');
const linkUsed = () => new AppError(409, 'invitation_used', 'Link mời đã được dùng');
const registrationExpired = () =>
  new AppError(410, 'registration_expired', 'Phiên đăng ký đã hết hạn, hãy nhập lại mã xác minh');
const alreadyMember = () => new AppError(409, 'already_member', 'Bạn đã là nhân viên của công ty này');
const fieldError = (field: string, message: string) =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', { errors: { [field]: message } });

async function linkOf(token: string): Promise<{ invitationId: string; companyId: string }> {
  const claims = await verifyPurposeToken('invite', token).catch((err: unknown) => {
    if (err instanceof PurposeTokenError) throw invalidLink();
    throw err;
  });
  if (!claims.jti || !claims.cid || !isUuid(claims.jti) || !isUuid(claims.cid)) throw invalidLink();
  return { invitationId: claims.jti, companyId: claims.cid };
}

/**
 * Người được mời còn làm tiếp được: còn dòng, còn hạn (410), chưa nộp (409). `email` cho trước mà link đã gắn email
 * khác (409).
 */
function assertUsable(row: InvitationRow | undefined, email?: string): asserts row is InvitationRow {
  if (!row || isLinkExpired(row, new Date())) throw invalidLink();
  if (row.status !== 'open' && row.status !== 'claimed') throw linkUsed();
  if (email !== undefined && row.status === 'claimed' && row.email !== email) throw linkUsed();
}

export async function checkInvitation(token: string): Promise<{ companyName: string; expiresAt: string }> {
  const { invitationId, companyId } = await linkOf(token);
  return withCompany(companyId, async () => {
    const row = await findInvitation(invitationId);
    assertUsable(row);
    const company = (await getCompanies([companyId])).get(companyId);
    return { companyName: company?.name ?? '', expiresAt: row.expiresAt.toISOString() };
  });
}

/**
 * Ghi email, họ tên và phát sự kiện để worker sinh mã, gửi thư (cùng giao dịch). Phản hồi như nhau dù email có tài
 * khoản hay không: trạng thái tài khoản chỉ lộ sau khi qua OTP (Q14).
 */
export async function requestOtp(input: { token: string; email: string; fullName: string }): Promise<void> {
  const { invitationId, companyId } = await linkOf(input.token);
  await withCompany(companyId, async () => {
    const written = await requestOtpWrite(invitationId, input.email, input.fullName);
    if (written) {
      await publishEvent({
        type: 'staff.invitation_otp_requested',
        aggregateId: invitationId,
        payload: { invitationId, requestedAt: written.otpRequestedAt.toISOString() },
      });
      return;
    }
    // Không trúng dòng: đọc lại để chọn lỗi.
    const row = await findInvitation(invitationId);
    assertUsable(row, input.email);
    if (row.otpSendCount >= OTP_MAX_SENDS) {
      countOtpRequest('limit');
      throw new AppError(429, 'too_many_requests', 'Link này đã gửi đủ 5 mã; nhờ Admin tạo link khác');
    }
    // Chưa từng xin mã mà vẫn không ghi được: link vừa hết hạn theo đồng hồ DB.
    if (!row.otpRequestedAt) throw invalidLink();
    countOtpRequest('cooldown');
    const waitSeconds = Math.ceil((row.otpRequestedAt.getTime() + OTP_RESEND_SECONDS * 1000 - Date.now()) / 1000);
    const retryAfter = Math.min(OTP_RESEND_SECONDS, Math.max(1, waitSeconds));
    throw new RetryLaterError(`Đợi ${retryAfter} giây rồi xin mã lại`, retryAfter);
  });
  countOtpRequest('accepted');
  logger.info({ invitationId }, 'đã nhận yêu cầu mã OTP lời mời');
}

/**
 * Mã đúng thì link gắn với email này (`claimed`, Q13), rồi mới xét tài khoản: đã là thành viên 409, quản trị nền tảng
 * 422 (Q5, Q14). Mã sai vẫn commit bộ đếm rồi mới ném.
 */
export async function verifyOtp(input: {
  token: string;
  email: string;
  code: string;
}): Promise<{ registrationToken: string; next: JoinNext }> {
  const { invitationId, companyId } = await linkOf(input.token);
  const outcome = await withCompany(companyId, async () => {
    assertUsable(await findInvitation(invitationId), input.email);
    const attempt = await consumeOtpAttempt(invitationId, input.email);
    if (!attempt || !safeEqualHex(otpHash(input.code, invitationId), attempt.otpHash)) return 'wrong_code';
    if (!(await markClaimed(invitationId, input.email))) return 'wrong_code';
    const account = await findAccountByEmail(input.email);
    if (account && (await findMemberByAccount(account.id))) return 'already_member';
    if (account?.isPlatformAdmin) return 'platform_admin';
    return account ? 'sign_in' : 'set_password';
  });
  if (outcome === 'wrong_code') {
    logger.warn({ invitationId }, 'sai mã OTP lời mời');
    throw fieldError('code', 'Mã không đúng hoặc đã hết hạn; sai 5 lần thì xin mã mới');
  }
  countTransition('claimed');
  logger.info({ invitationId }, 'lời mời đã xác minh email');
  if (outcome === 'already_member') throw alreadyMember();
  if (outcome === 'platform_admin') throw fieldError('email', 'Email này không dùng để tham gia công ty được');
  const registrationToken = await signPurposeToken('join', {
    jti: invitationId,
    cid: companyId,
    em: input.email,
    nxt: outcome,
  });
  return { registrationToken, next: outcome };
}

/**
 * Nộp yêu cầu tham gia (`claimed → pending`). Email mới: băm mật khẩu vừa đặt; tài khoản đã có: kiểm mật khẩu của tài
 * khoản đó, không đổi (Q4). Argon2 chạy ngoài giao dịch. Chưa tạo tài khoản: Admin duyệt mới tạo (Q6).
 */
export async function completeJoin(input: {
  registrationToken: string;
  password: string;
  confirmPassword?: string;
}): Promise<{ status: 'pending' }> {
  const claims = await verifyPurposeToken('join', input.registrationToken).catch((err: unknown) => {
    if (err instanceof PurposeTokenError) throw registrationExpired();
    throw err;
  });
  const { jti, cid, em, nxt } = claims;
  if (!jti || !cid || !em || !nxt || !isUuid(jti) || !isUuid(cid)) throw registrationExpired();
  if (nxt === 'set_password' && input.confirmPassword === undefined) {
    throw fieldError('confirmPassword', 'Nhập lại mật khẩu');
  }
  // Link hết hạn báo trước khi kiểm mật khẩu (spec 6.5).
  await withCompany(cid, async () => {
    const row = await findInvitation(jti);
    if (!row || isLinkExpired(row, new Date())) throw invalidLink();
  });

  let passwordHash: string | null = null;
  let accountId: string | null = null;
  if (nxt === 'sign_in') {
    const account = await findAccountByEmail(em);
    // Không có tài khoản vẫn chạy argon2 trên bản băm giả để cùng thời gian.
    const ok = await verifyPassword(account?.passwordHash, input.password);
    if (!ok || !account) throw fieldError('password', 'Mật khẩu không đúng');
    accountId = account.id;
  } else {
    passwordHash = await hashPassword(input.password);
  }

  const outcome = await withCompany(cid, async () => {
    if (accountId && (await findMemberByAccount(accountId))) return 'already_member';
    if (await submitInvitation(jti, em, { passwordHash, accountId })) return 'pending';
    const row = await findInvitation(jti);
    return !row || isLinkExpired(row, new Date()) ? 'invalid' : 'used';
  }).catch((err: unknown) => {
    // Đã có yêu cầu khác của email này chờ duyệt trong công ty.
    const { code, constraint } = pgError(err);
    if (code === '23505' && constraint === 'invitations_one_pending_per_email') return 'used';
    throw err;
  });
  if (outcome === 'already_member') throw alreadyMember();
  if (outcome === 'invalid') throw invalidLink();
  if (outcome === 'used') throw linkUsed();
  countTransition('pending');
  logger.info({ invitationId: jti }, 'đã nộp yêu cầu tham gia');
  return { status: 'pending' };
}
