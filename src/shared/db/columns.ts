import { integer, numeric, timestamp } from 'drizzle-orm/pg-core';

/** `created_at`, `updated_at` cho bảng sửa được. Bảng chỉ thêm (nhật ký, outbox) chỉ dùng `createdAt`. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Khoá lạc quan (Documents/21 C3): mỗi lần sửa tăng 1, gửi sai thì 409 `version_conflict`. */
export const version = { version: integer('version').notNull().default(1) };

/** Cột tiền: `numeric(18,2)` (về Node là chuỗi, tính bằng `decimal.js`). */
export const money = (name: string) => numeric(name, { precision: 18, scale: 2 });
