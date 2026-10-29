import { z } from 'zod';
import { vnDayParam } from '../../../../shared/http/vn-day.ts';
import { OPTIONAL_MODULES } from '../domain/modules.ts';

export const ActorRef = z
  .object({ accountId: z.uuid(), email: z.string(), fullName: z.string() })
  .meta({ id: 'ActorRef' });

export const CompanyModule = z
  .object({
    code: z.enum(OPTIONAL_MODULES),
    enabled: z.boolean(),
    enabledAt: z.iso.datetime().nullable(),
    enabledBy: ActorRef.nullable(),
    aiConsentAt: z.iso.datetime().nullable(),
    aiConsentBy: ActorRef.nullable(),
    hasData: z.boolean(),
  })
  .meta({ id: 'CompanyModule' });

export const ModuleParams = z.object({ code: z.string() });

export const SetModuleBody = z.object({
  enabled: z.boolean('Chọn bật hoặc tắt'),
  aiConsent: z.boolean().optional(),
});

export const SetModuleResult = z
  .object({ module: CompanyModule, enabledModules: z.array(z.string()) })
  .meta({ id: 'SetModuleResult' });

// Quản trị nền tảng (UC-PI-08, Documents/21 V18).
const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};
const search = z.string().trim().max(100).optional();

export const CompanyListQuery = z.object({ ...paging, search, status: z.enum(['active', 'locked']).optional() });

export const PlatformAuditQuery = z.object({
  ...paging,
  search,
  action: z.enum(['company.registered', 'company.locked', 'company.unlocked']).optional(),
  from: vnDayParam('Từ ngày'),
  to: vnDayParam('Đến ngày', true),
});

/** Id sai dạng cũng là 404 như không có, nên không kiểm uuid ở đây. */
export const CompanyParams = z.object({ id: z.string() });

const version = z.coerce.number('Thiếu version').int().min(1);
export const LockCompanyBody = z.object({
  reason: z.string('Cần nhập lý do khoá').trim().min(1, 'Cần nhập lý do khoá').max(500, 'Tối đa 500 ký tự'),
  version,
});
export const UnlockCompanyBody = z.object({ version });

export const Company = z
  .object({
    id: z.uuid(),
    name: z.string(),
    taxCode: z.string(),
    ceoName: z.string(),
    ceoEmail: z.string(),
    optionalModules: z.array(z.enum(OPTIONAL_MODULES)),
    status: z.enum(['active', 'locked']),
    lockReason: z.string().nullable(),
    lockedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    version: z.number().int(),
  })
  .meta({ id: 'Company' });

export const CompanyPage = z
  .object({ items: z.array(Company), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'CompanyPage' });

export const PlatformAuditLog = z
  .object({
    id: z.string(),
    action: z.enum(['company.registered', 'company.locked', 'company.unlocked']),
    targetCompanyId: z.uuid(),
    targetCompanyName: z.string(),
    actorEmail: z.string(),
    reason: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'PlatformAuditLog' });

export const PlatformAuditPage = z
  .object({ items: z.array(PlatformAuditLog), total: z.number().int(), page: z.number().int(), pageSize: z.number().int() })
  .meta({ id: 'PlatformAuditPage' });

export const PlatformOverview = z
  .object({
    totalCompanies: z.number().int(),
    activeCompanies: z.number().int(),
    lockedCompanies: z.number().int(),
    registeredLast30Days: z.number().int(),
    optionalModuleUsage: z.array(z.object({ module: z.enum(OPTIONAL_MODULES), companies: z.number().int() })),
    recentActivities: z.array(PlatformAuditLog),
  })
  .meta({ id: 'PlatformOverview' });
