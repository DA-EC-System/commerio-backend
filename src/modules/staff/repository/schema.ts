import { boolean, index, pgSchema, text, unique, uuid } from 'drizzle-orm/pg-core';
import { timestamps, version } from '../../../shared/db/columns.ts';

// Mọi bảng của module `staff` khai báo trong schema này.
export const staffSchema = pgSchema('staff');

export const membershipStatus = staffSchema.enum('membership_status', ['active', 'suspended']);

/**
 * Tài khoản đăng nhập, dùng chung mọi công ty nên không có RLS (docs/19 D3, D25).
 * Email lưu chữ thường; mật khẩu băm argon2id.
 */
export const accounts = staffSchema.table('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash'),
  mustChangePassword: boolean('must_change_password').notNull().default(false),
  googleSub: text('google_sub').unique(),
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  ...timestamps,
  ...version,
});

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
