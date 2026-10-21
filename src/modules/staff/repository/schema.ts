import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { bytea, timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `staff` khai báo trong schema này.
export const staffSchema = pgSchema('staff');

export const membershipStatus = staffSchema.enum('membership_status', ['active', 'suspended']);

/**
 * Tài khoản đăng nhập, dùng chung mọi công ty nên không có RLS (docs/19 D3, D25).
 * Email lưu chữ thường; mật khẩu băm argon2id.
 */
export const accounts = staffSchema.table(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    fullName: text('full_name').notNull(),
    passwordHash: text('password_hash'),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    googleSub: text('google_sub').unique(),
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    // Lần đổi mật khẩu gần nhất; access token mang dấu này, khác thì 401 (#62). Trống: chưa từng đổi.
    passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),
    // Xác thực hai lớp (#7 [D], D40): secret TOTP mã hoá AES-256-GCM bằng `TOTP_ENCRYPTION_KEY`, AAD
    // `totp:<accountId>`. Ghi bằng role chủ bảng (migration 0017).
    totpSecretEnc: bytea('totp_secret_enc'),
    totpEnabledAt: timestamp('totp_enabled_at', { withTimezone: true }),
    // Bước 30 giây của mã đã dùng gần nhất: mỗi mã chỉ dùng một lần.
    totpLastStep: bigint('totp_last_step', { mode: 'number' }),
    // SHA-256 của 2 mã khôi phục còn dùng được.
    recoveryCodeHashes: text('recovery_code_hashes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps,
    ...version,
  },
  (t) => [check('accounts_totp_enabled_has_secret', sql`${t.totpEnabledAt} is null or ${t.totpSecretEnc} is not null`)],
);

/** Tài khoản thuộc công ty nào; khoá tài khoản tính theo công ty (docs/19 D5). */
export const memberships = staffSchema.table(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    status: membershipStatus('status').notNull().default('active'),
    ...timestamps,
    ...version,
  },
  (t) => [unique().on(t.companyId, t.accountId), index().on(t.accountId)],
);

export const invitationStatus = staffSchema.enum('invitation_status', [
  'open',
  'claimed',
  'pending',
  'approved',
  'rejected',
]);

/**
 * Lời mời bằng link một lần (#7 [C], docs/19 D39, spec 6.3). `id` cũng là `jti` của token link; DB không lưu token.
 * Chuyển trạng thái theo `domain/invitation-machine.ts`, ghi có điều kiện ở `repository/invitations.ts`. Không xoá:
 * `commerio_app` không có quyền DELETE (migration 0019). RLS `company_isolation` có `WITH CHECK`.
 */
export const invitations = staffSchema.table(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id').notNull(),
    roleIds: uuid('role_ids').array().notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => accounts.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    status: invitationStatus('status').notNull().default('open'),
    // Ghi ở `/join/otp`, cố định khi sang `claimed`. Email chữ thường.
    email: text('email'),
    fullName: text('full_name'),
    // Tài khoản đã có (`sign_in`) hoặc tài khoản tạo lúc duyệt.
    accountId: uuid('account_id').references(() => accounts.id),
    // Chỉ khi `set_password`; xoá khi duyệt hoặc từ chối.
    passwordHash: text('password_hash'),
    // `sha256(mã + ':' + id)` (`domain/otp.ts`).
    otpHash: text('otp_hash'),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    otpSendCount: integer('otp_send_count').notNull().default(0),
    // Cắt về mili giây khi ghi để so khớp với `requestedAt` trong sự kiện.
    otpRequestedAt: timestamp('otp_requested_at', { withTimezone: true }),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedBy: uuid('decided_by').references(() => accounts.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    // [D] 2FA thiết lập lúc tham gia (email mới): AAD `totp:<invitationId>`; duyệt thì mã hoá lại cho tài khoản.
    totpSecretEnc: bytea('totp_secret_enc'),
    totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true }),
    recoveryCodeHashes: text('recovery_code_hashes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    ...timestamps,
    ...version,
  },
  (t) => [
    index('invitations_queue_idx').on(t.companyId, t.status, t.submittedAt.desc().nullsLast(), t.id),
    index('invitations_created_idx').on(t.companyId, t.createdAt.desc()),
    index().on(t.createdBy),
    index().on(t.accountId),
    index().on(t.decidedBy),
    // Một yêu cầu chờ duyệt mỗi email mỗi công ty.
    uniqueIndex('invitations_one_pending_per_email')
      .on(t.companyId, t.email)
      .where(sql`${t.status} = 'pending'`),
    check('invitations_role_ids_nonempty', sql`cardinality(${t.roleIds}) >= 1`),
    check(
      'invitations_identity_present',
      sql`${t.status} = 'open' or (${t.email} is not null and ${t.fullName} is not null)`,
    ),
    check(
      'invitations_pending_shape',
      sql`${t.status} <> 'pending' or (${t.submittedAt} is not null and ((${t.passwordHash} is not null)::int + (${t.accountId} is not null)::int) = 1)`,
    ),
    check(
      'invitations_approved_shape',
      sql`${t.status} <> 'approved' or (${t.accountId} is not null and ${t.decidedBy} is not null and ${t.decidedAt} is not null)`,
    ),
    check(
      'invitations_rejected_shape',
      sql`${t.status} <> 'rejected' or (${t.decidedBy} is not null and ${t.decidedAt} is not null)`,
    ),
    // 5 là OTP_MAX_ATTEMPTS, OTP_MAX_SENDS (`domain/otp.ts`).
    check(
      'invitations_otp_counters_range',
      sql`${t.otpAttempts} between 0 and 5 and ${t.otpSendCount} between 0 and 5`,
    ),
    check(
      'invitations_decided_clean',
      sql`${t.status} not in ('approved', 'rejected') or (${t.passwordHash} is null and ${t.otpHash} is null and ${t.totpSecretEnc} is null and cardinality(${t.recoveryCodeHashes}) = 0)`,
    ),
    check('invitations_totp_confirmed_has_secret', sql`${t.totpConfirmedAt} is null or ${t.totpSecretEnc} is not null`),
  ],
);
