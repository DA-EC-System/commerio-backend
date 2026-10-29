import { sql } from 'drizzle-orm';
import { type AnyPgColumn, boolean, check, customType, integer, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** `created_at`, `updated_at` cho bảng sửa được. Bảng chỉ thêm (nhật ký, outbox) chỉ dùng `createdAt`. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

/** Khoá lạc quan (Documents/21 C3): mỗi lần sửa tăng 1, gửi sai thì 409 `version_conflict`. */
export const version = { version: integer('version').notNull().default(1) };

/** Cột tiền: `numeric(18,2)` (về Node là chuỗi, tính bằng `decimal.js`). */
export const money = (name: string) => numeric(name, { precision: 18, scale: 2 });

/**
 * Người lập và người duyệt của chứng từ có bước duyệt (Documents/19 mục 2, 25 §11). `self_approved` chỉ bật khi người
 * làm là CEO hoặc công ty có một người dùng; đi kèm CHECK `approvalCheck`.
 */
export const approval = {
  createdBy: uuid('created_by'),
  approvedBy: uuid('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  selfApproved: boolean('self_approved').notNull().default(false),
};

/** Người duyệt khác người lập, trừ khi tự duyệt hợp lệ (đánh dấu `self_approved`). */
export function approvalCheck(table: string, t: { createdBy: AnyPgColumn; approvedBy: AnyPgColumn; selfApproved: AnyPgColumn }) {
  return check(
    `${table}_second_person`,
    sql`${t.approvedBy} is null or ${t.approvedBy} is distinct from ${t.createdBy} or ${t.selfApproved}`,
  );
}

/** Cột `bytea` (khoá cổng, token sàn đã mã hoá); drizzle-orm chưa có kiểu sẵn. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
