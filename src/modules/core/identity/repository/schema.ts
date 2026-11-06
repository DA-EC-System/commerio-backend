import { index, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

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
