import { bigint, index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Mọi bảng của module `audit` khai báo trong schema này.
export const auditSchema = pgSchema('core');

export const auditAction = auditSchema.enum('audit_action', ['create', 'update', 'delete']);

/**
 * Nhật ký thao tác, chỉ thêm, không sửa. `company_id` trống là nhật ký cấp nền tảng
 * hoặc cấp tài khoản (docs/19 D4; Documents/21 V12).
 */
export const auditLogs = auditSchema.table(
  'audit_logs',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    companyId: uuid('company_id'),
    actorId: uuid('actor_id'),
    action: auditAction('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    /** Tên đối tượng lúc ghi (#352); trống ở dòng ghi trước đó. */
    entityLabel: text('entity_label'),
    /** Mã thao tác cụ thể (`lock`, `change_roles`, `approve_send`…); trống khi chỉ là thêm/sửa/xoá thường. */
    operation: text('operation'),
    before: jsonb('before'),
    after: jsonb('after'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.companyId, t.createdAt)],
);
