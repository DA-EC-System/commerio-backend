// API công khai của module `audit`: ghi và đọc nhật ký thao tác.
// Module khác chỉ được import từ file này.
import { getDb } from '../../../shared/db/client.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { auditLogs } from './repository/schema.ts';

export const auditModule: ModuleDefinition = { name: 'audit' };

export interface AuditEntry {
  /** Trống với thao tác cấp nền tảng hoặc cấp tài khoản (docs/19 D4, Documents/21 V12). */
  companyId: string | null;
  actorId: string | null;
  action: 'create' | 'update' | 'delete';
  /** Bảng của đối tượng, vd `platform.companies`. */
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
}

/** Ghi một dòng nhật ký trong transaction của bên gọi: thao tác lỗi thì nhật ký cũng không còn. */
export async function recordAudit(entry: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditLogs)
    .values({ ...entry, before: entry.before ?? null, after: entry.after ?? null });
}
