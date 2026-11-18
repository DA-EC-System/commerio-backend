// API công khai của module `audit`: ghi và đọc nhật ký thao tác.
// Module khác chỉ được import từ file này.
import { getDb } from '../../../shared/db/client.ts';
import type { ModuleDefinition } from '../../../shared/module.ts';
import { registerAuditOpenApi } from './api/openapi.ts';
import { auditRouter } from './api/routes.ts';
import { auditLogs } from './repository/schema.ts';

export const auditModule: ModuleDefinition = { name: 'audit', router: auditRouter, openapi: registerAuditOpenApi };

export interface AuditEntry {
  /** Trống với thao tác cấp nền tảng hoặc cấp tài khoản (docs/19 D4, Documents/21 V12). */
  companyId: string | null;
  actorId: string | null;
  action: 'create' | 'update' | 'delete';
  /** Bảng của đối tượng, vd `core.companies`. */
  entityType: string;
  entityId: string | null;
  /** Tên người đọc được của đối tượng lúc ghi: "Họ tên (email)", số chứng từ, tên gian hàng… (#352). */
  label: string;
  /** Mã thao tác cụ thể khi `action` chưa nói đủ: `lock`, `change_roles`, mã thao tác máy trạng thái… FE dịch ra chữ. */
  operation?: string;
  before?: unknown;
  after?: unknown;
}

/** Ghi một dòng nhật ký trong transaction của bên gọi: thao tác lỗi thì nhật ký cũng không còn. */
export async function recordAudit({ label, ...entry }: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditLogs)
    .values({ ...entry, entityLabel: label, before: entry.before ?? null, after: entry.after ?? null });
}
