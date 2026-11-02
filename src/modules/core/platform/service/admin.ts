// Quản trị nền tảng: xem, khoá, mở khoá công ty và nhật ký cấp nền tảng (UC-PI-08, Documents/21 V18, #152).
// Chạy ngoài `withCompany` (role chủ bảng): `commerio_app` không được sửa `core.companies` (0002).
import { inTransaction } from '../../../../shared/db/client.ts';
import { AppError } from '../../../../shared/errors/app-error.ts';
import { isUuid } from '../../../../shared/uuid.ts';
import { recordAudit } from '../../audit/index.ts';
import { OPTIONAL_MODULES } from '../domain/modules.ts';
import {
  type CompanyAdminRow,
  companyCounts,
  findCompanyAdmin,
  listCompaniesAdmin,
  listPlatformAudit,
  moduleUsage,
  type PlatformAuditAction,
  type PlatformAuditRow,
  setCompanyStatus,
} from '../repository/admin.ts';

interface Paging {
  page: number;
  pageSize: number;
}
const pageWindow = (p: Paging) => ({ limit: p.pageSize, offset: (p.page - 1) * p.pageSize });

function toCompany(r: CompanyAdminRow) {
  return {
    id: r.id,
    name: r.name,
    taxCode: r.tax_code,
    ceoName: r.ceo_name ?? '',
    ceoEmail: r.ceo_email ?? '',
    optionalModules: r.optional_modules,
    status: r.status,
    lockReason: r.lock_reason,
    lockedAt: r.locked_at ? new Date(r.locked_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
    version: r.version,
  };
}

const actionOf = (r: PlatformAuditRow): PlatformAuditAction =>
  r.action === 'create' ? 'company.registered' : r.after?.status === 'locked' ? 'company.locked' : 'company.unlocked';

function toAuditLog(r: PlatformAuditRow) {
  const action = actionOf(r);
  const reason = action === 'company.locked' && typeof r.after?.lockReason === 'string' ? r.after.lockReason : undefined;
  return {
    id: r.id,
    action,
    targetCompanyId: r.company_id,
    targetCompanyName: r.company_name,
    actorEmail: r.actor_email ?? '',
    ...(reason !== undefined && { reason }),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function listCompanies(q: Paging & { search?: string | undefined; status?: 'active' | 'locked' | undefined }) {
  const { rows, total } = await listCompaniesAdmin(q, pageWindow(q));
  return { items: rows.map(toCompany), total, page: q.page, pageSize: q.pageSize };
}

/**
 * Khoá (`reason`) hay mở khoá (`reason` null) theo `version`. Không trúng dòng: công ty không có → 404; lệch version
 * hoặc đã ở trạng thái đích → 409 `version_conflict` kèm `current`. Thành viên bị chặn ngay vì `authorize` đọc trạng
 * thái công ty mỗi request.
 */
export function setCompanyLock(actorId: string, companyId: string, input: { version: number; reason: string | null }) {
  const status = input.reason === null ? 'active' : 'locked';
  if (!isUuid(companyId)) throw new AppError(404, 'not_found', 'Không tìm thấy công ty');
  return inTransaction(async () => {
    if (!(await setCompanyStatus(companyId, input.version, { status, lockReason: input.reason }))) {
      const current = await findCompanyAdmin(companyId);
      if (!current) throw new AppError(404, 'not_found', 'Không tìm thấy công ty');
      throw new AppError(409, 'version_conflict', `${current.name} vừa được đổi ở một phiên khác`, {
        current: toCompany(current),
      });
    }
    await recordAudit({
      companyId: null,
      actorId,
      action: 'update',
      entityType: 'core.companies',
      entityId: companyId,
      before: { status: status === 'locked' ? 'active' : 'locked' },
      after: { status, lockReason: input.reason },
    });
    return toCompany((await findCompanyAdmin(companyId))!);
  });
}

export async function listPlatformAuditLogs(
  q: Paging & { action?: PlatformAuditAction | undefined; search?: string | undefined; from?: Date | undefined; to?: Date | undefined },
) {
  const { rows, total } = await listPlatformAudit(q, pageWindow(q));
  return { items: rows.map(toAuditLog), total, page: q.page, pageSize: q.pageSize };
}

export async function platformOverview() {
  const [counts, usage, recent] = await Promise.all([
    companyCounts(),
    moduleUsage(),
    listPlatformAudit({}, { limit: 5, offset: 0 }),
  ]);
  return {
    totalCompanies: counts.total,
    activeCompanies: counts.active,
    lockedCompanies: counts.locked,
    registeredLast30Days: counts.recent,
    optionalModuleUsage: OPTIONAL_MODULES.map((module) => ({ module, companies: usage.get(module) ?? 0 })),
    recentActivities: recent.rows.map(toAuditLog),
  };
}
