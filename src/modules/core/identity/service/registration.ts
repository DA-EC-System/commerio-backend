// Đăng ký công ty hai bước (#459, Documents/21 mục 2.1): gửi form → mã qua email → nhập mã thì tạo công ty và vào
// thẳng công ty. Email đã có tài khoản đi y như email mới (cùng băm mật khẩu, cùng bộ đếm, cùng phản hồi), chỉ khác thư.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../../../shared/config/env.ts';
import { randomDigits, safeEqualHex } from '../../../../shared/crypto/codes.ts';
import { inTransaction } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { logger } from '../../../../shared/logger.ts';
import { MailError, sendMail } from '../../../../shared/mail/index.ts';
import { defineQueue, schedulePlatform, sendJob, taxCodeExists, workQueue } from '../../platform/index.ts';
import { findAccountByEmail } from '../../staff/index.ts';
import {
  ACCOUNT_NOTICE_INTERVAL_SECONDS,
  EMAIL_LIVE_REGISTRATIONS_MAX,
  EMAIL_MAILS_PER_HOUR_MAX,
  isStaleRegistrationMail,
  isTestEmail,
  REGISTRATION_OTP_LENGTH,
  REGISTRATION_OTP_MAX_ATTEMPTS,
  REGISTRATION_OTP_MAX_SENDS,
  REGISTRATION_OTP_TTL_SECONDS,
  REGISTRATION_RETENTION_SECONDS,
  REGISTRATION_TTL_SECONDS,
  registrationOtpHash,
  resendAfterSeconds,
} from '../domain/registration.ts';
import {
  deleteRegistration,
  emailUsage,
  hasAccountNoticeSince,
  incrementOtpAttempt,
  insertRegistration,
  lockRegistration,
  lockRegistrationEmail,
  markAccountNotice,
  markResent,
  purgeRegistrationsBefore,
  type RegistrationRow,
  storeRegistrationOtp,
} from '../repository/registrations.ts';
import { createCompanyWithCeo, type SeedCompanyDefaults, sessionForCompany, taxCodeTaken } from './auth-service.ts';
import { hashPassword } from './passwords.ts';
import { renderAccountExistsMail, renderRegistrationOtpMail } from './registration-mail.ts';

export interface RegistrationStatus {
  registrationId: string;
  codeExpiresAt: string;
  registrationExpiresAt: string;
  resendAfterSeconds: number;
}

