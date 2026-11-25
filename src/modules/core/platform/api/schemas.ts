import { normalizeTaxCode, TAX_CODE_FORMAT_MESSAGE } from '../domain/tax-code.ts';
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

/** Loại dòng của nhật ký nền tảng (Documents/21 V18; `company.tax_code_released` thêm 20/11/2026, #459). */
export const PLATFORM_AUDIT_ACTIONS = [
  'company.registered',
  'company.locked',
  'company.unlocked',
  'company.tax_code_released',
] as const;

export const PlatformAuditQuery = z.object({
  ...paging,
  search,
  action: z.enum(PLATFORM_AUDIT_ACTIONS).optional(),
  from: vnDayParam('Từ ngày'),
  to: vnDayParam('Đến ngày', true),
});

/** Id sai dạng cũng là 404 như không có, nên không kiểm uuid ở đây. */
export const CompanyParams = z.object({ id: z.string() });

/** Biểu phí mẫu (Documents/21 §21.6): luật chi tiết của thân ở finance (lỗi theo ô 422), route chỉ nhận object JSON. */
export const FeeTemplateBody = z.record(z.string(), z.unknown(), 'Thân là một object').meta({ id: 'PlatformFeeTemplateRequest' });

const version = z.coerce.number('Thiếu version').int().min(1);
export const ReleaseTaxCodeBody = z.object({
  reason: z.string('Cần nhập lý do gỡ').trim().min(1, 'Cần nhập lý do gỡ').max(500, 'Tối đa 500 ký tự'),
  version,
});

export const LockCompanyBody = z.object({
  reason: z.string('Cần nhập lý do khoá').trim().min(1, 'Cần nhập lý do khoá').max(500, 'Tối đa 500 ký tự'),
  version,
});
export const UnlockCompanyBody = z.object({ version });

export const Company = z
  .object({
    id: z.uuid(),
    name: z.string(),
    taxCode: z.string().nullable().meta({ description: 'null: chưa có mã số thuế (bị gỡ hoặc mã cũ không hợp lệ)' }),
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
    action: z.enum(PLATFORM_AUDIT_ACTIONS),
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

export const DeadJobListQuery = z.object({
  queue: z.string().trim().max(100, 'Tối đa 100 ký tự').optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// `id` sai định dạng trả 404 ở service (như việc không tồn tại), nên ở đây chỉ là chuỗi.
export const DeadJobParams = z.object({ id: z.string() });

// Schema trả về, chỉ dùng cho Swagger.
export const DeadJobSchema = z
  .object({
    id: z.uuid(),
    queue: z.string().meta({ description: 'Hàng gốc, vd `channel.listing_sync`; FE tự giữ nhãn tiếng Việt' }),
    shopId: z.uuid().nullable(),
    attempts: z.number().int().meta({ description: 'Số lần đã thử, kể cả lần đầu' }),
    lastError: z.string(),
    failedAt: z.string().meta({ description: 'Lúc rơi vào hàng việc lỗi' }),
  })
  .meta({ id: 'DeadJob' });

export const DeadJobPage = z
  .object({
    items: z.array(DeadJobSchema),
    total: z.number().int(),
    page: z.number().int(),
    pageSize: z.number().int(),
  })
  .meta({ id: 'DeadJobPage' });

// Hồ sơ công ty (#292, Documents/21 mục 4). `null` = theo tên, địa chỉ đăng ký của công ty.
const profileText = z.string().trim().min(1, 'Không để trống, xoá thì gửi null').max(500, 'Tối đa 500 ký tự').nullable();
export const UpdateCompanyProfileBody = z.object({
  // Chỉ nhập được khi công ty đang không có mã số thuế (#459); dạng chuẩn như lúc đăng ký
  taxCode: z
    .string()
    .max(40, TAX_CODE_FORMAT_MESSAGE)
    .transform((value, c) => {
      const normalized = normalizeTaxCode(value);
      if (normalized) return normalized;
      c.addIssue({ code: 'custom', message: TAX_CODE_FORMAT_MESSAGE });
      return z.NEVER;
    })
    .optional(),
  address: profileText.optional(),
  responsibleName: profileText.optional(),
  responsibleAddress: profileText.optional(),
  version,
});

export const CompanyProfile = z
  .object({
    id: z.uuid(),
    name: z.string(),
    taxCode: z.string().nullable().meta({ description: 'null: chưa có mã số thuế' }),
    address: z.string().nullable().meta({ description: 'Địa chỉ đăng ký' }),
    responsibleName: z.string().nullable().meta({ description: 'Tên tổ chức chịu trách nhiệm hàng hoá; null = tên công ty' }),
    responsibleAddress: z.string().nullable().meta({ description: 'Địa chỉ tổ chức chịu trách nhiệm; null = `address`' }),
    effectiveResponsible: z
      .object({ name: z.string(), address: z.string().nullable() })
      .meta({ description: 'Giá trị điền lên attribute sàn tương ứng (theo ánh xạ)' }),
    version: z.number().int(),
  })
  .meta({ id: 'CompanyProfile' });
