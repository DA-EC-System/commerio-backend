// Nhật ký thao tác của công ty đang chọn, chỉ đọc (UC-PI-07, Documents/21 M1, M5, #152).
import { withCompany } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import type { ModuleContext } from '../../../../shared/module.ts';
import { type AuditLogFilter, type AuditLogRow, findAuditLog, listAuditLogs } from '../repository/logs.ts';

/** `staff` import `audit` nên không import ngược được: `core/index.ts` tiêm hàm đọc họ tên, email. */
export interface AuditContext extends ModuleContext {
  readonly accountSummaries?: (ids: readonly string[]) => Promise<{ id: string; email: string; fullName: string }[]>;
}

/** Tên dễ đọc của đối tượng lúc ghi: trường đầu tiên có trong `after` (hoặc `before` khi xoá). */
function entityLabel(row: AuditLogRow): string {
  const data = (row.after ?? row.before) as Record<string, unknown> | null;
  const label = ['name', 'fullName', 'email', 'module'].map((k) => data?.[k]).find((v) => typeof v === 'string');
  return (label as string | undefined) ?? row.entityType;
}

async function toViews(ctx: AuditContext, rows: readonly AuditLogRow[]) {
  const accounts = new Map(
    (await ctx.accountSummaries!(rows.flatMap((r) => (r.actorId ? [r.actorId] : [])))).map((a) => [a.id, a]),
  );
  return rows.map((r) => {
    const a = r.actorId ? accounts.get(r.actorId) : undefined;
    return {
      id: String(r.id),
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      entityLabel: entityLabel(r),
      actor: {
        accountId: r.actorId ?? '',
        email: a?.email ?? '',
        fullName: a?.fullName ?? (r.actorId ? 'Tài khoản đã xoá' : 'Hệ thống'),
      },
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export function listCompanyAuditLogs(
  ctx: AuditContext,
  companyId: string,
  q: AuditLogFilter & { page: number; pageSize: number },
) {
  return withCompany(companyId, async () => {
    const { rows, total } = await listAuditLogs(q, { limit: q.pageSize, offset: (q.page - 1) * q.pageSize });
    return { items: await toViews(ctx, rows), total, page: q.page, pageSize: q.pageSize };
  });
}

/** Dòng của công ty khác (RLS ẩn) hay id không phải số: 404 như không có (C4). */
export function getCompanyAuditLog(ctx: AuditContext, companyId: string, id: string) {
  return withCompany(companyId, async () => {
    const row = /^\d{1,15}$/.test(id) ? await findAuditLog(Number(id)) : undefined;
    if (!row) throw new AppError(404, 'not_found', 'Không tìm thấy dòng nhật ký');
    return { ...(await toViews(ctx, [row]))[0]!, before: row.before ?? null, after: row.after ?? null };
  });
}
