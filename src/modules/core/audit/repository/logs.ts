import { and, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import { getDb } from '../../../../shared/db/client.ts';
import { auditLogs } from './schema.ts';

export type AuditLogRow = typeof auditLogs.$inferSelect;

export interface AuditLogFilter {
  actorId?: string | undefined;
  entityType?: string | undefined;
  action?: AuditLogRow['action'] | undefined;
  from?: Date | undefined;
  /** Cận trên không lấy (đầu ngày hôm sau). */
  to?: Date | undefined;
}

const where = (f: AuditLogFilter): SQL | undefined =>
  and(
    f.actorId ? eq(auditLogs.actorId, f.actorId) : undefined,
    f.entityType ? eq(auditLogs.entityType, f.entityType) : undefined,
    f.action ? eq(auditLogs.action, f.action) : undefined,
    f.from ? gte(auditLogs.createdAt, f.from) : undefined,
    f.to ? lt(auditLogs.createdAt, f.to) : undefined,
  );

/** Trang nhật ký, mới nhất trước. Chạy trong `withCompany`: RLS chỉ cho thấy dòng của công ty đang chọn. */
export async function listAuditLogs(f: AuditLogFilter, page: { limit: number; offset: number }) {
  const [rows, [total]] = await Promise.all([
    getDb().select().from(auditLogs).where(where(f)).orderBy(desc(auditLogs.id)).limit(page.limit).offset(page.offset),
    getDb().select({ n: count() }).from(auditLogs).where(where(f)),
  ]);
  return { rows, total: total!.n };
}

export async function findAuditLog(id: number): Promise<AuditLogRow | undefined> {
  const [row] = await getDb().select().from(auditLogs).where(eq(auditLogs.id, id));
  return row;
}
