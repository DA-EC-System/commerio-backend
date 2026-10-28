import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Mọi bảng của module `identity` khai báo trong schema này.
// Không đặt tên `auth`: Supabase đã có sẵn schema `auth` cho hệ thống đăng nhập của nó.
export const identitySchema = pgSchema('identity');

/**
 * Refresh token, chỉ lưu bản băm SHA-256. Thuộc tài khoản chứ không thuộc công ty,
 * nên không có RLS; `company_id` là công ty đang chọn của phiên (để trống khi chưa chọn).
 */
export const refreshTokens = identitySchema.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id').notNull(),
    companyId: uuid('company_id'),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.accountId)],
);