/** 429 kèm số giây chờ; route đặt header `Retry-After`. */
export class RegistrationRetryLater extends AppError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(429, 'too_many_requests', message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const expired = () =>
  new AppError(410, 'registration_expired', 'Phiên đăng ký đã hết hạn hoặc đã dùng xong, hãy đăng ký lại');
const emailLimit = () =>
  new AppError(429, 'too_many_requests', 'Email này đã đăng ký quá nhiều lần, hãy đợi một giờ rồi thử lại');
const wrongCode = () =>
  new AppError(422, 'validation_failed', 'Dữ liệu gửi lên không hợp lệ', {
    errors: { code: 'Mã không đúng hoặc đã hết hạn; sai 5 lần thì xin mã mới' },
  });

export const registrationMailQueue = defineQueue(
  'identity.registration_mail',
  // Việc cấp nền tảng: không có `companyId` (khai để khớp `BaseJobData`).
  z.object({ registrationId: z.uuid(), requestedAt: z.iso.datetime(), companyId: z.undefined().optional() }),
  { attempts: 4, retryDelaySeconds: 15, expireInSeconds: 60 },
);

export const registrationPurgeQueue = defineQueue('identity.registration_purge', z.object({}), {
  policy: 'stately',
  attempts: 3,
  retryDelaySeconds: 300,
});

const isTest = (email: string) => isTestEmail(email, env.REGISTRATION_TEST_EMAIL_DOMAIN);

function statusOf(row: Pick<RegistrationRow, 'id' | 'otpRequestedAt' | 'otpExpiresAt' | 'expiresAt'>, now: Date): RegistrationStatus {
  return {
    registrationId: row.id,
    codeExpiresAt: row.otpExpiresAt.toISOString(),
    registrationExpiresAt: row.expiresAt.toISOString(),
    resendAfterSeconds: resendAfterSeconds(row.otpRequestedAt, now),
  };
}

async function assertEmailQuota(email: string, now: Date, opts: { newRegistration: boolean }): Promise<void> {
  const usage = await emailUsage(email, now);
  if (opts.newRegistration && usage.live >= EMAIL_LIVE_REGISTRATIONS_MAX) throw emailLimit();
  if (usage.mailsLastHour >= EMAIL_MAILS_PER_HOUR_MAX) throw emailLimit();
}

/** Bước 1: lưu lần đăng ký, xếp việc gửi thư. Không xét email có tài khoản hay không (không lộ qua thời gian, nội dung). */
export async function startRegistration(input: {
  company: { name: string; taxCode: string };
  ceo: { fullName: string; email: string; password: string };
}): Promise<RegistrationStatus> {
  // Băm trước khi mở giao dịch (argon2 chậm có chủ ý); cả hai nhánh đều băm.
  const passwordHash = await hashPassword(input.ceo.password);
  const now = new Date();
  const row = {
    id: randomUUID(),
    email: input.ceo.email,
    fullName: input.ceo.fullName,
    passwordHash,
    companyName: input.company.name,
    taxCode: input.company.taxCode,
    otpRequestedAt: now,
    otpExpiresAt: new Date(now.getTime() + REGISTRATION_OTP_TTL_SECONDS * 1000),
    expiresAt: new Date(now.getTime() + REGISTRATION_TTL_SECONDS * 1000),
    createdAt: now,
  };
  await inTransaction(async () => {
    await lockRegistrationEmail(row.email);
    await assertEmailQuota(row.email, now, { newRegistration: true });
    if (await taxCodeExists(row.taxCode)) throw taxCodeTaken();
    await insertRegistration(row);
    await sendJob(registrationMailQueue, { registrationId: row.id, requestedAt: now.toISOString() });
  });
  logger.info({ registrationId: row.id }, 'đã nhận đăng ký công ty, chờ mã email');
  return statusOf(row, now);
}

export async function resendRegistration(registrationId: string): Promise<RegistrationStatus> {
  const now = new Date();
  return inTransaction(async () => {
    const row = await lockRegistration(registrationId);
    if (!row || row.expiresAt <= now) throw expired();
    const wait = resendAfterSeconds(row.otpRequestedAt, now);
    if (wait > 0) throw new RegistrationRetryLater(`Đợi ${wait} giây rồi xin mã lại`, wait);
    await lockRegistrationEmail(row.email);
    await assertEmailQuota(row.email, now, { newRegistration: false });
    if (row.otpSendCount >= REGISTRATION_OTP_MAX_SENDS) {
      throw new AppError(429, 'otp_send_limit', 'Lần đăng ký này đã gửi đủ 5 mã; hãy đăng ký lại từ đầu');
    }
    const otpExpiresAt = new Date(now.getTime() + REGISTRATION_OTP_TTL_SECONDS * 1000);
    await markResent(row.id, now, otpExpiresAt);
    await sendJob(registrationMailQueue, { registrationId: row.id, requestedAt: now.toISOString() });
    return statusOf({ ...row, otpRequestedAt: now, otpExpiresAt }, now);
  });
}

/**
 * Bước 2: mã sai thì commit bộ đếm rồi mới ném 422. Mã đúng thì trong cùng giao dịch xoá dòng (bên đua thua chờ khoá
 * dòng rồi thấy dòng đã mất, 410) và tạo công ty. Trùng email, mã số thuế thì giao dịch rollback cả lần xoá; xoá dòng
 * ở giao dịch riêng (người dùng gửi lại form) rồi ném 409.
 */
export async function verifyRegistration(
  input: { registrationId: string; code: string },
  seedCompanyDefaults: SeedCompanyDefaults,
) {
  const now = new Date();
  let created: { companyId: string; accountId: string } | null;
  try {
    created = await inTransaction(async () => {
      const row = await lockRegistration(input.registrationId);
      if (!row || row.expiresAt <= now) throw expired();
      const usable = row.otpHash !== null && row.otpExpiresAt > now && row.otpAttempts < REGISTRATION_OTP_MAX_ATTEMPTS;
      if (!usable || !safeEqualHex(registrationOtpHash(input.code, row.id), row.otpHash!)) {
        if (row.otpAttempts < REGISTRATION_OTP_MAX_ATTEMPTS) await incrementOtpAttempt(row.id);
        return null;
      }
      await deleteRegistration(row.id);
      return createCompanyWithCeo({
        company: { name: row.companyName, taxCode: row.taxCode },
        ceo: { fullName: row.fullName, email: row.email, passwordHash: row.passwordHash },
        testRegistration: isTest(row.email),
      }, seedCompanyDefaults);
    });
  } catch (err) {
    if (err instanceof AppError && (err.code === 'email_taken' || err.code === 'tax_code_taken')) {
      await inTransaction(() => deleteRegistration(input.registrationId));
      logger.info({ registrationId: input.registrationId, code: err.code }, 'đăng ký trùng lúc tạo công ty');
    }
    throw err;
  }
  if (!created) {
    logger.warn({ registrationId: input.registrationId }, 'sai mã xác minh đăng ký');
    throw wrongCode();
  }
  logger.info({ registrationId: input.registrationId, companyId: created.companyId }, 'đã tạo công ty từ đăng ký');
  return sessionForCompany(created.accountId, created.companyId);
}

/** Việc nền gửi thư (một lần xin mã một việc). Lỗi SMTP tạm thì ném để thử lại; vĩnh viễn thì ghi log. */
export async function handleRegistrationMail(data: { registrationId: string; requestedAt: string }): Promise<void> {
  const log = { registrationId: data.registrationId };
  if (isStaleRegistrationMail(data.requestedAt, new Date())) {
    logger.info(log, 'bỏ việc gửi thư đăng ký đã cũ');
    return;
  }
  await inTransaction(async () => {
    const row = await lockRegistration(data.registrationId);
    // Bỏ khi: không còn dòng; đã có lần xin sau; đã ghi mã hay đã gửi thư cho lần xin này (việc giao lại).
    const current =
      row &&
      row.expiresAt > new Date() &&
      row.otpRequestedAt.getTime() === Date.parse(data.requestedAt) &&
      row.otpHash === null &&
      row.accountNoticeAt === null;
    if (!current) {
      logger.info(log, 'bỏ việc gửi thư đăng ký: lần đăng ký đã đổi');
      return;
    }
    try {
      if (await findAccountByEmail(row.email)) {
        await sendAccountNotice(row);
        return;
      }
      if (isTest(row.email)) {
        // Mã thử của e2e: đi chung đường kiểm với mã thật (bản băm, đếm sai, hạn), không gửi thư, không ghi mã ra log.
        await storeRegistrationOtp(row.id, registrationOtpHash(env.REGISTRATION_TEST_CODE!, row.id));
        logger.info(log, 'lần đăng ký thử: đã đặt mã thử');
        return;
      }
      const code = randomDigits(REGISTRATION_OTP_LENGTH);
      await storeRegistrationOtp(row.id, registrationOtpHash(code, row.id));
      await sendMail(
        { to: row.email, ...renderRegistrationOtpMail({ fullName: row.fullName, companyName: row.companyName, code }) },
        'registration_otp',
      );
      logger.info(log, 'đã gửi thư mã đăng ký');
    } catch (err) {
      // Lỗi vĩnh viễn: thử lại vô ích; giữ mã đã ghi (người dùng xin mã lại sau 60 giây).
      if (err instanceof MailError && err.kind === 'permanent') {
        logger.error({ ...log, smtpCode: err.smtpCode }, 'gửi thư đăng ký lỗi vĩnh viễn');
        return;
      }
      throw err;
    }
  });
}

async function sendAccountNotice(row: RegistrationRow): Promise<void> {
  const now = new Date();
  await lockRegistrationEmail(row.email);
  const since = new Date(now.getTime() - ACCOUNT_NOTICE_INTERVAL_SECONDS * 1000);
  if (await hasAccountNoticeSince(row.email, since)) {
    logger.info({ registrationId: row.id }, 'bỏ thư email đã có tài khoản: đã gửi trong 24 giờ');
    return;
  }
  await markAccountNotice(row.id, now);
  // Email thử thì không gửi thư.
  if (isTest(row.email)) return;
  const loginUrl = env.PUBLIC_WEB_URL ? new URL('/login', env.PUBLIC_WEB_URL).toString() : null;
  await sendMail({ to: row.email, ...renderAccountExistsMail({ loginUrl }) }, 'registration_account_exists');
  logger.info({ registrationId: row.id }, 'đã gửi thư email đã có tài khoản');
}

export async function runRegistrationPurge(now = new Date()): Promise<number> {
  const purged = await purgeRegistrationsBefore(new Date(now.getTime() - REGISTRATION_RETENTION_SECONDS * 1000));
  if (purged > 0) logger.info({ purged }, 'đã dọn lần đăng ký cũ');
  return purged;
}

/** `startBackground` của identity (worker): gửi thư đăng ký, dọn dòng cũ mỗi giờ. */
export async function startIdentityBackground(): Promise<() => Promise<void>> {
  await workQueue(registrationMailQueue, (data) => handleRegistrationMail(data), { concurrency: 4 });
  await workQueue(registrationPurgeQueue, async () => {
    await runRegistrationPurge();
  });
  await schedulePlatform(registrationPurgeQueue, '23 * * * *', {}, 'all');
  return async () => {};
}
