import { sql } from 'drizzle-orm';
import { check, index, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Mọi bảng của module `identity` khai báo trong schema này.
// Không đặt tên `auth`: Supabase đã có sẵn schema `auth` cho hệ thống đăng nhập của nó.
export const identitySchema = pgSchema('core');

/**
 * Refresh token, chỉ lưu bản băm SHA-256. Thuộc tài khoản chứ không thuộc công ty,
 * nên không có RLS; `company_id` là công ty đang chọn của phiên (để trống khi chưa chọn).
 * Họ token (`family_id`): mọi token xoay vòng từ một lần đăng nhập. `rotated_at` là lúc token bị thay bằng
 * token kế tiếp (còn dùng lại được trong hạn `REFRESH_REUSE_GRACE_SECONDS`); `revoked_at` là thu hồi hẳn
 * (đăng xuất, đổi mật khẩu, phát hiện dùng lại), không có hạn dùng lại.
 */
export const refreshTokens = identitySchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    companyId: uuid('company_id'),
    // Mặc định ngẫu nhiên: đăng nhập mở họ mới, dòng có sẵn lúc thêm cột mỗi dòng một họ.
    familyId: uuid('family_id').notNull().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.accountId), index().on(t.familyId)],
);

/**
 * Lần đăng ký công ty đang chờ mã xác minh email (#459, Documents/21 mục 2.1). Không thuộc công ty nào nên không RLS
 * (luồng đăng ký chạy bằng role chủ bảng). Chỉ giữ mật khẩu đã băm argon2id và bản băm của mã
 * (`sha256(mã + ':' + id)`, `domain/registration.ts`). Sống 30 phút (`expires_at`); việc nền dọn dòng tạo quá 24 giờ
 * (giữ lâu hơn hạn để đếm trần thư theo email và thư "email đã có tài khoản" mỗi 24 giờ). Tạo công ty xong thì xoá.
 */
export const registrations = identitySchema.table(
  'registrations',
  {
    id: uuid('id').primaryKey(),
    // Email chữ thường, đã cắt khoảng trắng.
    email: text('email').notNull(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    companyName: text('company_name').notNull(),
    // Dạng chuẩn hoá (`platform/domain/tax-code.ts`); chưa giữ chỗ, so trùng lại lúc tạo công ty.
    taxCode: text('tax_code').notNull(),
    // Null tới khi việc nền gửi thư mã; email đã có tài khoản thì luôn null (không mã nào đúng).
    otpHash: text('otp_hash'),
    otpRequestedAt: timestamp('otp_requested_at', { withTimezone: true }).notNull(),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }).notNull(),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    otpSendCount: integer('otp_send_count').notNull().default(1),
    // Lúc gửi thư "email đã có tài khoản" của lần đăng ký này (tối đa một thư mỗi email mỗi 24 giờ).
    accountNoticeAt: timestamp('account_notice_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.email, t.createdAt),
    index().on(t.createdAt),
    // 5 là REGISTRATION_OTP_MAX_ATTEMPTS, REGISTRATION_OTP_MAX_SENDS (`domain/registration.ts`).
    check(
      'registrations_otp_counters_range',
      sql`${t.otpAttempts} between 0 and 5 and ${t.otpSendCount} between 1 and 5`,
    ),
  ],
);
